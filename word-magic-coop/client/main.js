// 클라이언트: 로비 → 접속 → 입력 전송 → 스냅숏 보간 → 렌더링·HUD.
// 게스트/호스트 모두 요청만 보내고, 결과는 호스트의 스냅숏과 이벤트로 반영한다.
import { Renderer } from './render.js';
import { rigFor, CAM } from './camera.js';
import { FONT_STACK } from './labels.js';
import { LEVEL, SEAT_IDS, bodyDefs } from '../shared/level.js';
import { TUNING } from '../shared/tuning.js';
import { WORDS, KIND, MOD_IDS, MODE_ORDER, MODE_LABEL, traitsOf } from '../shared/words.js';
import { REASON } from '../shared/targeting.js';
import { segmentBlocked } from '../shared/geom.js';
import { HostSession } from './host.js';
import { Sfx } from './sfx.js';
import { Inventory, HOTBAR, MAIN, MIX } from './inventory.js';
import { hostRoom, joinRoom, CODE_RE } from './p2p.js';
import { icon, key, chip, esc, EFFECT_ICON, MODE_ICON } from './icons.js';
import { SelfPredictor } from './predict.js';
import { PlayStats } from './stats.js';
import { buildPreview as previewFor, holdingChainOf } from './preview.js';

const $ = (id) => document.getElementById(id);
// 화면 요소는 값이 바뀔 때만 고친다(같은 값을 매 프레임 써도 다시 그려져 느려진다)
const domCache = new WeakMap();
function setDom(el, key, value, apply) {
  let c = domCache.get(el);
  if (!c) domCache.set(el, (c = {}));
  if (c[key] === value) return;
  c[key] = value;
  apply(value);
}
const setClass = (el, v) => setDom(el, 'class', v, (x) => { el.className = x; });
const setWidth = (el, v) => setDom(el, 'width', v, (x) => { el.style.width = x; });
const setHidden = (el, v) => setDom(el, 'hidden', v, (x) => { el.hidden = x; });
const NAMES = {
  ...Object.fromEntries(SEAT_IDS.map((id) => [id, id])), rock: '돌', box1: '상자', box2: '무거운 상자', dummy: '허수아비', cargo: '짐',
  boulder: '커다란 바위', campfire: '모닥불', well: '샘', ice1: '얼음', ice2: '얼음', ice3: '얼음', steam1: '김', steam2: '김',
};
const BODY_DEF = new Map(bodyDefs().map((d) => [d.id, d]));
const SEAT_COLOR = Object.fromEntries(LEVEL.seats.map((s) => [s.id, s.color]));
const SENS = 0.0025;
const END_CAST_IC = icon('mouseR'); // 시전 종료 키(우클릭) [임시] — 키 배정은 추후 결정

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
  view: new URLSearchParams(location.search).get('view') === 'third' ? 'third' : 'first', // 1인칭(손만 보임, 기본) ↔ 3인칭(V)
  predict: new URLSearchParams(location.search).get('predict') !== '0', // 내 캐릭터 예측(끄려면 ?predict=0)
  rtt: 0, // 호스트까지 왕복 지연(초)
  holding: false, // 내가 유지 중인 지속형 마법(<들기>)이 있음 — 시전 종료로 끝낸다
  did: { cast: false, mode: false, pickup: false, attach: false, share: false }, // '처음 해보기' 안내 진행
  stats: new PlayStats(), // 판 요약(플레이테스트 관찰용, stats.js)
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
const predictor = new SelfPredictor(LEVEL.statics);

// ------------------------------------------------------------------ 로비·연결
function setLobby(status, note = null) {
  $('lobby').hidden = false;
  $('hud').hidden = true;
  $('editor').hidden = true;
  S.editorOpen = false;
  if (document.pointerLockElement) document.exitPointerLock();
  $('lobby-status').innerHTML = status; // 이 파일에서 만든 HTML만 들어온다(밖에서 온 글은 esc)
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
  setLobby(`${icon('clock')} …`);
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
  setLobby(`${icon('clock')} …`);
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
        if (S.phase !== 'playing') setLobby(`${icon('ok')} ${icon('link')}${icon('arrow')}${icon('people')}`);
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
  setLobby(`${icon('in')} ${esc(code)} …`);
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

// 화면의 글자는 기호로: 사람은 색 동그라미, 조작은 키 모양 + 그림
const pc = (id, cls = '') => chip(id, SEAT_COLOR[id], cls);
const OBJ_ICON = {
  cargo: ['flag'], rock: ['rock'], box1: ['box'], box2: ['box', 'weight'], dummy: ['dummy'],
  boulder: ['rock', 'big'], campfire: ['flame'], well: ['water'], ice1: ['snow'], ice2: ['snow'], ice3: ['snow'], steam1: ['steam'], steam2: ['steam'],
};
// 부서지며 작아진 바위는 스냅숏의 sc만큼 작다
const halfOf = (id, v) => BODY_DEF.get(id).size.map((x) => (x / 2) * (v?.sc || 1));
// 사람·물건 표시(사람은 자리 색 동그라미, 짐은 선물 상자, 나머지는 짧은 이름)
function P(id) {
  if (SEAT_COLOR[id]) return pc(id);
  if (OBJ_ICON[id]) return `<span class="ob" title="${esc(NAMES[id] || id)}">${OBJ_ICON[id].map((n) => icon(n)).join('')}</span>`;
  return `<span class="nm">${esc(NAMES[id] || id)}</span>`;
}
// 단어 표: 보통은 색 동그라미 + 그림만. 이름(글자)은 왼쪽 위 주문 칸·가방 결과 칸에서만(full)
function W(word, n = 1, full = false) {
  const w = WORDS[word];
  if (!w) return '';
  const kind = w.kind === KIND.EFFECT ? 'effect' : 'mod';
  return `<span class="wt ${kind}${full ? '' : ' ico'}" data-w="${word}" title="${w.label}">${icon(EFFECT_ICON[word])}${full ? w.label : ''}${n > 1 ? `×${n}` : ''}</span>`;
}
// 주문 = 수식 단어들 + 효과 단어
function spellHTML(effect, mods = {}, full = false) {
  return [...MOD_IDS.filter((id) => mods[id] > 0).map((id) => W(id, mods[id], full)), W(effect, 1, full)].join('');
}

function updateWho() {
  const other = S.me === 'A' ? 'B' : 'A';
  $('who-chip').innerHTML = S.solo ? `${pc(S.me)}${key('C')}${icon('swap')}${pc(other, 'dim')}` : pc(S.me);
  $('keys').innerHTML = keysHTML(S.solo);
}

// 조작 = 키 모양 + 그림(게임 화면 오른쪽 아래와 첫 화면 조작법에 같이 쓴다)
function keysHTML(solo, extra = false) {
  const k = (k1, ic, title) => `<span title="${title}">${k1}${[].concat(ic).map((n) => icon(n)).join('')}</span>`;
  return [
    k(key('WASD'), 'walk', '이동'), k(key('Space'), 'jump', '점프'), k(icon('mouseL'), 'wand', '시전'), k(END_CAST_IC, 'stop', '시전 종료'),
    k(key('F'), ['aim', 'self', 'near'], '대상 모드'), k(key('1~9'), 'hand', '단어 고르기'), k(key('Q'), 'throw', '던지기'),
    k(key('E'), 'bag', '가방'), k(key('R'), 'release', '풀기'), k(key('V'), 'eye', '1인칭·3인칭'), k(key('M'), 'sound', '소리'),
    extra ? k(key('H'), 'leaf', '안내') : '', extra ? k(icon('walk'), ['arrow', 'leaf'], '걸어가 줍기') : '',
    solo ? k(key('C'), 'swap', 'A·B 전환') : '',
  ].join('');
}

// 첫 화면 조작법: 효과 × 대상 모드 그림표
const MODE_PICTO = {
  PUSH: { AIM: ['push'], SELF: ['self', 'arrow'], NEAR: ['near', 'push'] },
  PULL: { AIM: ['pull'], NEAR: ['near', 'pull'] },
  LIFT: { AIM: ['lift'], NEAR: ['near', 'lift'] },
  FIREBALL: { AIM: ['fire', 'arrow', 'aim'], SELF: ['fire', 'up'], NEAR: ['fire', 'near'] },
};
function howtoHTML() {
  $('howto-keys').innerHTML = keysHTML(MODE === 'solo', true);
  const head = `<tr><th></th>${MODE_ORDER.map((m) => `<th title="${MODE_LABEL[m]}">${icon(MODE_ICON[m])}</th>`).join('')}</tr>`;
  const rows = Object.entries(MODE_PICTO).map(([w, cells]) => `<tr><td>${W(w)}</td>${MODE_ORDER.map((m) => `<td>${cells[m] ? cells[m].map((n) => icon(n)).join('') : icon('no', 'off')}</td>`).join('')}</tr>`);
  $('howto-modes').innerHTML = head + rows.join('');
}

// 시점: 1인칭(손만 보임) ↔ 3인칭
function toggleView() {
  S.view = S.view === 'first' ? 'third' : 'first';
  toast(`${icon('eye')}${S.view === 'first' ? '1' : '3'}`, 'info');
}

function switchCharacter() {
  if (!S.solo || S.phase !== 'playing') return;
  S.views[S.me] = { yaw: S.yaw, pitch: S.pitch };
  const next = S.me === 'A' ? 'B' : 'A';
  S.conn.switchTo(next);
  S.me = next;
  predictor.reset();
  const v = S.views[next] || { yaw: 0, pitch: -0.08 };
  S.yaw = v.yaw;
  S.pitch = v.pitch;
  S.lastWish = '';
  updateWho();
  log(`${icon('swap')}${pc(next)}`);
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
        if (m.you !== 'A') setLobby(`${pc(m.you)} ${icon('in')} …`);
        break;
      }
      setLobby(`${pc(m.you)} ${icon('clock')} …`);
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
      setLobby(`${icon('clock')} …`, `플레이어 ${m.who}의 연결이 끊겨 로비로 돌아왔어요. 새 상대가 접속하면 처음부터 시작해요.`);
      break;
    case 's':
      onSnapshot(m);
      break;
    case 'ev':
      if (m.k === 'pong') { onPong(m); break; }
      onEvent(m);
      break;
  }
}

