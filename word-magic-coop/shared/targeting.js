// 대상 모드("누구에게")와 효과의 적용 가능 여부("그 대상이 받을 수 있는가")를 분리한다.
// 서버 판정과 클라이언트 미리보기(조준 표시)가 같은 함수를 사용해 표시와 판정을 일치시킨다.
//
// world 형태:
//   statics: [{ id, min, max }]                    — 정적 지형(속성 없음)
//   bodies:  [{ id, kind, pos(중심), half, mass, traits, immune(bool), heldBy }]

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
  TOO_HEAVY: '너무 무거워서 들 수 없어요 (<세게>로 힘을 보강하세요)',
  ALREADY_HELD: '다른 사람이 들고 있어요',
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
export function applicability(effect, entity, casterId, opts = {}) {
  if (entity.type === 'static' || !entity.body) return REASON.TERRAIN;
  const b = entity.body;
  // 보호 상태는 "다른 플레이어가 거는" 마법만 막는다. 자기 시전은 구분한다.
  if (b.kind === 'player' && b.id !== casterId && b.immune) return REASON.PROTECTED;
  if (effect === 'PUSH') return b.traits?.[TRAIT.MOVABLE] ? null : REASON.NOT_MOVABLE;
  if (effect === 'LIFT') {
    if (!b.traits?.[TRAIT.LIFTABLE]) return REASON.NOT_LIFTABLE;
    if (b.heldBy && b.heldBy !== casterId) return REASON.ALREADY_HELD;
    if (opts.casterGround && opts.casterGround === b.id) return REASON.STANDING_ON;
    if (opts.capacity !== undefined && b.mass > opts.capacity + 1e-9) return REASON.TOO_HEAVY;
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

// 들기 최대 높이(대상 바닥 기준): 무거울수록 낮게 [임시 공식]
export function liftMaxBottom(casterBottom, mass, capacity, tuning = TUNING) {
  return casterBottom + tuning.liftHeightScale * Math.max(0, 1 - mass / capacity) + tuning.liftHeightBase;
}
