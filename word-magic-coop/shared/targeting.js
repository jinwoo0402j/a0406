// 대상 모드("누구에게")와 효과의 적용 가능 여부("그 대상이 받을 수 있는가")를 분리한다.
// 서버 판정과 클라이언트 미리보기(조준 표시)가 같은 함수를 사용해 표시와 판정을 일치시킨다.
//
// world 형태:
//   statics: [{ id, min, max }]                    — 정적 지형(속성 없음)
//   bodies:  [{ id, kind, pos(중심), half, mass, traits, immune(bool), heldBy: [드는 사람], holding: [드는 물체] }]

import { TUNING } from './tuning.js';
import { TRAIT, WORDS, MODE_LABEL } from './words.js';
import { boxOfBody, rayBox, dist, segmentBlocked, normalize } from './geom.js';

export const REASON = {
  NO_EFFECT: '효과 단어를 장착하세요 (Tab)',
  COOLDOWN: '아직 재사용 대기 중이에요',
  NO_TARGET: '조준선에 대상이 없어요',
  OUT_OF_RANGE: '너무 멀어요',
  NOTHING_NEARBY: '주변에 대상이 없어요',
  TERRAIN: '고정된 지형에는 쓸 수 없어요',
  NOT_MOVABLE: '움직일 수 없는 대상이에요',
  NOT_LIFTABLE: '들 수 없는 대상이에요',
  TOO_HEAVY: '너무 무거워서 들 수 없어요 (<세게>를 붙이거나 친구와 같이 들어요)',
  ALREADY_HELD: '이미 들고 있어요',
  HOLDING_YOU: '나를 들고 있는 사람은 들 수 없어요',
  HEAVY_GRAB: '혼자서는 무거워서 안 올라가요 · 친구가 같이 들거나 <세게>를 붙이세요',
  STANDING_ON: '딛고 서 있는 물체는 들 수 없어요',
  PROTECTED: '보호 중인 대상이에요',
  BAD_AIM: '조준 정보가 올바르지 않아요',
  NOT_PLAYING: '게임이 진행 중이 아니에요',
  SUSTAINING: '유지 중인 마법이 있어요 · 시전 종료로 먼저 끝내세요',
};

export function modeUnsupported(effectId, mode) {
  return `<${WORDS[effectId].label}>은(는) ${MODE_LABEL[mode]} 모드로 쓸 수 없어요 (F로 모드 전환)`;
}

// 선택 결과: { selected: [{ type: 'body'|'static', id }], reason? }
// opts.range: 조준 대상 최대 거리, opts.radius: 주변 반경
export function selectTargets(mode, world, casterId, aim, opts = {}, tuning = TUNING) {
  const range = opts.range ?? tuning.aimedMaxRange;
  const radius = opts.radius ?? tuning.nearbyRadius;
  const caster = world.bodies.find((b) => b.id === casterId);
  if (!caster) return { selected: [], reason: REASON.NOT_PLAYING };

  if (mode === 'SELF') return { selected: [{ type: 'body', id: casterId }] };

  if (mode === 'AIM') {
    if (!aim) return { selected: [], reason: REASON.BAD_AIM };
    const dir = normalize(aim.dir);
    let best = null;
    for (const s of world.statics) {
      const t = rayBox(aim.origin, dir, s, tuning.aimRayLength);
      if (t !== null && (!best || t < best.t)) best = { t, type: 'static', id: s.id };
    }
    for (const b of world.bodies) {
      if (b.id === casterId) continue; // 시전자 자신 제외
      const t = rayBox(aim.origin, dir, boxOfBody(b), tuning.aimRayLength);
      if (t !== null && (!best || t < best.t)) best = { t, type: 'body', id: b.id, ref: b };
    }
    if (!best) return { selected: [], reason: REASON.NO_TARGET };
    if (best.type === 'static') {
      // 벽에 막히면 그 뒤를 찾지 않는다. 지형은 선택되지만 효과를 받지 못한다.
      const hit = aim.origin.map((o, i) => o + dir[i] * best.t);
      if (dist(hit, caster.pos) > range) return { selected: [], reason: REASON.NO_TARGET };
      return { selected: [{ type: 'static', id: best.id }], hitPoint: hit };
    }
    if (dist(best.ref.pos, caster.pos) > range) return { selected: [], reason: REASON.OUT_OF_RANGE, outOfRange: best.id };
    return { selected: [{ type: 'body', id: best.id }] };
  }

  if (mode === 'NEAR') {
    const selected = [];
    for (const b of world.bodies) {
      if (b.id === casterId) continue;
      if (dist(b.pos, caster.pos) > radius) continue;
      if (segmentBlocked(caster.pos, b.pos, world.statics)) continue;
      selected.push({ type: 'body', id: b.id });
    }
    if (!selected.length) return { selected, reason: REASON.NOTHING_NEARBY };
    return { selected };
  }

  return { selected: [], reason: REASON.BAD_AIM };
}

