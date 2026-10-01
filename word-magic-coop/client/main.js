// 클라이언트: 로비 → 접속 → 입력 전송 → 스냅숏 보간 → 렌더링·HUD.
// 게스트/호스트 모두 요청만 보내고, 결과는 호스트의 스냅숏과 이벤트로 반영한다.
import { Renderer } from './render.js';
import { cameraRig, CAM } from './camera.js';
import { FONT_STACK } from './labels.js';
import { LEVEL, SEAT_IDS, bodyDefs } from '../shared/level.js';
import { TUNING, modFactor } from '../shared/tuning.js';
import { WORDS, KIND, MOD_IDS, MODE_ORDER, MODE_LABEL, spellLabel } from '../shared/words.js';
import { resolveTargets, modeUnsupported, REASON, liftShare } from '../shared/targeting.js';
import { segmentBlocked } from '../shared/geom.js';
import { HostSession } from './host.js';
import { Sfx } from './sfx.js';
import { Inventory, HOTBAR, MAIN, WORD_DESC } from './inventory.js';
import { hostRoom, joinRoom, CODE_RE } from './p2p.js';

const $ = (id) => document.getElementById(id);
const NAMES = { ...Object.fromEntries(SEAT_IDS.map((id) => [id, id])), rock: '돌', box1: '상자', box2: '무거운 상자', dummy: '허수아비', cargo: '짐' };
const BODY_DEF = new Map(bodyDefs().map((d) => [d.id, d]));
const SEAT_COLOR = Object.fromEntries(LEVEL.seats.map((s) => [s.id, s.color]));
const SENS = 0.0025;
const END_CAST_KEY = '우클릭'; // 시전 종료 키 [임시] — 키 배정은 추후 결정

const S = {
  conn: null, // 호스트 연결: WebSocket 래퍼, P2P 연결, 또는 이 탭의 HostSession
  room: null, // 방장일 때 P2P 방(방 코드 대기)
  solo: false,
  views: {}, // 혼자 해보기에서 캐릭터별 카메라 방향
  me: null,
  phase: 'lobby', // lobby | connecting | waiting | playing
  snaps: [],
  latest: null,
  latestAt: 0,
  offset: null,
  round: 0,
  yaw: 0,
  pitch: -0.08,
  locked: false,
  editorOpen: false,
  keys: new Set(),
  lastWish: '',
  lastInputAt: 0,
  preview: null,
  frame: null,
  closingOnPurpose: false,
  editorKey: '',
  mode: 'AIM', // 대상 모드(F로 전환): 조준 대상 → 본인 → 주변
  holding: false, // 내가 유지 중인 지속형 마법(<들기>)이 있음 — 시전 종료로 끝낸다
  did: { cast: false, mode: false, pickup: false, attach: false, share: false }, // '처음 해보기' 안내 진행
  stats: null, // 판 요약(플레이테스트 관찰용)
  invs: {}, // 자리별 가방(마인크래프트식 칸 배치)
  hover: null, // 가방 창에서 마우스가 올라간 칸
  bagKey: '',
  guideOff: false,
  lastAim: '',
  projectiles: [],
  recent: [],
  renderTime: 0,
};

let renderer;

// ------------------------------------------------------------------ 로비·연결
function setLobby(status, note = null) {
  $('lobby').hidden = false;
  $('hud').hidden = true;
  $('editor').hidden = true;
  S.editorOpen = false;
  if (document.pointerLockElement) document.exitPointerLock();
  $('lobby-status').textContent = status;
  $('lobby-note').hidden = !note;
  if (note) $('lobby-note').textContent = note;
}

// 실행 환경: 호스트 서버(기본) · 'web'(정적 호스팅, P2P 방) · 'solo'(서버 없는 링크, 혼자 해보기만)
const MODE = window.WM_MODE || 'server';

function setJoinDisabled(v) {
  for (const id of ['join-btn', 'solo-btn', 'create-btn', 'join-code-btn']) $(id).disabled = v;
}

function connect() {
  if (S.conn) return;
  S.phase = 'connecting';
  setJoinDisabled(true);
  setLobby('호스트에 접속하는 중…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  S.conn = {
    send: (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    close: () => ws.close(),
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    const was = S.phase;
    console.log(`[net] 연결 종료 code=${e.code} reason=${e.reason || '-'} phase=${was}`);
    S.conn = null;
    S.me = null;
    S.phase = 'lobby';
    setJoinDisabled(false);
    updateSeats({ A: false, B: false });
    if (S.closingOnPurpose) { S.closingOnPurpose = false; return; }
    if (was === 'full') return;
    setLobby('호스트와 연결이 끊겼어요.', '호스트 프로그램이 실행 중인지 확인하고 다시 참가하세요.');
  };
}

// 혼자 해보기: 판정 코드를 이 브라우저에서 돌리고 A·B를 Q로 번갈아 조작한다.
function startSolo() {
  if (S.conn) return;
  S.solo = true;
  setJoinDisabled(true);
  S.conn = new HostSession(onMessage, { solo: true });
}

// 방 만들기(P2P): 이 탭이 호스트가 되고, 친구는 방 코드나 링크로 들어온다.
function createRoom() {
  if (S.conn) return;
  setJoinDisabled(true);
  setLobby('방을 여는 중…');
  const session = new HostSession(onMessage);
  S.conn = session;
  try {
    S.room = hostRoom(session, {
      onReady: ({ code }) => {
        const link = `${location.origin}${location.pathname}${location.search}#${code}`;
        $('room-code').textContent = code;
        $('room-link').textContent = link;
        $('room-info').hidden = false;
        // 방을 연 뒤에는 다른 선택지를 숨겨 헷갈리지 않게 한다.
        document.querySelector('.lobby-actions').hidden = true;
        $('join-form').hidden = true;
        if (S.phase !== 'playing') setLobby('방을 만들었어요. 친구가 들어오면 바로 시작해요.');
      },
      onError: (msg) => {
        leaveRoom();
        setLobby('방을 만들지 못했어요.', msg);
      },
    });
  } catch (e) {
    leaveRoom();
    setLobby('방을 만들지 못했어요.', e.message);
  }
}

function joinByCode(raw) {
  const code = String(raw || '').trim().toLowerCase();
  if (!CODE_RE.test(code)) {
    setLobby('방 코드를 확인하세요.', '방 코드는 영문 소문자와 숫자 6자리예요.');
    return;
  }
  if (S.conn) return;
  setJoinDisabled(true);
  S.phase = 'connecting';
  setLobby(`방 ${code}에 들어가는 중…`);
  try {
    S.conn = joinRoom(code, onMessage, {
      onFail: (msg) => {
        S.conn = null;
        S.phase = 'lobby';
        setJoinDisabled(false);
        setLobby('방에 들어가지 못했어요.', msg);
      },
      onClose: () => {
        const was = S.phase;
        S.conn = null;
        S.me = null;
        S.phase = 'lobby';
        setJoinDisabled(false);
        updateSeats({ A: false, B: false });
        if (was === 'full') return;
        setLobby('방장과 연결이 끊겼어요.', '방장이 방을 닫았거나 네트워크가 끊겼어요. 같은 링크로 다시 들어올 수 있어요.');
      },
    });
  } catch (e) {
    S.conn = null;
    setJoinDisabled(false);
    setLobby('방에 들어가지 못했어요.', e.message);
  }
}

function leaveRoom() {
  S.room?.close();
  S.room = null;
  S.conn?.close();
  S.conn = null;
  S.phase = 'lobby';
  $('room-info').hidden = true;
  document.querySelector('.lobby-actions').hidden = false;
  if (MODE === 'web') $('join-form').hidden = false;
  setJoinDisabled(false);
}

function send(msg) {
  S.conn?.send(msg);
}

function updateWho() {
  $('who-chip').style.background = SEAT_COLOR[S.me];
  const other = S.me === 'A' ? 'B' : 'A';
  $('who-name').textContent = S.solo ? `플레이어 ${S.me} 조작 중 · C로 ${other} 전환` : `플레이어 ${S.me} (나)`;
  $('keys').textContent = `WASD 이동 · Space 점프 · 좌클릭 시전 · ${END_CAST_KEY} 시전 종료 · F 대상 모드 · 1~9 단어 고르기 · Q 던지기 · E 가방 · R 해제 · M 소리${S.solo ? ' · C 캐릭터 전환' : ''}`;
}

function switchCharacter() {
  if (!S.solo || S.phase !== 'playing') return;
  S.views[S.me] = { yaw: S.yaw, pitch: S.pitch };
  const next = S.me === 'A' ? 'B' : 'A';
  S.conn.switchTo(next);
  S.me = next;
  const v = S.views[next] || { yaw: 0, pitch: -0.08 };
  S.yaw = v.yaw;
  S.pitch = v.pitch;
  S.lastWish = '';
  updateWho();
  log(`이제 플레이어 ${next}를 조작해요`);
}

// 로비의 자리 표시(A~F)
function buildSeats() {
  const box = document.querySelector('.seats');
  box.innerHTML = '';
  for (const id of SEAT_IDS) {
    const el = document.createElement('div');
    el.className = 'seat';
    el.dataset.seat = id;
    el.innerHTML = `<span class="dot"></span>${id}`;
    el.querySelector('.dot').style.setProperty('--seat', SEAT_COLOR[id]);
    box.append(el);
  }
}

function updateSeats(seats) {
  for (const el of document.querySelectorAll('.seat')) {
    const id = el.dataset.seat;
    el.classList.toggle('on', !!seats[id]);
    el.classList.toggle('me', S.me === id);
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome': {
      S.me = m.you;
      S.phase = 'waiting';
      if (m.solo) break;
      if (m.p2p) {
        if (m.you !== 'A') setLobby(`플레이어 ${m.you}(으)로 방에 들어왔어요. 곧 시작해요…`);
        break;
      }
      setLobby(`플레이어 ${m.you}(으)로 참가했어요. 상대를 기다리는 중…`);
      const port = m.port;
      const lines = [];
      for (const a of m.addresses || []) lines.push(`같은 네트워크의 친구: <code>http://${a}:${port}</code>`);
      lines.push(`같은 PC에서 두 번째 창: <code>http://localhost:${port}</code>`);
      $('lobby-address').innerHTML = lines.join('<br>');
      $('lobby-address').hidden = false;
      break;
    }
    case 'full':
      S.phase = 'full';
      setLobby('자리가 가득 찼어요.', '한 방에는 최대 6명까지 들어올 수 있어요.');
      break;
    case 'lobby':
      updateSeats(m.seats);
      break;
    case 'start':
      if (m.you) S.me = m.you;
      startPlaying();
      break;
    case 'peerLeft':
      S.phase = 'waiting';
      S.snaps = [];
      S.latest = null;
      setLobby('상대를 기다리는 중…', `플레이어 ${m.who}의 연결이 끊겨 로비로 돌아왔어요. 새 상대가 접속하면 처음부터 시작해요.`);
      break;
    case 's':
      onSnapshot(m);
      break;
    case 'ev':
      onEvent(m);
      break;
  }
}