// 왕복 지연: 1초마다 재서 내 캐릭터 예측에 쓴다(가끔 늦게 오는 값에는 덜 흔들리게)
function onPong(m) {
  const sample = performance.now() / 1000 - m.c;
  if (!(sample >= 0 && sample < 2)) return;
  S.rtt = Math.min(0.25, S.rtt ? S.rtt + (sample - S.rtt) * (sample < S.rtt ? 0.5 : 0.15) : sample);
}
setInterval(() => { if (S.phase === 'playing') send({ t: 'rtt', c: performance.now() / 1000 }); }, 1000);

function startPlaying() {
  predictor.reset();
  S.phase = 'playing';
  S.stats = new PlayStats();
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
  log(S.solo ? `${icon('star')} ${key('C')}${pc('A')}${icon('swap')}${pc('B')}` : `${icon('star')} ${icon('people')}`);
}

// ------------------------------------------------------------------ 스냅숏 보간
function onSnapshot(s) {
  const now = performance.now() / 1000;
  const sample = now - s.time;
  if (S.offset === null || s.round !== S.round) {
    S.offset = sample;
    S.snaps = [];
    S.round = s.round;
    predictor.reset();
  } else {
    S.offset = Math.min(sample, S.offset + 0.002);
  }
  S.snaps.push(s);
  while (S.snaps.length > 2 && S.snaps[1].time < s.time - 1) S.snaps.shift();
  S.latest = s;
  S.latestAt = now;
  const mine = s.b.find((x) => x.id === S.me);
  if (mine) predictor.onSnapshot(mine, s.time, now);
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
      sc: y.sc,
      st: y.st,
      lit: y.lit,
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
function log(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  $('log').prepend(li);
  setTimeout(() => li.classList.add('old'), 6000);
  setTimeout(() => li.remove(), 6800);
  while ($('log').children.length > 6) $('log').lastChild.remove();
}

let toastTimer;
// 도착 축하 꽃가루(동숲처럼 칭찬은 크게)
function confetti() {
  const colors = ['#ff9f6e', '#a98bff', '#45c2ad', '#ffd95a', '#8ccf5e', '#ff7f9f'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
    c.style.animationDelay = `${Math.random() * 0.6}s`;
    document.body.append(c);
    setTimeout(() => c.remove(), 5000);
  }
}

// 말풍선 알림. 실패도 겁주지 않게 '앗!'으로 부드럽게 시작한다(동물의 숲 말투).
// html: 기호(SVG) + 짧은 글
function toast(html, kind = 'bad') {
  $('toast').innerHTML = html;
  $('toast').className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').className = kind; }, 1600);
}

// 실패 이유 → 기호 + 짧은 말. 모르는 이유는 글 그대로.
const REASON_HTML = {
  [REASON.NO_EFFECT]: () => `${icon('hand')}${icon('no')} ${key('1~9')}`,
  [REASON.COOLDOWN]: () => `${icon('clock')}`,
  [REASON.NO_TARGET]: () => `${icon('aim')}${icon('no')}`,
  [REASON.OUT_OF_RANGE]: () => `${icon('aim')}${icon('far')}`,
  [REASON.NOTHING_NEARBY]: () => `${icon('near')}${icon('no')}`,
  [REASON.TERRAIN]: () => `${icon('wall')}${icon('no')}`,
  [REASON.NOT_MOVABLE]: () => `${icon('wall')}${icon('no')}`,
  [REASON.NOT_LIFTABLE]: () => `${icon('lift')}${icon('no')}`,
  [REASON.TOO_HEAVY]: () => `${icon('weight')} ${icon('arrow')} ${W('STRONG')} / ${icon('people')}`,
  [REASON.ALREADY_HELD]: () => `${icon('lift')}${icon('ok')}`,
  [REASON.HOLDING_YOU]: () => `${icon('lift')}${icon('swap')}${icon('no')}`,
  [REASON.HEAVY_GRAB]: () => `${icon('weight')} ${icon('arrow')} ${icon('people')} / ${W('STRONG')}`,
  [REASON.STANDING_ON]: () => `${icon('walk')}${icon('no')}`,
  [REASON.PROTECTED]: () => `${icon('shield')}${icon('no')}`,
  [REASON.BAD_AIM]: () => `${icon('aim')}${icon('no')}`,
  [REASON.NOT_PLAYING]: () => `${icon('stop')}`,
  [REASON.NOT_HEATABLE]: () => `${W('FIRE')}${icon('no')}`,
  [REASON.SOURCE_EMPTY]: () => `${icon('pull')}${icon('no')} ${icon('clock')}`,
  [REASON.BAD_MIX]: () => `${icon('mix')}${icon('no')}`,
  [REASON.SUSTAINING]: () => `${icon('lift')} ${icon('arrow')} ${END_CAST_IC}${icon('stop')}`,
};
const REASON_KEY = Object.fromEntries(Object.entries(REASON).map(([k, v]) => [v, k]));
const reasonHTML = (r) => (REASON_HTML[r] ? `<span class="rs" data-r="${REASON_KEY[r]}">${REASON_HTML[r]()}</span>` : esc(r || ''));
const modeHTML = (ew, mode) => `${W(ew)} ${icon(MODE_ICON[mode])}${icon('no')} ${key('F')}`;

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
      if (e.effect === 'FIREBALL' || e.effect === 'FIRE') { if (e.mode !== 'SELF') sfx.play('fire', kk); break; }
      if (e.effect === 'WATER' || e.effect === 'STEAM') { sfx.play('throw', kk); break; }
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
    case 'splash': sfx.play('hit', k(e.pos)); break;
    case 'chip': case 'shatter': sfx.play('boom', k(at(e.id) || e.pos) * 0.6); break;
    case 'wordBorn': sfx.play('pickup', k(e.pos)); break;
    case 'react': sfx.play('give', 1); break;
    case 'reactFail': sfx.play('fail'); break;
    case 'pickup': sfx.play(e.from ? 'give' : 'pickup', k(at(e.by))); break;
    case 'throw': sfx.play('throw', k(at(e.by))); break;
    case 'release': sfx.play('release', k(at(e.by))); break;
    case 'castFail': case 'pickupFail': sfx.play('fail'); break;
    case 'clear': sfx.play('clear'); break;
    default: break;
  }
}

