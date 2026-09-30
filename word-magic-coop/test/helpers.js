import { Game } from '../server/game.js';

export const DT = 1 / 60;

export function newGame() {
  const g = new Game();
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

export const body = (g, id) => g.body(id);
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

export function cast(g, casterId, targetId = null, dir = null) {
  const c = g.body(casterId).pos;
  const aim = targetId ? aimAt(g, casterId, targetId) : { origin: [...c], dir: dir || [0, 0, 1] };
  return g.handle(casterId, { t: 'cast', ...aim });
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

export function equip(g, pid, slot, token) {
  return g.handle(pid, { t: 'equip', slot, token });
}

// 토큰이 모두 존재하고(2명이면 6개) 각 토큰이 월드 또는 한 사람의 인벤토리 중 정확히 한 곳에만 있는지
export function assertTokenInvariant(assert, g, expected = 6) {
  assert.equal(g.tokens.length, expected);
  const ids = new Set(g.tokens.map((t) => t.id));
  assert.equal(ids.size, expected);
  for (const t of g.tokens) {
    const inWorld = !!t.pos;
    const owned = !!t.owner;
    assert.ok(inWorld !== owned, `토큰 ${t.id}는 월드 또는 인벤토리 한 곳에만 있어야 한다`);
  }
  for (const pid of g.seats) {
    for (const slot of ['target', 'action']) {
      const id = g.players[pid].slots[slot];
      if (id) assert.equal(g.tokens.find((t) => t.id === id).owner, pid, '장착한 토큰은 본인 소유여야 한다');
    }
  }
}
