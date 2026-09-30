import { Game } from '../server/game.js';
import { KIND, WORDS } from '../shared/words.js';

export const DT = 1 / 60;

export function newGame(opts) {
  const g = new Game(opts);
  run(g, 0.2); // 착지
  return g;
}

export function run(g, seconds, perTick) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    perTick?.();
    g.step(DT);
  }
}

export const bottom = (b) => b.pos[1] - b.half[1];

export function place(g, id, [x, y, z]) {
  const b = g.body(id);
  b.pos = [x, y + b.half[1], z];
  b.vy = 0;
  b.ext = [0, 0];
  b.inVel = [0, 0];
}

// 시전자 중심에서 대상 중심을 향하는 조준선
export function aimAt(g, casterId, targetId) {
  const c = g.body(casterId).pos;
  const t = g.body(targetId).pos;
  return { origin: [...c], dir: [t[0] - c[0], t[1] - c[1], t[2] - c[2]] };
}

// 시전: 대상을 주면 조준 대상 모드, 없으면 opts.mode(기본 본인)
export function cast(g, casterId, targetId = null, { mode, dir } = {}) {
  const c = g.body(casterId).pos;
  const aim = targetId ? aimAt(g, casterId, targetId) : { origin: [...c], dir: dir || [0, 0, 1] };
  return g.handle(casterId, { t: 'cast', mode: mode || (targetId ? 'AIM' : 'SELF'), ...aim });
}

// 월드의 단어를 줍는다(그 자리로 가서 E)
export function grab(g, pid, tokenId) {
  const t = g.token(tokenId);
  place(g, pid, [t.pos[0], t.pos[1], t.pos[2] - 0.5]);
  run(g, 0.1);
  return g.handle(pid, { t: 'pickup' });
}

// 지정한 수평 위치까지 걸어간다(입력 메시지만 사용).
export function walkTo(g, pid, [x, z], { tol = 0.25, max = 20 } = {}) {
  const b = g.body(pid);
  for (let i = 0; i < max / DT; i++) {
    const dx = x - b.pos[0];
    const dz = z - b.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < tol) break;
    const s = Math.min(1, d / 0.6);
    g.handle(pid, { t: 'input', wish: [(dx / d) * s, (dz / d) * s] });
    g.step(DT);
  }
  g.handle(pid, { t: 'input', wish: [0, 0] });
  run(g, 0.15);
  return Math.hypot(x - b.pos[0], z - b.pos[2]);
}

// 들고 있는 사람의 시선을 point 쪽으로 돌린다(입력 메시지의 aim·wish만 사용)
export function lookAt(g, pid, point, wish = [0, 0]) {
  const c = g.body(pid).pos;
  const eye = [c[0], c[1] + g.T.liftEye, c[2]];
  g.handle(pid, { t: 'input', wish, aim: point.map((v, i) => v - eye[i]) });
}

// 토큰이 모두 존재하고 각 토큰이 월드 또는 한 사람의 인벤토리 중 정확히 한 곳에만 있는지,
// 장착한 단어는 모두 본인 소유인지
export function assertTokenInvariant(assert, g, expected) {
  assert.equal(g.tokens.length, expected);
  assert.equal(new Set(g.tokens.map((t) => t.id)).size, expected);
  for (const t of g.tokens) assert.ok(!!t.pos !== !!t.owner, `토큰 ${t.id}는 월드 또는 인벤토리 한 곳에만 있어야 한다`);
  for (const pid of g.seats) {
    const s = g.players[pid].slots;
    if (s.effect) {
      const t = g.token(s.effect);
      assert.equal(t.owner, pid);
      assert.equal(WORDS[t.word].kind, KIND.EFFECT);
    }
    for (const id of s.mods) assert.equal(g.token(id).owner, pid, '장착한 수식은 본인 소유');
  }
}