function onEvent(e) {
  try { playSfx(e); } catch { /* 소리는 표시용: 실패해도 진행 */ }
  S.stats.record(e);
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
      const spell = spellHTML(e.effect, e.mods);
      const to = icon('arrow');
      if (e.effect === 'FIREBALL' || (e.effect === 'WATER' && e.mode !== 'SELF')) log(`${P(e.by)}${spell}${icon(MODE_ICON[e.mode] || 'aim')}${e.mode === 'NEAR' ? '×4' : ''}`);
      else if (e.effect === 'PULL' && e.anchor) log(`${P(e.by)}${spell}${icon('wall')}${icon('pull')}${P(e.by)}`);
      else log(`${P(e.by)}${spell}${icon(MODE_ICON[e.mode])}${to}${e.targets.map(P).join('')}`);
      break;
    }
    case 'liftStart': {
      renderer.poke(e.by, 'cast');
      const ids = e.targets || [e.target];
      const joined = new Set(e.joined || []);
      log(`${P(e.by)}${spellHTML('LIFT', e.mods)}${icon('arrow')}${ids.map((id) => P(id) + (joined.has(id) ? icon('people') : '')).join('')}`);
      if (e.by === S.me && e.heavy?.length) toast(reasonHTML(REASON.HEAVY_GRAB), 'info');
      break;
    }
    case 'liftEnd':
      if (e.by === S.me) S.holding = false;
      if (e.reason === 'word') log(`${P(e.by)}${W('LIFT')}${icon('no')}${icon('arrow')}${P(e.target)}${icon('down')}`);
      if (e.reason === 'far') log(`${P(e.target)}${icon('far')}${icon('down')}`);
      if (e.reason === 'released-by-target') log(`${P(e.target)}${key('R')}${icon('release')}`);
      break;
    case 'boom': {
      renderer.boomFx(e);
      const parts = e.hits.map((h) => {
        if (h.effects.includes('damage')) return `${P(h.id)}-${Math.round(e.damage)}`;
        if (h.effects.includes('debuff')) return `${P(h.id)}${icon('slow')}`;
        return null;
      }).filter(Boolean);
      if (parts.length) log(`${icon('boom')}${parts.join(' ')}`);
      break;
    }
    case 'fizzle':
      renderer.fizzleFx(e.pos);
      break;
    // 세계의 성질을 단어로
    case 'splash': {
      renderer.worldFx(e);
      const parts = e.hits.map((h) => {
        if (h.effects.includes('douse')) return `${P(h.id)}${icon('water')}${icon('no')}`;
        if (h.effects.includes('fill')) return `${P(h.id)}${icon('water')}${icon('ok')}`;
        if (h.effects.includes('wash')) return `${P(h.id)}${icon('slow')}${icon('no')}`;
        return null;
      }).filter(Boolean);
      if (parts.length) log(`${icon('water')}${parts.join(' ')}`);
      break;
    }
    case 'freeze':
      renderer.worldFx(e);
      log(`${P(e.by)}${W('WATER')}${icon('snow')}${icon('arrow')}${P(e.id)}`);
      break;
    case 'melt':
      renderer.worldFx(e);
      log(`${P(e.id)}${e.steam ? `${icon('arrow')}${icon('steam')}` : icon('water')}`);
      break;
    case 'steam': case 'vanish':
      renderer.worldFx(e);
      break;
    case 'chip':
      renderer.worldFx(e);
      if (e.words?.length) log(`${P(e.by)}${icon('arrow')}${P(e.id)}${icon('arrow')}${W('BIG')}${e.words.length > 1 ? `×${e.words.length}` : ''}`);
      break;
    case 'shatter':
      renderer.worldFx(e);
      log(`${P(e.id)}${icon('boom')}`);
      break;
    case 'wordBorn':
      renderer.worldFx(e);
      break;
    case 'extract':
      log(`${P(e.by)}${W('PULL')}${icon('arrow')}${P(e.id)}${icon('arrow')}${W(e.word)}`);
      if (e.by === S.me) toast(`${P(e.id)}${icon('arrow')}${W(e.word)}${icon('star')}`, 'info');
      break;
    case 'ignite':
      renderer.worldFx(e);
      log(`${P(e.id)}${W('FIRE')}${icon('ok')}`);
      break;
    case 'refill':
      log(`${P(e.id)}${icon('restart')}`);
      break;
    case 'react':
      log(`${P(e.by)}${icon('mix')}${e.used.map((w) => W(w)).join('')}${icon('arrow')}${W(e.word)}`);
      if (e.by === S.me) toast(`${icon('star')}${e.used.map((w) => W(w)).join(icon('plus'))}${icon('equals')}${W(e.word, 1, true)}`, 'info');
      break;
    case 'reactFail':
      toast(reasonHTML(e.reason));
      break;
    case 'dummyDown':
      log(`${P('dummy')}${icon('down')}`);
      break;
    case 'dummyUp':
      log(`${P('dummy')}${icon('up')}`);
      break;
    case 'castFail':
      if (e.by === S.me && e.reason !== REASON.SUSTAINING) S.holding = false; // 들기 시전이 거절되면 유지 상태도 푼다
      toast(reasonHTML(e.reason));
      break;
    case 'pickup': {
      const pb = S.frame?.bodies.get(e.by);
      if (pb) renderer.pickupFx([pb.p[0], pb.p[1] + 0.6, pb.p[2]]);
      if (e.by === S.me) renderer.handPoke('grab');
      if (e.from) {
        log(`${P(e.from)}${icon('throw')}${W(e.word)}${icon('arrow')}${P(e.by)}`);
        if (e.by === S.me) toast(`${P(e.from)}${icon('arrow')}${W(e.word)}${icon('ok')}${e.equipped ? icon('hand') : ''}`, 'info');
      } else {
        log(`${P(e.by)}${icon('plus')}${W(e.word)}`);
        if (e.by === S.me) toast(`${icon('star')}${W(e.word)}${WORDS[e.word].kind === KIND.MOD ? ` ${key('E')}${icon('bag')}${icon('arrow')}${icon('big')}${icon('strong')}` : ''}`, 'info');
      }
      break;
    }
    case 'throw':
      log(`${P(e.by)}${icon('throw')}${W(e.word)}`);
      break;
    case 'pickupFail':
      toast(`${icon('leaf')}${icon('no')}`);
      break;
    case 'drop':
      log(`${P(e.by)}${icon('down')}${W(e.word)}`);
      break;
    case 'release': {
      log(`${P(e.by)}${key('R')}${icon('release')}${icon('shield')}${TUNING.releaseImmunity}s`);
      const b = S.frame?.bodies.get(e.by);
      if (b) renderer.releaseFx(b.p);
      break;
    }
    case 'recover':
      if (NAMES[e.id]) log(`${P(e.id)}${icon('down')}${icon('restart')}`);
      break;
    case 'tokenRecover':
      log(`${W(e.word)}${icon('restart')}`);
      break;
    case 'clear':
      log(`${icon('flag')}${icon('star')}${icon('star')}${icon('star')}`);
      confetti();
      break;
    case 'join':
      if (e.id !== S.me) log(`${P(e.id)}${icon('in')}`);
      break;
    case 'leave':
      log(`${P(e.id)}${icon('out')}${e.dropped?.length ? `${icon('down')}${icon('leaf')}` : ''}`);
      break;
    case 'restart':
      S.snaps = [];
      S.offset = null;
      $('log').innerHTML = '';
      log(`${P(e.by)}${icon('restart')}`);
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
  predictor.input(performance.now() / 1000, wish, jump);
  S.lastWish = wish.join(',');
  S.lastAim = msg.aim?.join(',') || '';
  S.lastInputAt = performance.now();
}