function startPlaying() {
  S.phase = 'playing';
  S.stats = newStats();
  S.snaps = [];
  S.latest = null;
  S.offset = null;
  S.yaw = 0;
  S.pitch = -0.08;
  $('lobby').hidden = true;
  $('hud').hidden = false;
  $('log').innerHTML = '';
  S.views = {};
  updateWho();
  log(S.solo
    ? '혼자 해보기: Q로 A와 B를 번갈아 조작해요. 같은 주문을 친구·돌·상자에 써 보세요.'
    : '게임이 시작됐어요! 같은 주문을 친구·돌·상자에 써 보세요.');
}

// ------------------------------------------------------------------ 스냅숏 보간
function onSnapshot(s) {
  const now = performance.now() / 1000;
  const sample = now - s.time;
  if (S.offset === null || s.round !== S.round) {
    S.offset = sample;
    S.snaps = [];
    S.round = s.round;
  } else {
    S.offset = Math.min(sample, S.offset + 0.002);
  }
  S.snaps.push(s);
  while (S.snaps.length > 2 && S.snaps[1].time < s.time - 1) S.snaps.shift();
  S.latest = s;
  S.latestAt = now;
}

const lerp = (a, b, k) => a + (b - a) * k;
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function interpolated() {
  const out = new Map();
  if (!S.snaps.length) return out;
  const rt = performance.now() / 1000 - S.offset - TUNING.interpDelay;
  let a = S.snaps[0];
  let b = S.snaps[0];
  for (let i = 0; i < S.snaps.length; i++) {
    if (S.snaps[i].time <= rt) a = S.snaps[i];
    if (S.snaps[i].time >= rt) { b = S.snaps[i]; break; }
    b = S.snaps[i];
  }
  const k = b.time > a.time ? Math.min(1, Math.max(0, (rt - a.time) / (b.time - a.time))) : 1;
  // 실제로 화면에 그리는 상태의 호스트 시점(스냅숏이 늦으면 시계보다 과거). 조준 판정에 함께 보낸다.
  S.renderTime = b.time > a.time ? a.time + (b.time - a.time) * k : b.time;
  const bmap = new Map(b.b.map((x) => [x.id, x]));
  for (const x of a.b) {
    const y = bmap.get(x.id) || x;
    const jump = Math.hypot(y.p[0] - x.p[0], y.p[1] - x.p[1], y.p[2] - x.p[2]) > 2.5;
    const kk = jump ? 1 : k;
    const dtS = Math.max(1e-3, b.time - a.time);
    out.set(x.id, {
      p: [lerp(x.p[0], y.p[0], kk), lerp(x.p[1], y.p[1], kk), lerp(x.p[2], y.p[2], kk)],
      y: lerpAngle(x.y, y.y, kk),
      i: y.i,
      d: y.d,
      h: y.h,
      hv: y.hv,
      hp: y.hp,
      dn: y.dn,
      g: y.g,
      speed: jump ? 0 : Math.hypot(y.p[0] - x.p[0], y.p[2] - x.p[2]) / dtS,
    });
  }
  // 월드의 단어: 던져서 날아가는 것도 부드럽게(두 스냅숏 모두 땅에 있을 때 보간)
  const ak = new Map((a.k || []).map((x) => [x.id, x]));
  S.tokensView = (b.k || []).map((y) => {
    const x = ak.get(y.id);
    return x?.p && y.p ? { ...y, p: [lerp(x.p[0], y.p[0], k), lerp(x.p[1], y.p[1], k), lerp(x.p[2], y.p[2], k)] } : y;
  });
  // 투사체: 두 스냅숏 모두에 있으면 보간, 새로 생긴 것은 최신 위치
  const apr = new Map((a.pr || []).map((x) => [x.id, x]));
  S.projectiles = (b.pr || []).map((y) => {
    const x = apr.get(y.id);
    return x ? { ...y, p: [lerp(x.p[0], y.p[0], k), lerp(x.p[1], y.p[1], k), lerp(x.p[2], y.p[2], k)] } : y;
  });
  return out;
}

// ------------------------------------------------------------------ 이벤트·HUD 문구
function log(text) {
  const li = document.createElement('li');
  li.textContent = text;
  $('log').prepend(li);
  setTimeout(() => li.classList.add('old'), 6000);
  setTimeout(() => li.remove(), 6800);
  while ($('log').children.length > 6) $('log').lastChild.remove();
}

