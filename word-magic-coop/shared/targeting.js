// 대상 지정 규칙("누구를 고르는가")과 작용의 적용 가능 여부("그 대상이 효과를 받을 수 있는가")를 분리한다.
// 서버 판정과 클라이언트 미리보기(조준 표시)가 같은 함수를 사용해 표시와 판정을 일치시킨다.
//
// world 형태:
//   statics: [{ id, min, max }]            — 정적 지형(속성 없음)
//   bodies:  [{ id, kind, pos(중심), half, traits: {movable, floatable}, immune(bool) }]

import { TUNING } from './tuning.js';
import { TRAIT } from './words.js';
import { boxOfBody, rayBox, dist, segmentBlocked, normalize } from './geom.js';

export const REASON = {
  INCOMPLETE: '문장이 완성되지 않았어요 (Tab에서 두 슬롯을 채우세요)',
  COOLDOWN: '아직 재사용 대기 중이에요',
  NO_TARGET: '조준선에 대상이 없어요',
  OUT_OF_RANGE: `너무 멀어요 (최대 ${TUNING.aimedMaxRange}m)`,
  NOTHING_NEARBY: `반경 ${TUNING.nearbyRadius}m 안에 대상이 없어요`,
  TERRAIN: '고정된 지형은 움직이거나 띄울 수 없어요',
  NOT_MOVABLE: '움직일 수 없는 대상이에요',
  NOT_FLOATABLE: '띄울 수 없는 대상이에요',
  PROTECTED: '보호 중인 대상이에요',
  BAD_AIM: '조준 정보가 올바르지 않아요',
  NOT_PLAYING: '게임이 진행 중이 아니에요',
};

// 선택 결과: { selected: [{ type: 'body'|'static', id }], reason? }
export function selectTargets(rule, world, casterId, aim, tuning = TUNING) {
  const caster = world.bodies.find((b) => b.id === casterId);
  if (!caster) return { selected: [], reason: REASON.NOT_PLAYING };

  if (rule === 'SELF') {
    return { selected: [{ type: 'body', id: casterId }] };
  }

  if (rule === 'AIMED') {
    if (!aim) return { selected: [], reason: REASON.BAD_AIM };
    const dir = normalize(aim.dir);
    let best = null;
    for (const s of world.statics) {
      const t = rayBox(aim.origin, dir, s, tuning.aimRayLength);
      if (t !== null && (!best || t < best.t)) best = { t, type: 'static', id: s.id, ref: s };
    }
    for (const b of world.bodies) {
      if (b.id === casterId) continue; // 시전자 자신 제외
      const t = rayBox(aim.origin, dir, boxOfBody(b), tuning.aimRayLength);
      if (t !== null && (!best || t < best.t)) best = { t, type: 'body', id: b.id, ref: b };
    }
    if (!best) return { selected: [], reason: REASON.NO_TARGET };
    if (best.type === 'static') {
      // 벽에 막히면 그 뒤의 대상을 찾지 않는다. 지형은 선택되지만 작용을 받지 못한다.
      const hit = aim.origin.map((o, i) => o + dir[i] * best.t);
      if (dist(hit, caster.pos) > tuning.aimedMaxRange) return { selected: [], reason: REASON.NO_TARGET };
      return { selected: [{ type: 'static', id: best.id }], hitPoint: hit };
    }
    if (dist(best.ref.pos, caster.pos) > tuning.aimedMaxRange) {
      return { selected: [], reason: REASON.OUT_OF_RANGE, outOfRange: best.id };
    }
    return { selected: [{ type: 'body', id: best.id }] };
  }

  if (rule === 'NEARBY') {
    // 시전자 중심 반경 안, 자신 제외, 지형에 가려진 대상 제외. 아군·사물 구분 없음.
    const selected = [];
    for (const b of world.bodies) {
      if (b.id === casterId) continue;
      if (dist(b.pos, caster.pos) > tuning.nearbyRadius) continue;
      if (segmentBlocked(caster.pos, b.pos, world.statics)) continue;
      selected.push({ type: 'body', id: b.id });
    }
    if (!selected.length) return { selected, reason: REASON.NOTHING_NEARBY };
    return { selected };
  }

  return { selected: [], reason: REASON.INCOMPLETE };
}

// 작용별로 필요한 공통 속성
export const ACTION_TRAIT = { PUSH: TRAIT.MOVABLE, LIFT: TRAIT.FLOATABLE };

// 적용 불가 이유를 반환한다. 적용 가능하면 null.
export function applicability(action, entity, casterId) {
  if (entity.type === 'static' || !entity.body) return REASON.TERRAIN;
  const b = entity.body;
  const trait = ACTION_TRAIT[action];
  if (!b.traits || !b.traits[trait]) return action === 'LIFT' ? REASON.NOT_FLOATABLE : REASON.NOT_MOVABLE;
  // 보호 상태는 "다른 플레이어가 거는" 이동 마법만 막는다. 자기 시전은 구분한다.
  if (b.kind === 'player' && b.id !== casterId && b.immune) return REASON.PROTECTED;
  return null;
}

// 선택 + 적용 가능 여부를 한 번에 계산한다.
// 반환: { applicable: [bodyId], rejected: [{id, reason}], reason(아무것도 적용 못 할 때) }
export function resolveSpell(targetRule, action, world, casterId, aim, tuning = TUNING) {
  const sel = selectTargets(targetRule, world, casterId, aim, tuning);
  const applicable = [];
  const rejected = [];
  for (const s of sel.selected) {
    const body = s.type === 'body' ? world.bodies.find((b) => b.id === s.id) : null;
    const why = applicability(action, { type: s.type, body }, casterId);
    if (why) rejected.push({ id: s.id, type: s.type, reason: why });
    else applicable.push(s.id);
  }
  let reason = null;
  if (!applicable.length) reason = rejected.length ? rejected[0].reason : sel.reason || REASON.NO_TARGET;
  return { applicable, rejected, reason, selection: sel };
}