function currentRig() {
  const me = S.frame?.bodies.get(S.me);
  if (!me) return null;
  return rigFor(S.view, me.p, S.yaw, S.pitch);
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
  if (sustaining()) { toast(reasonHTML(REASON.SUSTAINING), 'info'); return; }
  if (myEffect() === 'LIFT') S.holding = true; // 버튼을 떼도 유지, 시전 종료로 놓는다
  renderer.handPoke(myEffect() === 'LIFT' ? 'lift' : 'cast');
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
  toast(`${MODE_ORDER.map((m) => `<span class="${m === S.mode ? 'on' : 'off'}">${icon(MODE_ICON[m])}</span>`).join('')}`, 'info');
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
  drag = null;
  $('editor').hidden = !open;
  if (open) {
    endCast();
    S.keys.clear(); // 가방이 열려 있는 동안은 움직이지 않는다(마인크래프트처럼)
    if (document.pointerLockElement) document.exitPointerLock();
    S.bagKey = '';
    renderBag();
  } else {
    inv().returnCursor();
    inv().returnMix();
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
  moveKeyChanged(e.code);
  if (e.code === 'Space') { e.preventDefault(); sendInput(true); }
  if (e.code === 'KeyE') { toggleEditor(); return; } // 가방(마인크래프트처럼 E)
  if (/^Digit[1-9]$/.test(e.code)) inv().select(Number(e.code.slice(5)) - 1);
  if (e.code === 'KeyR') send({ t: 'release' });
  if (e.code === 'KeyQ') throwFromSlot(inv().sel, e.ctrlKey || e.metaKey);
  if (e.code === 'KeyC' && S.solo) { endCast(); switchCharacter(); }
  if (e.code === 'KeyF') cycleMode();
  if (e.code === 'KeyH') S.guideOff = !S.guideOff;
  if (e.code === 'KeyV') toggleView();
  if (e.code === 'KeyM') toast(`${icon('sound')}${sfx.toggle() ? icon('no') : icon('ok')}`, 'info');
});
window.addEventListener('keyup', (e) => {
  S.keys.delete(e.code);
  moveKeyChanged(e.code);
});
// 이동 키가 바뀌면 다음 프레임을 기다리지 않고 바로 보낸다(예측도 그 순간부터 반영)
function moveKeyChanged(code) {
  if (S.phase !== 'playing' || !MOVE_KEYS.has(code)) return;
  if (wishVector().map((v) => Math.round(v * 1000) / 1000).join(',') !== S.lastWish) sendInput(false);
}
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
window.addEventListener('blur', () => { S.keys.clear(); drag = null; });

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