let toastTimer;
function toast(text, kind = 'bad') {
  $('toast').textContent = text;
  $('toast').className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').className = kind; }, 1600);
}

const who = (id) => (id === S.me ? '나' : `플레이어 ${id}`);
const whoSubj = (id) => (id === S.me ? '내가' : `플레이어 ${id}가`);
const wlabel = (w) => `<${WORDS[w].label}>`;
const nameOf = (id) => (id === S.me ? '나' : NAMES[id] || id);

const sfx = new Sfx();

// 효과음: 내 캐릭터에서 멀수록 작게
function playSfx(e) {
  const at = (id) => S.frame?.bodies.get(id)?.p;
  const k = (p) => {
    const me = at(S.me);
    if (!p || !me) return 1;
    return Math.max(0.15, Math.min(1, 1 - Math.hypot(p[0] - me[0], p[1] - me[1], p[2] - me[2]) / 30));
  };
  switch (e.k) {
    case 'cast': {
      const kk = k(at(e.by));
      if (e.effect === 'FIREBALL') { if (e.mode !== 'SELF') sfx.play('fire', kk); break; }
      sfx.play(e.effect === 'PULL' ? 'pull' : 'push', kk);
      if ((e.targets || []).some((id) => id !== e.by)) sfx.play('hit', kk);
      break;
    }
    case 'liftStart':
      sfx.play('liftStart', k(at(e.by)));
      if (e.by === S.me && e.heavy?.length) sfx.play('strain');
      break;
    case 'liftEnd': if (e.reason === 'released') sfx.play('liftEnd', k(at(e.target))); break;
    case 'boom': sfx.play('boom', k(e.pos)); break;
    case 'pickup': sfx.play(e.from ? 'give' : 'pickup', k(at(e.by))); break;
    case 'throw': sfx.play('throw', k(at(e.by))); break;
    case 'release': sfx.play('release', k(at(e.by))); break;
    case 'castFail': case 'pickupFail': sfx.play('fail'); break;
    case 'clear': sfx.play('clear'); break;
    default: break;
  }
}

// ------------------------------------------------------------------ 판 요약
// 플레이테스트에서 기억 대신 기록으로 본다(v0.2 08: 친구·사물에 고루 쓰는지, 교환하는지, 사고가 나는지).
function newStats() {
  return { start: performance.now(), per: {}, colift: 0, friendFire: 0, enemyHit: 0, release: 0, fall: 0, clearedAt: null };
}

function statOf(pid) {
  if (!S.stats) S.stats = newStats();
  if (!S.stats.per[pid]) S.stats.per[pid] = { casts: {}, friend: 0, object: 0, self: 0, pickup: 0, give: 0 };
  return S.stats.per[pid];
}

function countTargets(st, by, ids) {
  for (const id of ids || []) {
    if (id === by) st.self += 1;
    else if (SEAT_IDS.includes(id)) st.friend += 1;
    else st.object += 1;
  }
}

function recordStats(e) {
  if (!S.stats) S.stats = newStats();
  const T = S.stats;
  switch (e.k) {
    case 'cast': {
      const st = statOf(e.by);
      const key = `${WORDS[e.effect].label}${e.mode !== 'AIM' ? `(${MODE_LABEL[e.mode]})` : ''}`;
      st.casts[key] = (st.casts[key] || 0) + 1;
      countTargets(st, e.by, e.targets);
      break;
    }
    case 'liftStart': {
      const st = statOf(e.by);
      const key = `들기${e.mode && e.mode !== 'AIM' ? `(${MODE_LABEL[e.mode]})` : ''}`;
      st.casts[key] = (st.casts[key] || 0) + 1;
      countTargets(st, e.by, e.targets || [e.target]);
      T.colift += (e.joined || []).length;
      break;
    }
    case 'boom':
      for (const h of e.hits) {
        if (h.effects.includes('debuff')) T.friendFire += 1;
        if (h.effects.includes('damage')) T.enemyHit += 1;
        if (e.by && h.id !== e.by) countTargets(statOf(e.by), e.by, [h.id]);
      }
      break;
    case 'pickup':
      statOf(e.by).pickup += 1;
      if (e.from) statOf(e.from).give += 1; // 던진 단어를 친구가 주움 = 건네줌
      break;
    case 'release': T.release += 1; break;
    case 'recover': if (SEAT_IDS.includes(e.id)) T.fall += 1; break;
    case 'clear': if (!T.clearedAt) T.clearedAt = performance.now(); break;
    case 'restart': S.stats = newStats(); break;
    default: break;
  }
}

function summaryText() {
  const T = S.stats || newStats();
  const sec = Math.round(((T.clearedAt || performance.now()) - T.start) / 1000);
  const lines = [`${T.clearedAt ? '도착까지' : '지금까지'} ${Math.floor(sec / 60)}분 ${sec % 60}초`];
  for (const pid of SEAT_IDS) {
    const st = T.per[pid];
    if (!st) continue;
    const total = Object.values(st.casts).reduce((a, b) => a + b, 0);
    const kinds = Object.entries(st.casts).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`${pid}: 주문 ${total}번${kinds ? ` (${kinds})` : ''} · 친구에게 ${st.friend} · 물건·적에게 ${st.object} · 나에게 ${st.self} · 단어 줍기 ${st.pickup} · 건네준 단어 ${st.give}`);
  }
  lines.push(`같이 들기 ${T.colift}번 · 친구가 파이어볼에 맞음 ${T.friendFire}번 · 적 명중 ${T.enemyHit}번 · R로 풀기 ${T.release}번 · 떨어짐 ${T.fall}번`);
  return lines.join('\n');
}

