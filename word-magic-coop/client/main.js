// 클라이언트: 로비 → 접속 → 입력 전송 → 스냅숏 보간 → 렌더링·HUD.
// 게스트/호스트 모두 요청만 보내고, 결과는 호스트의 스냅숏과 이벤트로 반영한다.
import { Renderer } from './render.js';
import { cameraRig, CAM } from './camera.js';
import { FONT_STACK } from './labels.js';
import { LEVEL } from '/shared/level.js';
import { TUNING } from '/shared/tuning.js';
import { WORDS } from '/shared/words.js';
import { resolveSpell } from '/shared/targeting.js';

const $ = (id) => document.getElementById(id);
const NAMES = { A: 'A', B: 'B', rock: '돌', box1: '상자', box2: '상자', cargo: '짐' };
const BODY_DEF = new Map(LEVEL.bodies.map((d) => [d.id, d]));
const SENS = 0.0025;

const S = {
  ws: null,
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

function connect() {
  if (S.ws) return;
  S.phase = 'connecting';
  $('join-btn').disabled = true;
  setLobby('호스트에 접속하는 중…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  S.ws = ws;
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    const was = S.phase;
    console.log(`[net] 연결 종료 code=${e.code} reason=${e.reason || '-'} phase=${was}`);
    S.ws = null;
    S.me = null;
    S.phase = 'lobby';
    $('join-btn').disabled = false;
    updateSeats({ A: false, B: false });
    if (S.closingOnPurpose) { S.closingOnPurpose = false; return; }
    if (was === 'full') return;
    setLobby('호스트와 연결이 끊겼어요.', '호스트 프로그램이 실행 중인지 확인하고 다시 참가하세요.');
  };
}

function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function updateSeats(seats) {
  for (const id of ['A', 'B']) {
    const el = document.querySelector(`.seat-${id}`);
    el.classList.toggle('on', !!seats[id]);
    el.classList.toggle('me', S.me === id);
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome': {
      S.me = m.you;
      S.phase = 'waiting';
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
      setLobby('이미 두 명이 플레이 중이에요.', '이 프로토타입은 정확히 2명만 참가할 수 있어요.');
      break;
    case 'lobby':
      updateSeats(m.seats);
      break;
    case 'start':
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
  S.snaps = [];
  S.latest = null;
  S.offset = null;
  S.yaw = 0;
  S.pitch = -0.08;
  $('lobby').hidden = true;
  $('hud').hidden = false;
  $('log').innerHTML = '';
  $('who-chip').style.background = S.me === 'A' ? 'var(--a)' : 'var(--b)';
  $('who-name').textContent = `플레이어 ${S.me} (나)`;
  log('두 사람이 모였어요! 같은 주문을 친구·돌·상자에 써 보세요.');
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
      f: y.f,
      i: y.i,
      g: y.g,
      speed: jump ? 0 : Math.hypot(y.p[0] - x.p[0], y.p[2] - x.p[2]) / dtS,
    });
  }
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
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1600);
}

const who = (id) => (id === S.me ? '나' : `플레이어 ${id}`);
const whoSubj = (id) => (id === S.me ? '내가' : `플레이어 ${id}가`);
const wlabel = (w) => `「${WORDS[w].label}」`;

function onEvent(e) {
  S.recent.push(e);
  if (S.recent.length > 30) S.recent.shift();
  switch (e.k) {
    case 'cast': {
      const pos = new Map();
      for (const [id, v] of S.frame?.bodies || []) pos.set(id, v.p);
      renderer.castFx(e, pos);
      const names = e.targets.map((id) => (id === S.me ? '나' : NAMES[id]));
      const sentence = `${WORDS[e.target].label} ${WORDS[e.action].label}`;
      log(`${who(e.by)}: 「${sentence}」 → ${names.join(', ')}`);
      break;
    }
    case 'castFail':
      toast(e.reason);
      break;
    case 'pickup':
      log(`${whoSubj(e.by)} ${wlabel(e.word)} 단어를 주웠어요${e.equipped ? ' (바로 장착)' : ''}`);
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
      log('도착 성공! 짐과 두 사람이 함께 도착했어요');
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
  send({ t: 'input', wish, jump });
  S.lastWish = wish.join(',');
  S.lastInputAt = performance.now();
}

function currentRig() {
  const me = S.frame?.bodies.get(S.me);
  if (!me) return null;
  return cameraRig(me.p, S.yaw, S.pitch);
}

function cast() {
  const rig = currentRig();
  if (!rig) return;
  send({
    t: 'cast',
    origin: rig.pos.map((v) => Math.round(v * 1000) / 1000),
    dir: rig.dir.map((v) => Math.round(v * 10000) / 10000),
    vt: Math.round(S.renderTime * 1000) / 1000, // 내가 보고 있던 호스트 시점
  });
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
    if (document.pointerLockElement) document.exitPointerLock();
    S.editorKey = '';
    renderEditor();
  } else {
    requestLock();
  }
}