$('summary-box').addEventListener('toggle', () => { if ($('summary-box').open) $('summary-text').textContent = S.stats.text(); });
$('summary-copy').onclick = async () => {
  const text = S.stats.text();
  $('summary-text').textContent = text;
  try { await navigator.clipboard.writeText(text); $('summary-copy').innerHTML = icon('ok'); } catch { $('summary-copy').innerHTML = `${icon('no')} Ctrl+C`; }
  setTimeout(() => { $('summary-copy').innerHTML = icon('copy'); }, 1500);
};
$('close-editor').onclick = () => toggleEditor(false);
// 확인 창(confirm)이 막힌 환경도 있어 페이지 안에서 두 번 눌러 확인한다.
let restartArmed = null;
$('restart-btn').onclick = () => {
  const btn = $('restart-btn');
  const idle = `${icon('restart')} ${icon('people')}`;
  if (!restartArmed) {
    btn.innerHTML = `${icon('restart')} ?`;
    restartArmed = setTimeout(() => {
      restartArmed = null;
      btn.innerHTML = idle;
    }, 3000);
    return;
  }
  clearTimeout(restartArmed);
  restartArmed = null;
  btn.innerHTML = idle;
  send({ t: 'restart' });
  toggleEditor(false);
};
buildSeats();
// 화면 곳곳의 기호 자리(<i data-ic="…">)를 그림으로 채운다
for (const el of document.querySelectorAll('[data-ic]')) el.outerHTML = icon(el.dataset.ic);
$('lock-hint').innerHTML = icon('mouseL');
$('goal-flag').innerHTML = icon('flag');
$('clear-icons').innerHTML = `${icon('flag')}${icon('people')}${icon('ok')}`;
$('join-btn').onclick = () => connect();
$('solo-btn').onclick = () => startSolo();
$('create-btn').onclick = () => createRoom();
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinByCode($('join-code').value);
});
$('copy-link').onclick = () => {
  const text = $('room-link').textContent;
  const done = () => { $('copy-link').innerHTML = icon('ok'); setTimeout(() => { $('copy-link').innerHTML = icon('copy'); }, 1500); };
  const fallback = () => {
    const r = document.createRange();
    r.selectNodeContents($('room-link'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    $('copy-link').innerHTML = `${key('Ctrl')}+${key('C')}`;
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
};

// 실행 환경에 맞는 로비 버튼만 보여 준다.
if (MODE === 'solo') {
  // 서버 없이 열린 페이지(claude.ai 링크): 혼자 해보기만.
  $('join-btn').hidden = true;
  document.querySelector('.seats').hidden = true;
  $('solo-btn').classList.remove('secondary');
  $('solo-btn').classList.add('big-play');
  $('lobby-status').innerHTML = `${pc('A')}${icon('swap')}${pc('B')}`;
} else if (MODE === 'web') {
  // 정적 호스팅(예: Vercel): 방 만들기 / 코드·링크로 참가 / 혼자 해보기.
  $('join-btn').hidden = true;
  $('create-btn').hidden = false;
  $('join-form').hidden = false;
  $('lobby-status').innerHTML = `${icon('people')} 2~6`;
} else {
  $('create-btn').hidden = true;
  $('lobby-status').innerHTML = `${icon('people')} 2~6`;
}
howtoHTML();
// 편집창 버튼에 포커스가 남으면 Space 등으로 다시 눌릴 수 있으므로 클릭 후 포커스를 푼다.
$('editor').addEventListener('click', () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

// pid가 직접·간접으로 들고 있는 것들(서버 holdingChain과 같은 규칙)
const holdingChain = (pid) => holdingChainOf(S.latest?.p, pid);

// 조준 미리보기(preview.js)
function buildPreview(bodies, rig) {
  const ps = mySnap();
  return previewFor({ ps, effect: ps?.e && tokenWord(ps.e), mode: S.mode, me: S.me, players: S.latest?.p, bodies, rig, defs: BODY_DEF });
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
  if (!ids.length) { toast(`${icon('throw')}${icon('no')} ${key('1~9')}`, 'info'); return; }
  renderer.handPoke('throw');
  throwIds(ids);
}

function itemHTML(word, count = 1) {
  if (!word) return '';
  const w = WORDS[word];
  return `<div class="mc-item ${w.kind === KIND.EFFECT ? 'effect' : 'mod'}" title="${w.label}">${icon(EFFECT_ICON[word])}${count > 1 ? `<span class="mc-count">${count}</span>` : ''}</div>`;
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
  const sig = JSON.stringify([I.slots, I.mods, I.mix, I.sel, I.cursor, S.hover, ps.mc, ps.e, drag?.targets]);
  if (sig === S.bagKey) return;
  S.bagKey = sig;
  const hov = (area, i) => (S.hover && S.hover.area === area && S.hover.i === i ? ' hover' : '')
    + (drag?.targets.length > 1 && drag.targets.some((t) => t.area === area && t.i === i) ? ' drag' : '');
  const hand = I.slots[I.sel];
  $('mc-hand').outerHTML = `<div id="mc-hand" class="mc-slot hand${hov('hand', 0)}" data-area="hand" data-i="0"${hand ? ` data-word="${hand.word}"` : ''}>${hand && WORDS[hand.word].kind === KIND.EFFECT ? itemHTML(hand.word) : ''}</div>`;
  $('mc-hand-label').innerHTML = `${icon('hand')}${key(I.sel + 1)}`;
  let mods = '';
  for (let j = 0; j < TUNING.modSlots; j++) {
    const id = I.mods[j];
    mods += slotHTML('mod', j, id ? { word: tokenWord(id), tokens: [id] } : null, hov('mod', j));
  }
  $('mc-mods').innerHTML = mods;
  const handWord = hand && WORDS[hand.word].kind === KIND.EFFECT ? hand.word : null;
  const counts = {};
  for (const id of I.mods) counts[tokenWord(id)] = (counts[tokenWord(id)] || 0) + 1;
  $('mc-result').innerHTML = handWord ? spellHTML(handWord, counts, true) : `${icon('hand')}${icon('no')}`;
  let mix = '';
  for (let j = 0; j < MIX; j++) {
    const id = I.mix[j];
    mix += slotHTML('mix', j, id ? { word: tokenWord(id), tokens: [id] } : null, hov('mix', j));
  }
  $('mc-mixin').innerHTML = mix;
  const react = I.mixReaction();
  $('mc-mixout').outerHTML = `<div id="mc-mixout" class="mc-slot out${react ? ' ready' : ''}${hov('mixout', 0)}" data-area="mixout" data-i="0"${react ? ` data-word="${react.makes}"` : ''}>${react ? itemHTML(react.makes) : (I.mix.length ? icon('no') : '')}</div>`;
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

// 칸 하나 클릭(마인크래프트 규칙). 넣을 수 없는 칸이면 안내
function clickHit(hit, button, shift, now) {
  const I = inv();
  let r = false;
  if (hit.area === 'inv') r = I.clickSlot(hit.i, button, shift, now);
  else if (hit.area === 'mod') r = I.clickMod(hit.i, button, shift, now);
  else if (hit.area === 'hand') r = I.clickHand(button, shift, now);
  else if (hit.area === 'mix') r = I.clickMix(hit.i, button, shift);
  else if (hit.area === 'mixout') {
    // 결과 칸: 반응이 맞으면 재료 단어들이 새 단어 하나가 된다(빈손일 때만, 마인크래프트처럼)
    if (I.cursor) return 'reject';
    if (!I.mixReaction()) { if (I.mix.length) toast(reasonHTML(REASON.BAD_MIX), 'info'); return false; }
    send({ t: 'react', tokens: I.takeMix(now) });
    S.did.mix = true;
    return true;
  }
  if (r === 'reject' && (hit.area === 'mix' || hit.area === 'mixout')) toast(`${icon('mix')}${icon('no')}`, 'info');
  else if (r === 'reject') {
    toast(hit.area === 'mod'
      ? `<span class="rs" data-r="MOD_ONLY">${icon('no')}${icon('hand')} ${icon('arrow')} ${W('BIG')}${W('STRONG')}</span>`
      : `<span class="rs" data-r="EFFECT_ONLY">${icon('no')}${W('BIG')} ${icon('arrow')} ${W('PUSH')}${W('PULL')}${W('LIFT')}${W('FIREBALL')}</span>`, 'info');
  }
  return r;
}
let drag = null; // 단어를 든 채 누르고 끄는 중 { button, start, targets }
let lastDown = { k: '', t: 0 }; // 두 번 클릭 판단

$('editor').addEventListener('contextmenu', (e) => e.preventDefault());
$('editor').addEventListener('mousedown', (e) => {
  drag = null; // 놓친 mouseup으로 남은 끌기는 버린다
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
  const k = `${hit.area}:${hit.i}`;
  const dbl = e.button === 0 && !e.shiftKey && lastDown.k === k && now - lastDown.t < 0.3;
  lastDown = { k, t: now };
  // 두 번 클릭: 같은 수식을 커서로 모두 모은다
  if (dbl && I.collect()) { S.bagKey = ''; return; }
  // 단어를 든 채 누르면 끌기 시작: 떼는 곳에서 확정(한 칸이면 보통 클릭, 여러 칸이면 나눠 놓기)
  if (I.cursor && !e.shiftKey && (e.button === 0 || e.button === 2) && I.canDrag(hit.area, hit.i)) {
    drag = { button: e.button, start: hit, targets: [{ area: hit.area, i: hit.i }] };
    S.bagKey = '';
    return;
  }
  clickHit(hit, e.button, e.shiftKey, now);
  S.bagKey = '';
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  S.bagKey = '';
  if (!S.editorOpen || e.button !== d.button) return;
  if (d.targets.length === 1) clickHit(d.start, d.button, false, nowSec());
  else inv().dragPlace(d.targets, d.button, nowSec());
});
$('editor').addEventListener('mousemove', (e) => {
  $('mc-cursor').style.left = `${e.clientX}px`;
  $('mc-cursor').style.top = `${e.clientY}px`;
  const hit = slotUnder(e.target);
  const prev = S.hover;
  S.hover = hit ? { area: hit.area, i: hit.i } : null;
  if (drag && hit && inv().cursor && inv().canDrag(hit.area, hit.i) && !drag.targets.some((t) => t.area === hit.area && t.i === hit.i)
    && drag.targets.length < inv().cursor.tokens.length) {
    drag.targets.push({ area: hit.area, i: hit.i });
    S.bagKey = '';
  }
  if (JSON.stringify(prev) !== JSON.stringify(S.hover)) S.bagKey = '';
  const tip = $('mc-tip');
  if (hit?.word && !inv().cursor) {
    tip.innerHTML = wordTip(hit.word);
    tip.style.left = `${e.clientX + 16}px`;
    tip.style.top = `${e.clientY + 12}px`;
    tip.hidden = false;
  } else {
    tip.hidden = true;
  }
});

// 단어 설명(마우스를 올리면): 이름 + 쓸 수 있는 대상 모드 그림(효과) 또는 늘려 주는 것(수식)
const MOD_TIP = { BIG: ['near', 'fire', 'up'], STRONG: ['push', 'weight', 'boom'], COLD: ['water', 'arrow', 'snow'] };
function wordTip(word) {
  const w = WORDS[word];
  const what = w.kind === KIND.EFFECT
    ? MODE_ORDER.map((m) => `<span class="${w.modes.includes(m) ? '' : 'off'}">${icon(MODE_ICON[m])}</span>`).join('')
    : `${icon('plus')}${(MOD_TIP[word] || []).map((n) => icon(n)).join('')}`;
  return `<b>${W(word, 1, true)}</b><div class="tip-row">${what}</div>`;
}

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
  if (e.code === 'KeyM') toast(`${icon('sound')}${sfx.toggle() ? icon('no') : icon('ok')}`, 'info');
}

// '처음 해보기' 안내: 기획서의 기본 흐름(단어 발견 → 주문 구성 → 시험·교환 → 함께 도착)으로 이끈다.
// 글 대신 그림 순서로 보여 준다. 반환: { step(1~5, 0=목표), html }
function guideStep(ps) {
  if (S.latest?.g?.c) return null;
  const I = inv();
  const ew = ps.e && tokenWord(ps.e);
  const to = icon('arrow');
  if (!ew) {
    const hasEffect = I.slots.some((x) => x && WORDS[x.word].kind === KIND.EFFECT);
    return { step: 1, html: hasEffect ? `${key('1~9')}${to}${icon('hand')}` : `${icon('walk')}${to}${icon('leaf')}` };
  }
  if (!S.did.cast) return { step: 1, html: `${icon('mouseL')}${W(ew)}${to}${icon('people')} / ${icon('gift')}` };
  if (!S.did.mode) return { step: 2, html: `${key('F')}${icon('aim')}${to}${icon('self')}${to}${icon('near')}` };
  if (!S.did.pickup) return { step: 3, html: `${icon('eye')}${icon('leaf')}${to}${icon('walk')}` };
  const looseMod = I.slots.some((x) => x && WORDS[x.word].kind === KIND.MOD);
  if (!S.did.attach && looseMod) return { step: 4, html: `${key('E')}${icon('bag')}${to}${key('Shift')}+${icon('mouseL')}${to}${icon('big')}${icon('strong')}` };
  if (!S.did.share) return { step: 5, html: `${key('1~9')}${key('Q')}${icon('throw')}${to}${icon('people')}` };
  return { step: 0, html: `${icon('gift')}+${icon('people')}${to}${icon('flag')} ${icon('clock')}${TUNING.goalHoldTime}s` };
}

function updateHud(frame) {
  const ps = mySnap();
  if (!ps) return;
  syncInventory(ps);
  if (S.editorOpen) renderBag();
  const gs = S.guideOff ? null : guideStep(ps);
  const ghtml = gs ? `${gs.step ? `<span class="dots">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= gs.step ? 'on' : ''}"></i>`).join('')}</span>` : ''}${gs.html}${key('H')}` : '';
  if ($('guide').dataset.html !== ghtml) {
    $('guide').dataset.html = ghtml;
    $('guide').dataset.step = gs ? gs.step : '';
    $('guide').innerHTML = ghtml;
    $('guide').hidden = !gs;
  }
  // 대상 모드(기호 3개 중 지금 것)와 시점, 현재 주문(효과 + 수식 중첩)
  const modes = MODE_ORDER.map((m) => `<span class="${m === S.mode ? 'on' : ''}" data-mode="${m}" title="${MODE_LABEL[m]}">${icon(MODE_ICON[m])}</span>`).join('');
  if ($('mode-chips').dataset.html !== modes) { $('mode-chips').dataset.html = modes; $('mode-chips').innerHTML = modes; }
  const viewHtml = `${icon('eye')}${S.view === 'first' ? 1 : 3}${key('V')}`;
  if ($('view-chip').dataset.html !== viewHtml) { $('view-chip').dataset.html = viewHtml; $('view-chip').innerHTML = viewHtml; }
  const ew = ps.e && tokenWord(ps.e);
  const chips = MOD_IDS.filter((id) => ps.mc?.[id] > 0)
    .map((id) => `<span class="word mod">${icon(EFFECT_ICON[id])}${WORDS[id].label}${ps.mc[id] > 1 ? ` ×${ps.mc[id]}` : ''}</span>`);
  chips.push(ew ? `<span class="word action">${icon(EFFECT_ICON[ew])}${WORDS[ew].label}</span>` : `<span class="word action empty">${icon('hand')}?</span>`);
  const html = chips.join(`<span class="plus-sm">${icon('plus')}</span>`);
  if ($('spell-line').dataset.html !== html) {
    $('spell-line').innerHTML = html;
    $('spell-line').dataset.html = html;
  }

  const cdLeft = Math.max(0, ps.cd - (performance.now() / 1000 - S.latestAt));
  setWidth($('cooldown-bar'), `${Math.round((1 - cdLeft / TUNING.castCooldown) * 100)}%`);

  // 미리보기: 기호 + 사람 동그라미 위주로 짧게. 상태 이름은 data-k로(테스트·스타일용)
  const pv = frame.preview;
  const note = $('preview-note');
  let chCls = '';
  const ch = { set className(v) { chCls = v; } };
  const setNote = (h, cls, k = '') => {
    if (note.dataset.html !== h) { note.innerHTML = h; note.dataset.html = h; }
    setClass(note, `preview-note ${cls}`);
    setDom(note, 'k', k, (x) => { note.dataset.k = x; });
  };
  const to = icon('arrow');
  if (S.editorOpen) setNote(`${icon('bag')}${icon('stop')} ${key('E')}`, '', 'bag');
  else if (!pv) setNote('', '');
  else if (pv.kind === 'none') { setNote(reasonHTML(pv.reason), 'bad', 'none'); ch.className = 'bad'; }
  else if (pv.kind === 'mode') { setNote(modeHTML(ew, S.mode), 'bad', 'mode'); ch.className = 'bad'; }
  else if (pv.kind === 'holding') {
    const stuck = ps.hold.filter((id) => frame.bodies.get(id)?.hv);
    if (stuck.length) setNote(`${icon('lift')}${stuck.map(P).join('')} ${icon('weight')}${to}${icon('people')} · ${END_CAST_IC}${icon('stop')}`, 'bad', 'heavy');
    else setNote(`${icon('lift')}${ps.hold.map(P).join('')} · ${icon('eye')}${icon('swap')} · ${END_CAST_IC}${icon('stop')}`, 'ok', 'holding');
    ch.className = 'ok';
  }
  else if (pv.kind === 'fire') { setNote(`${icon('fire')}${to}${icon('aim')}`, '', 'fire'); ch.className = 'fire'; }
  else if (pv.kind === 'firering') { setNote(`${icon('fire')}×4 ${icon('near')}`, '', 'firering'); ch.className = 'fire'; }
  else if (pv.kind === 'water') { setNote(`${icon('water')}${to}${icon('aim')}`, '', 'water'); ch.className = 'fire'; }
  else if (pv.kind === 'waterring') { setNote(`${icon('water')}×4 ${icon('near')}`, '', 'waterring'); ch.className = 'fire'; }
  else if (pv.kind === 'wash') { setNote(`${icon('water')}${to}${icon('self')}${icon('slow')}${icon('no')}`, '', 'wash'); ch.className = 'fire'; }
  else if (pv.kind === 'blast') { setNote(`${icon('fire')}${icon('self')}${to}${icon('up')} · ${icon('near')}${icon('boom')}`, '', 'blast'); ch.className = 'fire'; }
  else if (pv.effect === 'PULL' && S.mode === 'AIM' && pv.res.selection.selected[0]?.type === 'static' && !pv.res.reason) {
    setNote(`${icon('wall')}${icon('pull')}${P(S.me)}`, 'ok', 'anchor');
    ch.className = 'ok';
  }
  else if (pv.ok.size) {
    const ids = [...pv.ok];
    const label = (id) => {
      const v = frame.bodies.get(id);
      if (pv.heavy.has(id)) return `${P(id)}${icon('weight')}${icon('people')}`;
      // 세계의 성질: 당기면 뽑혀 나올 단어, 때리면 떨어질 단어를 미리 보여 준다
      const tr = traitsOf(BODY_DEF.get(id)?.kind);
      if (pv.effect === 'PULL' && tr.source && v?.st !== 0) return `${P(id)}${icon('arrow')}${W(tr.source)}`;
      if ((pv.effect === 'PUSH' || pv.effect === 'PULL') && tr.breakable) return `${P(id)}${icon('arrow')}${W('BIG')}`;
      if (v?.h?.length) return `${P(id)}${icon('people')}`;
      return P(id);
    };
    const allHeavy = pv.heavy.size && ids.every((id) => pv.heavy.has(id));
    setNote(`${icon(EFFECT_ICON[pv.effect])}${to}${ids.map(label).join('')}`, allHeavy ? 'bad' : 'ok', allHeavy ? 'heavy' : 'ok');
    if (S.mode === 'AIM') ch.className = 'ok';
  } else {
    setNote(reasonHTML(pv.res.reason), 'bad', 'reason');
    if (S.mode === 'AIM') ch.className = pv.res.selection.selected[0]?.type === 'static' ? 'blocked' : 'bad';
  }

  // 상태 표시(PEAK처럼 아래 가운데 막대 옆에 기호로)
  const me = frame.bodies.get(S.me);
  const badges = [];
  if (me?.h?.length) badges.push(`<span class="badge float">${icon('lift')}${me.h.map(P).join('')}${key('R')}</span>`);
  if (me?.d > 0) badges.push(`<span class="badge ext">${icon('slow')}${me.d.toFixed(1)}</span>`);
  if (me?.i > 0) badges.push(`<span class="badge shield">${icon('shield')}${me.i.toFixed(1)}</span>`);
  for (const id of SEAT_IDS) {
    const ob = id !== S.me && frame.bodies.get(id);
    if (ob?.i > 0) badges.push(`<span class="badge shield">${icon('shield')}${P(id)}</span>`);
  }
  const bh = badges.join('');
  if ($('badges').dataset.html !== bh) { $('badges').dataset.html = bh; $('badges').innerHTML = bh; }

  updateHotbar();

  // 도착 구역: 짐(선물 상자) + 접속한 모든 사람
  const g = S.latest.g;
  const keys = Object.keys(g.in);
  const items = $('goal-items');
  if (items.dataset.keys !== keys.join()) {
    items.dataset.keys = keys.join();
    items.innerHTML = keys.map((k) => (k === 'cargo' ? `<span class="gi" data-k="cargo">${icon('gift')}</span>` : `<span class="gi pl" data-k="${esc(k)}">${P(k)}</span>`)).join('');
  }
  for (const el of items.children) el.classList.toggle('in', !!g.in[el.dataset.k]);
  setWidth($('goal-fill'), `${Math.round(Math.min(1, g.t / TUNING.goalHoldTime) * 100)}%`);
  setHidden($('clear-banner'), !g.c);
  if (g.c && !$('clear-stats').dataset.done) { $('clear-stats').innerHTML = S.stats.html(pc); $('clear-stats').dataset.done = '1'; }
  if (!g.c && $('clear-stats').dataset.done) { $('clear-stats').innerHTML = ''; $('clear-stats').dataset.done = ''; }
  setHidden($('lock-hint'), S.locked || S.editorOpen);
  setClass($('crosshair'), chCls);
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

// 1인칭 손에 보여 줄 것: 손에 든 효과 단어, 들기 유지(무거워 버둥거림), 걷기
function handState(bodies, me) {
  const ps = mySnap();
  const hold = ps?.hold || [];
  return {
    word: ps?.e ? tokenWord(ps.e) : null,
    holding: hold.length > 0,
    strained: hold.some((id) => bodies.get(id)?.hv),
    speed: me.speed,
    grounded: me.g,
  };
}

// 내 몸을 예측 위치로 바꾸고(들려 있으면 보간 그대로), 내가 든 물체도 같은 만큼 앞당긴다.
function predictSelf(view, interpMe, dt) {
  // 내가 (직접·간접으로) 들어 올린 것. 무거워 못 들고 붙잡기만 한 것(hv)은 제자리에 있으니 부딪히는 물체로 둔다
  const held = new Set(holdingChain(S.me).filter((id) => !view.get(id)?.hv));
  const colliders = [];
  for (const [id, v] of view) if (id !== S.me && !held.has(id) && !traitsOf(BODY_DEF.get(id).kind).ghost) colliders.push({ id, pos: v.p, half: halfOf(id, v) });
  predictor.rtt = S.rtt;
  const r = predictor.present(performance.now() / 1000, dt, {
    colliders,
    half: BODY_DEF.get(S.me).size.map((x) => x / 2),
    fallback: interpMe.p,
    enabled: S.predict && !interpMe.h?.length,
  });
  const me = { ...interpMe, p: r.p };
  if (r.predicted) {
    me.speed = Math.hypot(r.v[0], r.v[2]);
    me.g = r.g ? 1 : 0;
  }
  view.set(S.me, me);
  const delta = r.p.map((x, i) => x - interpMe.p[i]);
  for (const id of held) {
    const b = view.get(id);
    if (b) view.set(id, { ...b, p: b.p.map((x, i) => x + delta[i]) });
  }
  return me;
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
      bodies: new Map(LEVEL.bodies.map((d) => [d.id, { p: [d.pos[0], d.pos[1] + d.size[1] / 2, d.pos[2]], y: 0, i: 0, d: 0, g: 1, speed: 0, hp: d.kind === 'dummy' ? TUNING.dummyHp : undefined, st: 1, lit: d.kind === 'campfire' ? 1 : undefined }])),
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

  // bodies: 호스트와 같은 시점(보간) — 미리보기 판정용. view: 그릴 상태(내 몸·내가 든 물체는 예측으로 앞당김)
  const bodies = interpolated();
  if (!bodies.get(S.me)) return;
  const view = new Map(bodies);
  const me = predictSelf(view, bodies.get(S.me), dt);
  const rig = rigFor(S.view, me.p, S.yaw, S.pitch);
  const preview = S.editorOpen ? null : buildPreview(bodies, rig);
  const f = {
    bodies: view,
    tokens: S.tokensView || S.latest.k,
    me: S.me,
    preview,
    nearby: (S.mode === 'NEAR' && preview?.radius) || (preview?.kind === 'blast' ? preview.radius : 0),
    projectiles: S.projectiles,
    pickable: nearestPickable(view),
    camera: { pos: rig.pos, look: rig.look },
    cleared: S.latest.g.c,
    first: S.view === 'first',
    hand: handState(view, me),
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
  get view() { return { yaw: S.yaw, pitch: S.pitch, mode: S.view }; },
  get rtt() { return S.rtt; },
  setPredict(on) { S.predict = !!on; },
  get selfError() { const p = S.frame?.bodies.get(S.me)?.p; const q = S.latest?.b.find((x) => x.id === S.me)?.p; return p && q ? Math.hypot(p[0] - q[0], p[2] - q[2]) : null; },
  setCamera(v) { S.view = v === 'third' ? 'third' : 'first'; },
  reasonHTML,
  REASON,
  get guideStep() { return $('guide').hidden ? null : Number($('guide').dataset.step); },
  get previewKind() { return $('preview-note').dataset.k; },
  get recent() { return S.recent; },
  send,
  cast,
  setView(yaw, pitch) { S.yaw = yaw; S.pitch = pitch; },
  aimAt(id) {
    for (let i = 0; i < 6; i++) {
      const me = S.frame?.bodies.get(S.me);
      const tg = S.frame?.bodies.get(id);
      if (!me || !tg) return false;
      const rig = rigFor(S.view, me.p, S.yaw, S.pitch);
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
  hold(code, on) { if (on) S.keys.add(code); else S.keys.delete(code); moveKeyChanged(code); },
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
  summaryText: () => S.stats.text(),
  renderInfo() {
    const i = renderer.renderer.info;
    const c = { mesh: 0, sprite: 0, line: 0, inst: 0, shadow: 0 };
    renderer.scene.traverseVisible((o) => { if (o.isInstancedMesh) c.inst++; else if (o.isMesh) { c.mesh++; if (o.castShadow) c.shadow++; } else if (o.isSprite) c.sprite++; else if (o.isLine) c.line++; });
    return { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length, ...c };
  },
  selectSlot(i) { inv().select(i); },
  throwSelected() { throwFromSlot(inv().sel, false); },
  get hotbar() { const I = inv(); return I.slots.slice(0, HOTBAR).map((x, i) => (x ? { i, word: x.word, n: x.tokens.length, sel: i === I.sel } : null)); },
  get dragging() { return drag ? drag.targets.length : 0; },
  get bag() { const I = inv(); return { slots: I.slots.map((x) => (x ? { word: x.word, n: x.tokens.length } : null)), mods: [...I.mods], sel: I.sel, cursor: I.cursor ? { word: I.cursor.word, n: I.cursor.tokens.length } : null }; },
};