// 효과별 적용 불가 이유. 적용 가능하면 null. opts.capacity: 들기 힘, opts.casterGround: 시전자가 딛고 선 물체
// opts.load: 이번 시전에서 이미 나눠 들기로 한 무게(주변 들기에서 여러 개를 고를 때)
export function applicability(effect, entity, casterId, opts = {}) {
  // <당기기>는 지형을 조준하면 시전자가 그쪽으로 끌려간다(조준 모드에서만 지형이 선택된다)
  if (entity.type === 'static') return effect === 'PULL' ? null : REASON.TERRAIN;
  if (!entity.body) return REASON.TERRAIN;
  const b = entity.body;
  // 보호 상태는 "다른 플레이어가 거는" 마법만 막는다. 자기 시전은 구분한다.
  if (b.kind === 'player' && b.id !== casterId && b.immune) return REASON.PROTECTED;
  if (effect === 'PUSH' || effect === 'PULL') return b.traits?.[TRAIT.MOVABLE] ? null : REASON.NOT_MOVABLE;
  if (effect === 'LIFT') {
    if (!b.traits?.[TRAIT.LIFTABLE]) return REASON.NOT_LIFTABLE;
    const holders = b.heldBy || [];
    if (holders.includes(casterId)) return REASON.ALREADY_HELD;
    if (b.holding?.includes(casterId)) return REASON.HOLDING_YOU; // 서로 들면 끝없이 올라간다
    if (opts.casterGround && opts.casterGround === b.id) return REASON.STANDING_ON;
    // 같이 들기: 이미 드는 사람이 있으면 무게를 사람 수로 나눠 든다. 합류해도 다른 사람의 부담은 줄기만 한다.
    if (opts.capacity !== undefined && liftShare(b.mass, holders.length + 1) > opts.capacity - (opts.load || 0) + 1e-9) return REASON.TOO_HEAVY;
    return null;
  }
  return null;
}

// 선택 + 적용 가능 여부. 반환: { applicable: [bodyId], rejected: [{id, reason}], reason(아무것도 못 할 때) }
export function resolveTargets(mode, effect, world, casterId, aim, opts = {}, tuning = TUNING) {
  const sel = selectTargets(mode, world, casterId, aim, opts, tuning);
  const applicable = [];
  const rejected = [];
  for (const s of sel.selected) {
    const body = s.type === 'body' ? world.bodies.find((b) => b.id === s.id) : null;
    const why = applicability(effect, { type: s.type, body }, casterId, opts);
    if (why) rejected.push({ id: s.id, type: s.type, reason: why });
    else applicable.push(s.id);
  }
  let reason = null;
  if (!applicable.length) reason = rejected.length ? rejected[0].reason : sel.reason || REASON.NO_TARGET;
  return { applicable, rejected, reason, selection: sel };
}

// ---------------------------------------------------------------- 들기 무게 분담 [제안안]
// 한 물체의 무게는 드는 사람 수로 똑같이 나눈다.
export function liftShare(mass, holderCount) {
  return mass / Math.max(1, holderCount);
}

// 사람마다 나눠 든 무게의 합(부담). bodies: [{ mass, heldBy: [pid] }] → Map(pid → load)
export function liftLoads(bodies) {
  const load = new Map();
  for (const b of bodies) {
    const n = b.heldBy?.length || 0;
    for (const h of b.heldBy || []) load.set(h, (load.get(h) || 0) + liftShare(b.mass, n));
  }
  return load;
}

// 물체가 얼마나 버거운지(0~1). 드는 사람들의 부담/힘 비율의 조화 평균.
// 혼자 하나만 들면 무게/힘, 둘이 나눠 들면 각자의 부담이 줄어 더 높이·빠르게 든다.
export function liftStrain(holders) {
  let sum = 0;
  for (const { load, capacity } of holders) sum += capacity / Math.max(1e-9, load);
  return sum > 0 ? holders.length / sum : 1;
}

// 들기 최대 높이(대상 바닥 기준): 버거울수록 낮게 [임시 공식]. strain = 무게/힘(혼자 들 때)
export function liftMaxBottom(casterBottom, strain, tuning = TUNING) {
  return casterBottom + tuning.liftHeightScale * Math.max(0, 1 - strain) + tuning.liftHeightBase;
}
