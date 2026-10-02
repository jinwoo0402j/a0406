// 조준 미리보기(표시 전용): 지금 시전하면 무엇에 걸리는지. 호스트와 같은 판정 함수(shared/targeting.js)를 쓴다.
// 입력: ps = 내 스냅숏(e·mc·hold), effect = 손에 든 효과 단어, mode = 대상 모드, me = 내 자리,
//       players = 스냅숏의 사람별 상태, bodies = Map(id → 보간 위치 등), rig = 조준선, defs = Map(id → 사물 정의)
import { LEVEL } from '../shared/level.js';
import { TUNING, modFactor } from '../shared/tuning.js';
import { WORDS, traitsOf } from '../shared/words.js';
import { resolveTargets, modeUnsupported, REASON, liftShare } from '../shared/targeting.js';

// pid가 직접·간접으로 들고 있는 것들(서버 holdingChain과 같은 규칙)
export function holdingChainOf(players, pid) {
  const out = new Set();
  const stack = [pid];
  while (stack.length) {
    for (const id of players?.[stack.pop()]?.hold || []) {
      if (out.has(id)) continue;
      out.add(id);
      if (players[id]) stack.push(id);
    }
  }
  return [...out];
}

export function buildPreview({ ps, effect: ew, mode, me, players, bodies, rig, defs }) {
  if (!ps || !rig) return null;
  const none = { ok: new Set(), bad: new Set() };
  if (!ew) return { kind: 'none', reason: REASON.NO_EFFECT, ...none };
  if (!WORDS[ew].modes.includes(mode)) return { kind: 'mode', reason: modeUnsupported(ew, mode), ...none };
  if (ps.hold?.length) return { kind: 'holding', ok: new Set(ps.hold), bad: new Set() };
  const mc = ps.mc || {};
  if (ew === 'FIREBALL') {
    if (mode === 'SELF') return { kind: 'blast', radius: TUNING.fireballBlastRadius * modFactor(TUNING, mc, 'BIG', 'blastRadius'), ...none };
    return { kind: mode === 'NEAR' ? 'firering' : 'fire', ...none };
  }
  if (ew === 'WATER') return { kind: mode === 'SELF' ? 'wash' : mode === 'NEAR' ? 'waterring' : 'water', ...none };
  const world = {
    statics: LEVEL.statics,
    bodies: [...bodies].map(([id, v]) => {
      const d = defs.get(id);
      return {
        id, kind: d.kind, pos: v.p, half: d.size.map((x) => (x / 2) * (v.sc || 1)), mass: d.mass ?? 1,
        traits: traitsOf(d.kind),
        immune: v.i > 0, heldBy: v.h || [], holding: players?.[id] ? holdingChainOf(players, id) : [], empty: v.st === 0,
      };
    }),
  };
  const aim = { origin: rig.pos, dir: rig.dir };
  let res;
  let radius = 0;
  const heavy = new Set();
  if (ew === 'PUSH' || ew === 'PULL' || ew === 'FIRE' || ew === 'STEAM') {
    const reach = modFactor(TUNING, mc, 'BIG', { PUSH: 'pushReach', PULL: 'pullReach', FIRE: 'fireReach', STEAM: 'steamReach' }[ew]);
    radius = TUNING.nearbyRadius * reach;
    res = resolveTargets(mode, ew, world, me, aim, { range: TUNING.aimedMaxRange * reach, radius, ghosts: ew === 'PULL' });
  } else {
    const capacity = TUNING.liftCapacity * modFactor(TUNING, mc, 'STRONG', 'liftCapacity');
    if (mode === 'NEAR') {
      // 서버와 같은 규칙: 가벼운 것부터, 나눠 든 무게의 합이 힘 안에 들 때까지
      radius = TUNING.nearbyRadius * modFactor(TUNING, mc, 'BIG', 'liftReach');
      res = resolveTargets('NEAR', 'LIFT', world, me, aim, { radius, capacity, load: 0 });
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
      res = resolveTargets('AIM', 'LIFT', world, me, aim, { range: TUNING.liftRange });
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