function onEvent(e) {
  try { playSfx(e); } catch { /* 소리는 표시용: 실패해도 진행 */ }
  recordStats(e);
  S.recent.push(e);
  if (S.recent.length > 30) S.recent.shift();
  if ((e.k === 'cast' || e.k === 'liftStart') && e.by === S.me) S.did.cast = true;
  if (e.k === 'pickup' && e.by === S.me) S.did.pickup = true;
  if (e.k === 'pickup' && e.from && (e.by === S.me || e.from === S.me)) S.did.share = true;
  switch (e.k) {
    case 'cast': {
      const pos = new Map();
      for (const [id, v] of S.frame?.bodies || []) pos.set(id, v.p);
      renderer.castFx(e, pos);
      const spell = spellLabel(e.effect, e.mods);
      if (e.effect === 'FIREBALL') {
        const what = { AIM: '발사!', SELF: '발밑 폭발!', NEAR: '사방으로 발사!' }[e.mode] || '발사!';
        log(`${who(e.by)}: ${spell} ${what}`);
      } else if (e.effect === 'PULL' && e.anchor) {
        log(`${who(e.by)}: ${spell} → 지형 쪽으로 끌려감`);
      } else {
        log(`${who(e.by)}: ${spell} (${MODE_LABEL[e.mode]}) → ${e.targets.map(nameOf).join(', ')}`);
      }
      break;
    }
    case 'liftStart': {
      renderer.poke(e.by, 'cast');
      const ids = e.targets || [e.target];
      const joined = new Set(e.joined || []);
      log(`${who(e.by)}: ${spellLabel('LIFT', e.mods)} → ${ids.map((id) => (joined.has(id) ? `${nameOf(id)}(같이 들기)` : nameOf(id))).join(', ')}`);
      if (e.by === S.me && e.heavy?.length) toast(REASON.HEAVY_GRAB, 'info');
      break;
    }
    case 'liftEnd':
      if (e.by === S.me) S.holding = false;
      if (e.reason === 'word') log(`${whoSubj(e.by)} <들기> 단어가 없어져 ${nameOf(e.target)}을(를) 놓쳤어요`);

      if (e.reason === 'far') log(`${nameOf(e.target)}이(가) 너무 멀어져 놓쳤어요`);
      if (e.reason === 'released-by-target') log(`${nameOf(e.target)}이(가) R로 풀려났어요`);
      break;
    case 'boom': {
      renderer.boomFx(e);
      const parts = e.hits.map((h) => {
        if (h.effects.includes('damage')) return `${nameOf(h.id)} 피해 ${Math.round(e.damage)}`;
        if (h.effects.includes('debuff')) return `${nameOf(h.id)} 그을림(잠시 느려짐)`;
        return null;
      }).filter(Boolean);
      if (parts.length) log(`파이어볼 명중: ${parts.join(', ')}`);
      break;
    }
    case 'fizzle':
      renderer.fizzleFx(e.pos);
      break;
    case 'dummyDown':
      log('허수아비가 쓰러졌어요 (잠시 뒤 다시 일어나요)');
      break;
    case 'dummyUp':
      log('허수아비가 다시 일어났어요');
      break;
    case 'castFail':
      if (e.reason === REASON.SUSTAINING) { toast(`${e.reason} (${END_CAST_KEY})`); break; }
      if (e.by === S.me) S.holding = false; // 들기 시전이 거절되면 유지 상태도 푼다
      toast(e.reason);
      break;
    case 'pickup':
      if (e.from) {
        log(`${whoSubj(e.by)} ${who(e.from)}의 ${wlabel(e.word)}을(를) 받았어요`);
        if (e.by === S.me) toast(`${who(e.from)}에게서 ${wlabel(e.word)}을(를) 받았어요${e.equipped ? ' (바로 장착)' : ''}`, 'info');
      } else {
        log(`${whoSubj(e.by)} ${wlabel(e.word)} 단어를 주웠어요${e.equipped ? ' (바로 장착)' : ''}`);
      }
      break;
    case 'throw':
      log(`${whoSubj(e.by)} ${wlabel(e.word)}을(를) 던졌어요`);
      break;
    case 'pickupFail':
      toast(e.reason);
      break;
    case 'drop':
      log(`${whoSubj(e.by)} ${wlabel(e.word)} 단어를 내려놓았어요`);
      break;
    case 'release': {
      log(`${whoSubj(e.by)} 이동 효과를 풀었어요 (보호 ${TUNING.releaseImmunity}초)`);
      const b = S.frame?.bodies.get(e.by);
      if (b) renderer.releaseFx(b.p);
      break;
    }
    case 'recover':
      if (NAMES[e.id]) log(`${e.id === S.me ? '내' : NAMES[e.id]}${e.id === S.me ? '가' : e.id === 'cargo' ? '이' : '이(가)'} 떨어져서 안전한 곳으로 돌아왔어요`);
      break;
    case 'tokenRecover':
      log(`${wlabel(e.word)} 단어가 안전한 곳으로 돌아왔어요`);
      break;
    case 'clear':
      log('도착 성공! 짐과 모두가 함께 도착했어요');
      break;
    case 'join':
      if (e.id !== S.me) log(`플레이어 ${e.id}가 들어왔어요`);
      break;
    case 'leave':
      log(`플레이어 ${e.id}가 나갔어요${e.dropped?.length ? ' (가진 단어는 그 자리에 떨어졌어요)' : ''}`);
      break;
    case 'restart':
      S.snaps = [];
      S.offset = null;
      $('log').innerHTML = '';
      log(`${whoSubj(e.by)} 처음부터 다시 시작했어요`);
      break;
  }
}

// ------------------------------------------------------------------ 입력
function wishVector() {
  const f = [Math.sin(S.yaw), Math.cos(S.yaw)];
  const r = [-Math.cos(S.yaw), Math.sin(S.yaw)];
  let x = 0;
  let z = 0;
  if (S.keys.has('KeyW')) { x += f[0]; z += f[1]; }
  if (S.keys.has('KeyS')) { x -= f[0]; z -= f[1]; }
  if (S.keys.has('KeyD')) { x += r[0]; z += r[1]; }
  if (S.keys.has('KeyA')) { x -= r[0]; z -= r[1]; }
  const l = Math.hypot(x, z);
  return l > 0 ? [x / l, z / l] : [0, 0];
}

function sendInput(jump = false) {
  const wish = wishVector().map((v) => Math.round(v * 1000) / 1000);
  const msg = { t: 'input', wish, jump };
  const rig = currentRig();
  if (rig) msg.aim = rig.dir.map((v) => Math.round(v * 1000) / 1000); // 시선 방향(들기 중 물체가 따라온다)
  send(msg);
  S.lastWish = wish.join(',');
  S.lastAim = msg.aim?.join(',') || '';
  S.lastInputAt = performance.now();
}

function currentRig() {
  const me = S.frame?.bodies.get(S.me);
  if (!me) return null;
  return cameraRig(me.p, S.yaw, S.pitch);
}

function myEffect() {
  const ps = mySnap();
  return ps?.e ? tokenWord(ps.e) : null;
}

function sustaining() {
  return S.holding || !!mySnap()?.hold;
}

function cast() {
  const rig = currentRig();
  if (!rig) return;
  if (sustaining()) { toast(`${REASON.SUSTAINING} (${END_CAST_KEY})`, 'info'); return; }
  if (myEffect() === 'LIFT') S.holding = true; // 버튼을 떼도 유지, 시전 종료로 놓는다
  send({
    t: 'cast',
    mode: S.mode,
    origin: rig.pos.map((v) => Math.round(v * 1000) / 1000),
    dir: rig.dir.map((v) => Math.round(v * 10000) / 10000),
    vt: Math.round(S.renderTime * 1000) / 1000, // 내가 보고 있던 호스트 시점
  });
}

// 시전 종료: 내가 유지 중인 지속형 마법을 끝낸다(<들기>면 놓기).
// 다른 사람이 건 마법에서 벗어나는 R(해제)과는 별개다.
function endCast() {
  if (!sustaining()) return;
  S.holding = false;
  send({ t: 'endCast' });
}

function cycleMode() {
  S.mode = MODE_ORDER[(MODE_ORDER.indexOf(S.mode) + 1) % MODE_ORDER.length];
  S.did.mode = true;
  toast(`대상 모드: ${MODE_LABEL[S.mode]}`, 'info');
}

function requestLock() {
  const c = $('view');
  try {
    const p = c.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch { /* 일부 환경에서는 지원하지 않는다 */ }
}

function toggleEditor(open = !S.editorOpen) {
  if (S.phase !== 'playing') return;
  S.editorOpen = open;
  $('editor').hidden = !open;
  if (open) {
    endCast();
    S.keys.clear(); // 가방이 열려 있는 동안은 움직이지 않는다(마인크래프트처럼)
    if (document.pointerLockElement) document.exitPointerLock();
    S.bagKey = '';
    renderBag();
  } else {
    inv().returnCursor();
    S.hover = null;
    $('mc-tip').hidden = true;
    $('mc-cursor').innerHTML = '';
    requestLock();
  }
}

window.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (S.phase !== 'playing') return;
  if (e.code === 'Tab') {
    e.preventDefault();
    toggleEditor();
    return;
  }
  if (e.code === 'Escape' && S.editorOpen) { toggleEditor(false); return; }
  if (S.editorOpen) { bagKey(e); return; }
  if (e.repeat) return;
  S.keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); sendInput(true); }
  if (e.code === 'KeyE') { toggleEditor(); return; } // 가방(마인크래프트처럼 E)
  if (/^Digit[1-9]$/.test(e.code)) inv().select(Number(e.code.slice(5)) - 1);
  if (e.code === 'KeyR') send({ t: 'release' });
  if (e.code === 'KeyQ') throwFromSlot(inv().sel, e.ctrlKey || e.metaKey);
  if (e.code === 'KeyC' && S.solo) { endCast(); switchCharacter(); }
  if (e.code === 'KeyF') cycleMode();
  if (e.code === 'KeyH') S.guideOff = !S.guideOff;
  if (e.code === 'KeyM') toast(sfx.toggle() ? '소리 끔 (M)' : '소리 켬 (M)', 'info');
});
window.addEventListener('keyup', (e) => S.keys.delete(e.code));
window.addEventListener('blur', () => S.keys.clear());