window.addEventListener('keydown', (e) => {
  if (S.phase !== 'playing') return;
  if (e.code === 'Tab') {
    e.preventDefault();
    toggleEditor();
    return;
  }
  if (e.code === 'Escape' && S.editorOpen) { toggleEditor(false); return; }
  if (e.repeat) return;
  S.keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); sendInput(true); }
  if (e.code === 'KeyE') send({ t: 'pickup' });
  if (e.code === 'KeyR') send({ t: 'release' });
});
window.addEventListener('keyup', (e) => S.keys.delete(e.code));
window.addEventListener('blur', () => S.keys.clear());

$('view').addEventListener('mousedown', (e) => {
  if (S.phase !== 'playing' || S.editorOpen) return;
  if (!S.locked) { requestLock(); return; }
  if (e.button === 0) cast();
});
document.addEventListener('pointerlockchange', () => {
  S.locked = document.pointerLockElement === $('view');
});
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

function renderEditor() {
  const ps = mySnap();
  if (!ps) return;
  const key = JSON.stringify([ps.s, ps.inv]);
  if (key === S.editorKey) return;
  S.editorKey = key;
  for (const slot of ['target', 'action']) {
    const el = $(`ed-slot-${slot}`);
    const w = ps.s[slot] && tokenWord(ps.s[slot]);
    el.textContent = w ? WORDS[w].label : '비어 있음';
    el.classList.toggle('empty', !w);
  }
  const inv = $('inventory');
  inv.innerHTML = '';
  if (!ps.inv.length) {
    inv.innerHTML = '<div class="inv-empty">가진 단어가 없어요. 월드의 단어 근처에서 E를 눌러 주우세요.</div>';
  }
  for (const id of ps.inv) {
    const w = WORDS[tokenWord(id)];
    const equipped = ps.s[w.slot] === id;
    const card = document.createElement('div');
    card.className = `inv-card${equipped ? ' equipped' : ''}`;
    const word = document.createElement('div');
    word.className = `word ${w.slot}`;
    word.textContent = w.label;
    word.title = '누르면 장착';
    word.onclick = () => send({ t: 'equip', slot: w.slot, token: id });
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${w.slot === 'target' ? '대상 지정' : '작용'}${equipped ? ' · 장착 중' : ''}</span>`;
    const drop = document.createElement('button');
    drop.className = 'ghost';
    drop.type = 'button';
    drop.textContent = '내려놓기';
    drop.onclick = () => send({ t: 'drop', token: id });
    meta.append(drop);
    card.append(word, meta);
    inv.append(card);
  }
}

for (const b of document.querySelectorAll('[data-unequip]')) {
  b.onclick = () => send({ t: 'equip', slot: b.dataset.unequip, token: null });
}
$('close-editor').onclick = () => toggleEditor(false);
$('restart-btn').onclick = () => {
  if (confirm('두 사람 모두 처음 상태(위치·단어·슬롯·효과)로 돌아가요. 다시 시작할까요?')) {
    send({ t: 'restart' });
    toggleEditor(false);
  }
};
$('join-btn').onclick = () => connect();
// 편집창 버튼에 포커스가 남으면 Space 등으로 다시 눌릴 수 있으므로 클릭 후 포커스를 푼다.
$('editor').addEventListener('click', () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

// ------------------------------------------------------------------ 프레임
function buildPreview(bodies, rig) {
  const ps = mySnap();
  if (!ps || !rig) return null;
  const tw = ps.s.target && tokenWord(ps.s.target);
  const aw = ps.s.action && tokenWord(ps.s.action);
  if (!tw || !aw) return { incomplete: true, ok: new Set(), bad: new Set() };
  const world = {
    statics: LEVEL.statics,
    bodies: [...bodies].map(([id, v]) => {
      const d = BODY_DEF.get(id);
      return {
        id, kind: d.kind, pos: v.p, half: d.size.map((x) => x / 2),
        traits: { movable: true, floatable: true }, immune: v.i > 0,
      };
    }),
  };
  const res = resolveSpell(WORDS[tw].rule, WORDS[aw].action, world, S.me, { origin: rig.pos, dir: rig.dir });
  return {
    rule: WORDS[tw].rule,
    res,
    ok: new Set(res.applicable),
    bad: new Set(res.rejected.filter((r) => r.type === 'body').map((r) => r.id)),
  };
}

function updateHud(frame) {
  const ps = mySnap();
  if (!ps) return;
  const tw = ps.s.target && tokenWord(ps.s.target);
  const aw = ps.s.action && tokenWord(ps.s.action);
  const st = $('slot-target');
  const sa = $('slot-action');
  st.textContent = tw ? WORDS[tw].label : '[대상 지정]';
  sa.textContent = aw ? WORDS[aw].label : '[작용]';
  st.classList.toggle('empty', !tw);
  sa.classList.toggle('empty', !aw);

  const cdLeft = Math.max(0, ps.cd - (performance.now() / 1000 - S.latestAt));
  $('cooldown-bar').style.width = `${(1 - cdLeft / TUNING.castCooldown) * 100}%`;

  const pv = frame.preview;
  const note = $('preview-note');
  const ch = $('crosshair');
  ch.className = '';
  if (!pv || pv.incomplete) {
    note.textContent = 'Tab에서 두 슬롯을 채우세요';
    note.className = 'preview-note bad';
  } else if (pv.ok.size) {
    const names = [...pv.ok].map((id) => (id === S.me ? '나' : NAMES[id]));
    note.textContent = `적용 대상: ${names.join(', ')}`;
    note.className = 'preview-note ok';
    if (pv.rule === 'AIMED') ch.className = 'ok';
  } else {
    note.textContent = pv.res.reason;
    note.className = 'preview-note bad';
    if (pv.rule === 'AIMED') ch.className = pv.res.selection.selected[0]?.type === 'static' ? 'blocked' : 'bad';
  }

  // 상태 표시
  const me = frame.bodies.get(S.me);
  const badges = [];
  if (me?.f > 0) badges.push(`<span class="badge float">떠 있음 ${me.f.toFixed(1)}초</span>`);
  if (me?.i > 0) badges.push(`<span class="badge shield">보호 중 ${me.i.toFixed(1)}초</span>`);
  const other = S.me === 'A' ? 'B' : 'A';
  const ob = frame.bodies.get(other);
  if (ob?.i > 0) badges.push(`<span class="badge shield">${other} 보호 중</span>`);
  $('badges').innerHTML = badges.join('');

  // 줍기 안내
  const pr = $('prompt');
  if (frame.pickable) {
    const t = S.latest.k.find((x) => x.id === frame.pickable);
    pr.textContent = `E  ${wlabel(t.w)} 줍기`;
    pr.classList.add('show');
  } else {
    pr.classList.remove('show');
  }

  // 도착 구역
  const g = S.latest.g;
  for (const el of document.querySelectorAll('.goal-items span')) el.classList.toggle('in', !!g.in[el.dataset.k]);
  $('goal-fill').style.width = `${Math.min(1, g.t / TUNING.goalHoldTime) * 100}%`;
  $('clear-banner').hidden = !g.c;
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
      bodies: new Map(LEVEL.bodies.map((d) => [d.id, { p: [d.pos[0], d.pos[1] + d.size[1] / 2, d.pos[2]], y: 0, f: 0, i: 0, g: 1, speed: 0 }])),
      tokens: LEVEL.tokens.filter((x) => x.pos).map((x) => ({ id: x.id, w: x.word, p: x.pos })),
      me: null,
      camera: { pos: [Math.sin(a) * 26, 16, 16 + Math.cos(a) * 26], look: [0, 0, 16] },
    }, dt, t);
    return;
  }

  // 입력 전송: 바뀌었거나 주기적으로
  const wish = wishVector().map((v) => Math.round(v * 1000) / 1000).join(',');
  if (wish !== S.lastWish || nowMs - S.lastInputAt > 100) sendInput(false);

  const bodies = interpolated();
  const me = bodies.get(S.me);
  if (!me) return;
  const rig = cameraRig(me.p, S.yaw, S.pitch);
  const preview = S.editorOpen ? null : buildPreview(bodies, rig);
  const f = {
    bodies,
    tokens: S.latest.k,
    me: S.me,
    preview,
    nearby: preview?.rule === 'NEARBY',
    pickable: nearestPickable(bodies),
    camera: { pos: rig.pos, look: rig.look },
    cleared: S.latest.g.c,
  };
  S.frame = f;
  renderer.render(f, dt, t);
  updateHud(f);
  if (S.editorOpen) renderEditor();
}

// ------------------------------------------------------------------ 시작
async function boot() {
  try {
    await Promise.race([document.fonts.load(`48px ${FONT_STACK}`), new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* 글꼴이 없으면 시스템 글꼴 사용 */ }
  renderer = new Renderer($('view'));
  requestAnimationFrame(frame);
  if (new URLSearchParams(location.search).has('autojoin')) connect();
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
};