$('view').addEventListener('mousedown', (e) => {
  sfx.unlock();
  if (S.phase !== 'playing' || S.editorOpen) return;
  if (!S.locked) { requestLock(); return; }
  if (e.button === 0) cast();
  if (e.button === 2) endCast(); // 시전 종료 [임시 키]
});
$('view').addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  S.locked = document.pointerLockElement === $('view');
  if (!S.locked) endCast();
});
window.addEventListener('wheel', (e) => {
  if (S.phase !== 'playing' || S.editorOpen || !S.locked) return;
  inv().select(inv().sel + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });
document.addEventListener('mousemove', (e) => {
  if (!S.locked || S.editorOpen) return; // 편집창을 열면 카메라 회전을 막는다
  S.yaw -= e.movementX * SENS;
  S.pitch = Math.max(CAM.minPitch, Math.min(CAM.maxPitch, S.pitch - e.movementY * SENS));
});

// ------------------------------------------------------------------ 편집창
function mySnap() {
  return S.latest?.p?.[S.me];
}
function tokenWord(id) {
  return S.latest?.k.find((t) => t.id === id)?.w;
}

$('summary-box').addEventListener('toggle', () => { if ($('summary-box').open) $('summary-text').textContent = summaryText(); });
$('summary-copy').onclick = async () => {
  const text = summaryText();
  $('summary-text').textContent = text;
  try { await navigator.clipboard.writeText(text); $('summary-copy').textContent = '복사했어요'; } catch { $('summary-copy').textContent = '복사 안 됨 · 직접 선택해 복사하세요'; }
  setTimeout(() => { $('summary-copy').textContent = '복사'; }, 1500);
};
$('close-editor').onclick = () => toggleEditor(false);
// 확인 창(confirm)이 막힌 환경도 있어 페이지 안에서 두 번 눌러 확인한다.
let restartArmed = null;
$('restart-btn').onclick = () => {
  const btn = $('restart-btn');
  if (!restartArmed) {
    btn.textContent = '한 번 더 누르면 처음부터 다시 시작해요';
    restartArmed = setTimeout(() => {
      restartArmed = null;
      btn.textContent = '처음부터 다시 (모두)';
    }, 3000);
    return;
  }
  clearTimeout(restartArmed);
  restartArmed = null;
  btn.textContent = '처음부터 다시 (모두)';
  send({ t: 'restart' });
  toggleEditor(false);
};
buildSeats();
$('join-btn').onclick = () => connect();
$('solo-btn').onclick = () => startSolo();
$('create-btn').onclick = () => createRoom();
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinByCode($('join-code').value);
});
$('copy-link').onclick = () => {
  const text = $('room-link').textContent;
  const done = () => { $('copy-link').textContent = '복사했어요'; setTimeout(() => { $('copy-link').textContent = '링크 복사'; }, 1500); };
  const fallback = () => {
    const r = document.createRange();
    r.selectNodeContents($('room-link'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    $('copy-link').textContent = '선택됨 — Ctrl+C로 복사';
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
};

// 실행 환경에 맞는 로비 버튼만 보여 준다.
if (MODE === 'solo') {
  // 서버 없이 열린 페이지(claude.ai 링크): 혼자 해보기만.
  $('join-btn').hidden = true;
  document.querySelector('.seats').hidden = true;
  $('solo-btn').classList.remove('secondary');
  $('solo-btn').textContent = '시작하기';
  $('lobby-status').textContent = '서버 없이 이 페이지에서 바로 해 볼 수 있어요. 혼자서 A와 B를 번갈아 조작해요.';
  $('solo-note').hidden = false;
} else if (MODE === 'web') {
  // 정적 호스팅(예: Vercel): 방 만들기 / 코드·링크로 참가 / 혼자 해보기.
  $('join-btn').hidden = true;
  $('create-btn').hidden = false;
  $('join-form').hidden = false;
  $('lobby-status').textContent = '방을 만들고 링크를 친구들에게 보내면 함께 플레이해요(최대 6명).';
} else {
  $('create-btn').hidden = true;
}
// 편집창 버튼에 포커스가 남으면 Space 등으로 다시 눌릴 수 있으므로 클릭 후 포커스를 푼다.
$('editor').addEventListener('click', () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

// ------------------------------------------------------------------ 프레임
// pid가 직접·간접으로 들고 있는 것들(서버 holdingChain과 같은 규칙)
function holdingChain(pid) {
  const out = new Set();
  const stack = [pid];
  while (stack.length) {
    for (const id of S.latest?.p?.[stack.pop()]?.hold || []) {
      if (out.has(id)) continue;
      out.add(id);
      if (S.latest.p[id]) stack.push(id);
    }
  }
  return [...out];
}

function buildPreview(bodies, rig) {
  const ps = mySnap();
  if (!ps || !rig) return null;
  const none = { ok: new Set(), bad: new Set() };
  const ew = ps.e && tokenWord(ps.e);
  if (!ew) return { kind: 'none', reason: REASON.NO_EFFECT, ...none };
  if (!WORDS[ew].modes.includes(S.mode)) return { kind: 'mode', reason: modeUnsupported(ew, S.mode), ...none };
  if (ps.hold?.length) return { kind: 'holding', ok: new Set(ps.hold), bad: new Set() };
  const mc = ps.mc || {};
  if (ew === 'FIREBALL') {
    if (S.mode === 'SELF') return { kind: 'blast', radius: TUNING.fireballBlastRadius * modFactor(TUNING, mc, 'BIG', 'blastRadius'), ...none };
    return { kind: S.mode === 'NEAR' ? 'firering' : 'fire', ...none };
  }
  const world = {
    statics: LEVEL.statics,
    bodies: [...bodies].map(([id, v]) => {
      const d = BODY_DEF.get(id);
      return {
        id, kind: d.kind, pos: v.p, half: d.size.map((x) => x / 2), mass: d.mass ?? 1,
        traits: { movable: true, liftable: true, damageable: d.kind === 'dummy' },
        immune: v.i > 0, heldBy: v.h || [], holding: S.latest?.p?.[id] ? holdingChain(id) : [],
      };
    }),
  };
  const aim = { origin: rig.pos, dir: rig.dir };
  let res;
  let radius = 0;
  const heavy = new Set();
  if (ew === 'PUSH' || ew === 'PULL') {
    const reach = modFactor(TUNING, mc, 'BIG', ew === 'PUSH' ? 'pushReach' : 'pullReach');
    radius = TUNING.nearbyRadius * reach;
    res = resolveTargets(S.mode, ew, world, S.me, aim, { range: TUNING.aimedMaxRange * reach, radius });
  } else {
    const capacity = TUNING.liftCapacity * modFactor(TUNING, mc, 'STRONG', 'liftCapacity');
    if (S.mode === 'NEAR') {
      // 서버와 같은 규칙: 가벼운 것부터, 나눠 든 무게의 합이 힘 안에 들 때까지
      radius = TUNING.nearbyRadius * modFactor(TUNING, mc, 'BIG', 'liftReach');
      res = resolveTargets('NEAR', 'LIFT', world, S.me, aim, { radius, capacity, load: 0 });
      const byId = new Map(world.bodies.map((b) => [b.id, b]));
      let load = 0;
      const picked = [];
      for (const b of res.applicable.map((id) => byId.get(id)).sort((p, q) => p.mass - q.mass)) {
        const share = liftShare(b.mass, b.heldBy.length + 1);
        if (load + share > capacity + 1e-9) { res.rejected.push({ id: b.id, type: 'body', reason: REASON.TOO_HEAVY }); continue; }
        load += share;
        picked.push(b.id);
      }
      res.applicable = picked;
      if (!picked.length) res.reason = res.reason || REASON.TOO_HEAVY;
    } else {
      // 조준 들기는 무거워도 붙잡을 수 있다(혼자서는 안 올라감)
      res = resolveTargets('AIM', 'LIFT', world, S.me, aim, { range: TUNING.liftRange });
      for (const id of res.applicable) {
        const b = world.bodies.find((x) => x.id === id);
        if (liftShare(b.mass, b.heldBy.length + 1) > capacity + 1e-9) heavy.add(id);
      }
    }
  }
  return {
    kind: ew === 'LIFT' ? 'lift' : 'push',
    effect: ew,
    res,
    radius,
    heavy,
    ok: new Set(res.applicable.filter((id) => bodies.has(id))),
    bad: new Set(res.rejected.filter((r) => r.type === 'body').map((r) => r.id)),
  };
}

// ------------------------------------------------------------------ 가방·핫바(마인크래프트식)
// 칸 배치는 플레이어(자리)마다 이 화면에만 있다. 혼자 해보기에서 A·B를 바꾸면 각자의 가방을 쓴다.
function inv() {
  if (!S.invs[S.me]) S.invs[S.me] = new Inventory(TUNING.modSlots);
  return S.invs[S.me];
}

const nowSec = () => performance.now() / 1000;

// 서버 상태와 맞추고, 손(선택한 핫바 칸) + 수식 칸이 서버와 다르면 장착을 보낸다
function syncInventory(ps) {
  if (ps.m.length) S.did.attach = true;
  const I = inv();
  I.sync(ps, tokenWord, nowSec());
  const want = I.wanted(ps, nowSec());
  if (want) send({ t: 'loadout', effect: want.effect, mods: want.mods });
}

function throwIds(ids) {
  const rig = currentRig();
  const dir = rig ? rig.dir.map((v) => Math.round(v * 1000) / 1000) : undefined;
  for (const id of ids) send({ t: 'throw', token: id, dir });
}

function throwFromSlot(i, all) {
  const ids = inv().takeForThrow(i, all, nowSec());
  if (!ids.length) { toast('던질 단어가 없어요 · 1~9로 칸을 골라요', 'info'); return; }
  throwIds(ids);
}

function itemHTML(word, count = 1) {
  if (!word) return '';
  const w = WORDS[word];
  return `<div class="mc-item ${w.kind === KIND.EFFECT ? 'effect' : 'mod'}">${w.label}${count > 1 ? `<span class="mc-count">${count}</span>` : ''}</div>`;
}

function slotHTML(area, idx, s, extra = '') {
  return `<div class="mc-slot${extra}" data-area="${area}" data-i="${idx}"${s ? ` data-word="${s.word}"` : ''}>${s ? itemHTML(s.word, s.tokens.length) : ''}</div>`;
}

// 화면 아래 핫바 9칸
function updateHotbar() {
  const I = inv();
  let html = '';
  for (let i = 0; i < HOTBAR; i++) {
    const s = I.slots[i];
    html += `<div class="mc-slot${i === I.sel ? ' sel' : ''}"><span class="mc-num">${i + 1}</span>${s ? itemHTML(s.word, s.tokens.length) : ''}</div>`;
  }
  if ($('hotbar').dataset.html !== html) {
    $('hotbar').dataset.html = html;
    $('hotbar').innerHTML = html;
  }
}

// 가방 창 그리기(바뀐 때만)
function renderBag() {
  const ps = mySnap();
  if (!ps) return;
  const I = inv();
  const key = JSON.stringify([I.slots, I.mods, I.sel, I.cursor, S.hover, ps.mc, ps.e]);
  if (key === S.bagKey) return;
  S.bagKey = key;
  const hov = (area, i) => (S.hover && S.hover.area === area && S.hover.i === i ? ' hover' : '');
  const hand = I.slots[I.sel];
  $('mc-hand').outerHTML = `<div id="mc-hand" class="mc-slot hand${hov('hand', 0)}" data-area="hand" data-i="0"${hand ? ` data-word="${hand.word}"` : ''}>${hand && WORDS[hand.word].kind === KIND.EFFECT ? itemHTML(hand.word) : ''}</div>`;
  $('mc-hand-label').textContent = `손 (핫바 ${I.sel + 1}번)`;
  let mods = '';
  for (let j = 0; j < TUNING.modSlots; j++) {
    const id = I.mods[j];
    mods += slotHTML('mod', j, id ? { word: tokenWord(id), tokens: [id] } : null, hov('mod', j));
  }
  $('mc-mods').innerHTML = mods;
  const handWord = hand && WORDS[hand.word].kind === KIND.EFFECT ? hand.word : null;
  const counts = {};
  for (const id of I.mods) counts[tokenWord(id)] = (counts[tokenWord(id)] || 0) + 1;
  $('mc-result').textContent = handWord ? spellLabel(handWord, counts) : '손에 효과 단어가 없어요 (핫바 칸을 골라요)';
  let main = '';
  for (let i = HOTBAR; i < HOTBAR + MAIN; i++) main += slotHTML('inv', i, I.slots[i], hov('inv', i));
  $('mc-main').innerHTML = main;
  let hot = '';
  for (let i = 0; i < HOTBAR; i++) hot += slotHTML('inv', i, I.slots[i], hov('inv', i) + (i === I.sel ? ' hand' : ''));
  $('mc-hot').innerHTML = hot;
  $('mc-cursor').innerHTML = I.cursor ? itemHTML(I.cursor.word, I.cursor.tokens.length) : '';
}

function slotUnder(el) {
  const slot = el?.closest?.('.mc-slot');
  if (!slot || !slot.dataset.area) return null;
  return { area: slot.dataset.area, i: Number(slot.dataset.i), word: slot.dataset.word || null };
}

$('editor').addEventListener('contextmenu', (e) => e.preventDefault());
$('editor').addEventListener('mousedown', (e) => {
  if (!S.editorOpen || e.target.closest('button, summary, pre')) return;
  const I = inv();
  const now = nowSec();
  const hit = slotUnder(e.target);
  if (!hit) {
    // 창 밖 클릭: 들고 있는 단어를 던진다(좌클릭 전부, 우클릭 하나)
    if (!e.target.closest('#mc-panel') && I.cursor) throwIds(I.takeCursorForThrow(e.button === 0, now));
    S.bagKey = '';
    return;
  }
  e.preventDefault();
  $('mc-tip').hidden = true;
  let r = false;
  if (hit.area === 'inv') r = I.clickSlot(hit.i, e.button, e.shiftKey, now);
  else if (hit.area === 'mod') r = I.clickMod(hit.i, e.button, e.shiftKey, now);
  else if (hit.area === 'hand') r = I.clickHand(e.button, e.shiftKey, now);
  if (r === 'reject') toast(hit.area === 'mod' ? '수식 칸에는 수식 단어만 들어가요' : '손에는 효과 단어만 들 수 있어요', 'info');
  S.bagKey = '';
});
$('editor').addEventListener('mousemove', (e) => {
  $('mc-cursor').style.left = `${e.clientX}px`;
  $('mc-cursor').style.top = `${e.clientY}px`;
  const hit = slotUnder(e.target);
  const prev = S.hover;
  S.hover = hit ? { area: hit.area, i: hit.i } : null;
  if (JSON.stringify(prev) !== JSON.stringify(S.hover)) S.bagKey = '';
  const tip = $('mc-tip');
  if (hit?.word && !inv().cursor) {
    tip.innerHTML = `<b>&lt;${WORDS[hit.word].label}&gt;</b><br>${WORD_DESC[hit.word] || ''}`;
    tip.style.left = `${e.clientX + 16}px`;
    tip.style.top = `${e.clientY + 12}px`;
    tip.hidden = false;
  } else {
    tip.hidden = true;
  }
});

// 가방이 열려 있을 때의 키: 칸 위에서 1~9(핫바와 바꾸기), Q(던지기), E(닫기)
function bagKey(e) {
  if (e.code === 'KeyE') { toggleEditor(false); return; }
  const I = inv();
  const h = S.hover;
  if (/^Digit[1-9]$/.test(e.code) && h?.area === 'inv') { I.swapWithHotbar(h.i, Number(e.code.slice(5)) - 1); S.bagKey = ''; }
  if (e.code === 'KeyQ' && h) {
    const all = e.ctrlKey || e.metaKey;
    if (h.area === 'inv') throwIds(I.takeForThrow(h.i, all, nowSec()));
    if (h.area === 'hand') throwIds(I.takeForThrow(I.sel, all, nowSec()));
    if (h.area === 'mod') throwIds(I.takeModForThrow(h.i, nowSec()));
    S.bagKey = '';
  }
  if (e.code === 'KeyM') toast(sfx.toggle() ? '소리 끔 (M)' : '소리 켬 (M)', 'info');
}

// '처음 해보기' 안내: 기획서의 기본 흐름(단어 발견 → 주문 구성 → 시험·교환 → 함께 도착)으로 이끈다
function guideText(ps) {
  if (S.latest?.g?.c) return '';
  const I = inv();
  const ew = ps.e && tokenWord(ps.e);
  const step = (n, text) => `처음 해보기 ${n}/5 · ${text}`;
  if (!ew) {
    const hasEffect = I.slots.some((x) => x && WORDS[x.word].kind === KIND.EFFECT);
    return step(1, hasEffect ? '1~9로 효과 단어 칸을 골라 손에 들어요' : '바닥의 단어 위로 걸어가면 주워져요');
  }
  if (!S.did.cast) return step(1, `좌클릭으로 <${WORDS[ew].label}>을(를) 친구나 물건에 써 봐요`);
  if (!S.did.mode) return step(2, 'F로 대상 모드를 바꿔 같은 주문을 다르게 써 봐요 (본인·주변)');
  if (!S.did.pickup) return step(3, '둘러보며 새 단어를 찾아 걸어가 주워요');
  const looseMod = I.slots.some((x) => x && WORDS[x.word].kind === KIND.MOD);
  if (!S.did.attach && looseMod) return step(4, 'E 가방에서 수식 단어를 위쪽 수식 칸에 넣어 봐요 (Shift+클릭)');
  if (!S.did.share) return step(5, '1~9로 단어를 고르고 Q로 친구에게 던져 줘 봐요');
  return '목표: 짐(★)과 모두가 단차 위 도착 구역에 2초 함께 있기';
}

function updateHud(frame) {
  const ps = mySnap();
  if (!ps) return;
  syncInventory(ps);
  if (S.editorOpen) renderBag();
  const guide = S.guideOff ? '' : guideText(ps);
  if ($('guide').dataset.text !== guide) {
    $('guide').dataset.text = guide;
    $('guide').innerHTML = guide ? `${guide} <span class="key">H</span>` : '';
    $('guide').hidden = !guide;
  }
  // 대상 모드와 현재 주문(효과 + 수식 중첩)
  $('mode-chip').textContent = MODE_LABEL[S.mode];
  const ew = ps.e && tokenWord(ps.e);
  const chips = MOD_IDS.filter((id) => ps.mc?.[id] > 0)
    .map((id) => `<span class="word mod">${WORDS[id].label}${ps.mc[id] > 1 ? ` × ${ps.mc[id]}` : ''}</span>`);
  chips.push(ew ? `<span class="word action">${WORDS[ew].label}</span>` : '<span class="word action empty">[효과]</span>');
  const html = chips.join('<span class="plus-sm">+</span>');
  if ($('spell-line').dataset.html !== html) {
    $('spell-line').innerHTML = html;
    $('spell-line').dataset.html = html;
  }

  const cdLeft = Math.max(0, ps.cd - (performance.now() / 1000 - S.latestAt));
  $('cooldown-bar').style.width = `${(1 - cdLeft / TUNING.castCooldown) * 100}%`;

  const pv = frame.preview;
  const note = $('preview-note');
  const ch = $('crosshair');
  ch.className = '';
  const setNote = (text, cls) => { note.textContent = text; note.className = `preview-note ${cls}`; };
  if (S.editorOpen) setNote('가방을 여는 동안은 멈춰요 (E로 닫기)', '');
  else if (!pv) setNote('', '');
  else if (pv.kind === 'none' || pv.kind === 'mode') { setNote(pv.reason, 'bad'); ch.className = 'bad'; }
  else if (pv.kind === 'holding') {
    const stuck = ps.hold.filter((id) => frame.bodies.get(id)?.hv);
    if (stuck.length) setNote(`${stuck.map(nameOf).join(', ')}: 혼자서는 무거워 안 올라가요 · 친구가 같이 들면 올라가요 · ${END_CAST_KEY}으로 놓기`, 'bad');
    else setNote(`${ps.hold.map(nameOf).join(', ')}을(를) 들고 있어요 · 시점을 돌려 옮기고, ${END_CAST_KEY}으로 놓아요`, 'ok');
    ch.className = 'ok';
  }
  else if (pv.kind === 'fire') { setNote('조준한 곳으로 날아가요 · 실제로 맞은 대상에 적용돼요', ''); ch.className = 'fire'; }
  else if (pv.kind === 'firering') { setNote('내 둘레 사방으로 4발 · 각각 실제로 맞은 대상에 적용돼요', ''); ch.className = 'fire'; }
  else if (pv.kind === 'blast') { setNote('발밑 폭발 · 나는 피해 없이 튀어 오르고(땅에서만), 둘레는 폭발을 맞아요', ''); ch.className = 'fire'; }
  else if (pv.effect === 'PULL' && S.mode === 'AIM' && pv.res.selection.selected[0]?.type === 'static' && !pv.res.reason) {
    setNote('지형을 당기면 내가 그쪽으로 끌려가요', 'ok');
    ch.className = 'ok';
  }
  else if (pv.ok.size) {
    const ids = [...pv.ok];
    const label = (id) => {
      const v = frame.bodies.get(id);
      if (pv.heavy.has(id)) return `${nameOf(id)}(혼자서는 무거움 · 같이 들기)`;
      if (v?.h?.length) return `${nameOf(id)}(같이 들기)`;
      return nameOf(id);
    };
    const head = pv.kind === 'lift' ? '들 수 있어요' : pv.effect === 'PULL' ? '끌어와요' : '적용 대상';
    setNote(`${head}: ${ids.map(label).join(', ')}`, pv.heavy.size && ids.every((id) => pv.heavy.has(id)) ? 'bad' : 'ok');
    if (S.mode === 'AIM') ch.className = 'ok';
  } else {
    setNote(pv.res.reason, 'bad');
    if (S.mode === 'AIM') ch.className = pv.res.selection.selected[0]?.type === 'static' ? 'blocked' : 'bad';
  }

  // 상태 표시
  const me = frame.bodies.get(S.me);
  const badges = [];
  if (me?.h?.length) badges.push(`<span class="badge float">${me.h.map(nameOf).join('·')}에게 들려 있어요 · R로 풀기</span>`);
  if (me?.d > 0) badges.push(`<span class="badge ext">그을림 · 느려짐 ${me.d.toFixed(1)}초</span>`);
  if (me?.i > 0) badges.push(`<span class="badge shield">보호 중 ${me.i.toFixed(1)}초</span>`);
  for (const id of SEAT_IDS) {
    const ob = id !== S.me && frame.bodies.get(id);
    if (ob?.i > 0) badges.push(`<span class="badge shield">${id} 보호 중</span>`);
  }
  $('badges').innerHTML = badges.join('');

  updateHotbar();

  // 도착 구역
  const g = S.latest.g;
  const keys = Object.keys(g.in);
  const items = $('goal-items');
  if (items.dataset.keys !== keys.join()) {
    // 접속한 사람이 바뀌면 목록을 다시 만든다(짐 + 접속한 모든 사람)
    items.dataset.keys = keys.join();
    items.innerHTML = keys.map((k) => `<span data-k="${k}">${k === 'cargo' ? '짐' : k}</span>`).join('');
  }
  for (const el of items.children) el.classList.toggle('in', !!g.in[el.dataset.k]);
  $('goal-fill').style.width = `${Math.min(1, g.t / TUNING.goalHoldTime) * 100}%`;
  $('clear-banner').hidden = !g.c;
  if (g.c && !$('clear-summary').textContent) $('clear-summary').textContent = summaryText();
  if (!g.c && $('clear-summary').textContent) $('clear-summary').textContent = '';
  $('lock-hint').hidden = S.locked || S.editorOpen;
}

function nearestPickable(bodies) {
  const me = bodies.get(S.me);
  if (!me || !S.latest) return null;
  const bottom = me.p[1] - BODY_DEF.get(S.me).size[1] / 2;
  let best = null;
  for (const t of S.latest.k) {
    if (t.o || !t.p) continue;
    const dh = Math.hypot(t.p[0] - me.p[0], t.p[2] - me.p[2]);
    if (dh <= TUNING.pickupRadius && Math.abs(t.p[1] - bottom) <= 2.5 && (!best || dh < best.dh)) best = { id: t.id, dh };
  }
  return best?.id || null;
}

let lastT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dt = Math.min(0.1, (nowMs - lastT) / 1000);
  lastT = nowMs;
  const t = nowMs / 1000;

  if (S.phase !== 'playing' || !S.latest) {
    // 로비 배경: 천천히 도는 카메라
    const a = t * 0.1;
    renderer.render({
      bodies: new Map(LEVEL.bodies.map((d) => [d.id, { p: [d.pos[0], d.pos[1] + d.size[1] / 2, d.pos[2]], y: 0, i: 0, d: 0, g: 1, speed: 0, hp: d.kind === 'dummy' ? TUNING.dummyHp : undefined }])),
      tokens: LEVEL.tokens.filter((x) => x.pos).map((x) => ({ id: x.id, w: x.word, p: x.pos })),
      me: null,
      camera: { pos: [Math.sin(a) * 26, 16, 16 + Math.cos(a) * 26], look: [0, 0, 16] },
    }, dt, t);
    return;
  }

  // 입력 전송: 바뀌었거나 주기적으로. 들기 중에는 시선이 바뀌면 자주(초당 최대 30회) 보낸다.
  const wish = wishVector().map((v) => Math.round(v * 1000) / 1000).join(',');
  const aimNow = currentRig()?.dir.map((v) => Math.round(v * 1000) / 1000).join(',') || '';
  if (wish !== S.lastWish || nowMs - S.lastInputAt > 100 || (sustaining() && aimNow !== S.lastAim && nowMs - S.lastInputAt > 33)) sendInput(false);

  const bodies = interpolated();
  const me = bodies.get(S.me);
  if (!me) return;
  const rig = cameraRig(me.p, S.yaw, S.pitch);
  const preview = S.editorOpen ? null : buildPreview(bodies, rig);
  const f = {
    bodies,
    tokens: S.tokensView || S.latest.k,
    me: S.me,
    preview,
    nearby: (S.mode === 'NEAR' && preview?.radius) || (preview?.kind === 'blast' ? preview.radius : 0),
    projectiles: S.projectiles,
    pickable: nearestPickable(bodies),
    camera: { pos: rig.pos, look: rig.look },
    cleared: S.latest.g.c,
  };
  S.frame = f;
  renderer.render(f, dt, t);
  updateHud(f);
}

// ------------------------------------------------------------------ 시작
async function boot() {
  try {
    await Promise.race([document.fonts.load(`48px ${FONT_STACK}`), new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* 글꼴이 없으면 시스템 글꼴 사용 */ }
  renderer = new Renderer($('view'), { low: new URLSearchParams(location.search).get('gfx') === 'low' });
  requestAnimationFrame(frame);
  const q = new URLSearchParams(location.search);
  if (q.has('autojoin')) connect();
  if (q.has('solo')) startSolo();
  // 친구가 받은 링크(#방코드)로 열면 바로 그 방에 들어간다.
  const hashCode = location.hash.slice(1).toLowerCase();
  if (MODE === 'web' && CODE_RE.test(hashCode)) {
    $('join-code').value = hashCode;
    joinByCode(hashCode);
  }
}
boot();

// 자동 테스트용 훅(게임 규칙에는 영향이 없다: 같은 요청 메시지만 보낸다)
window.__wm = {
  get me() { return S.me; },
  get phase() { return S.phase; },
  get latest() { return S.latest; },
  get preview() { return S.frame?.preview; },
  get view() { return { yaw: S.yaw, pitch: S.pitch }; },
  get recent() { return S.recent; },
  send,
  cast,
  setView(yaw, pitch) { S.yaw = yaw; S.pitch = pitch; },
  aimAt(id) {
    for (let i = 0; i < 6; i++) {
      const me = S.frame?.bodies.get(S.me);
      const tg = S.frame?.bodies.get(id);
      if (!me || !tg) return false;
      const rig = cameraRig(me.p, S.yaw, S.pitch);
      const d = [tg.p[0] - rig.pos[0], tg.p[1] - rig.pos[1], tg.p[2] - rig.pos[2]];
      const l = Math.hypot(...d);
      S.yaw = Math.atan2(d[0], d[2]);
      S.pitch = Math.max(CAM.minPitch, Math.min(CAM.maxPitch, Math.asin(d[1] / l)));
    }
    return true;
  },
  previewNow() {
    const rig = currentRig();
    const p = buildPreview(S.frame.bodies, rig);
    return {
      ok: [...(p?.ok || [])], reason: p?.res?.reason, sel: p?.res?.selection?.selected,
      rig, me: S.frame.bodies.get(S.me)?.p, bodies: Object.fromEntries([...S.frame.bodies].map(([k, v]) => [k, v.p.map((x) => +x.toFixed(2))])),
      vt: S.renderTime, latestTime: S.latest?.time,
    };
  },
  hold(code, on) { if (on) S.keys.add(code); else S.keys.delete(code); },
  toggleEditor,
  switchCharacter,
  get solo() { return S.solo; },
  get mode() { return S.mode; },
  setMode(m) { S.mode = m; },
  endCast,
  get locked() { return S.locked; },
  liftEnd: endCast, // 이전 이름
  createRoom,
  joinByCode,
  get roomCode() { return $('room-code').textContent; },
  summaryText,
  selectSlot(i) { inv().select(i); },
  throwSelected() { throwFromSlot(inv().sel, false); },
  get hotbar() { const I = inv(); return I.slots.slice(0, HOTBAR).map((x, i) => (x ? { i, word: x.word, n: x.tokens.length, sel: i === I.sel } : null)); },
  get bag() { const I = inv(); return { slots: I.slots.map((x) => (x ? { word: x.word, n: x.tokens.length } : null)), mods: [...I.mods], sel: I.sel, cursor: I.cursor ? { word: I.cursor.word, n: I.cursor.tokens.length } : null }; },
};
