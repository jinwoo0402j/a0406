// 단어 정의 (v0.3). 주문 = 효과 단어 1개 + 수식 단어(보유한 개수까지 중첩).
// 대상은 단어가 아니라 버튼으로 바꾸는 "대상 모드"다(조준 대상 / 본인 / 주변).

export const KIND = { EFFECT: 'effect', MOD: 'mod' };

export const MODE = { AIM: 'AIM', SELF: 'SELF', NEAR: 'NEAR' };
export const MODE_ORDER = ['AIM', 'SELF', 'NEAR'];
export const MODE_LABEL = { AIM: '조준 대상', SELF: '본인', NEAR: '주변' };

// cast: 효과마다 시전·전달·적용 방식이 다르다.
//   instant    — 즉시 발동, 한 번 적용 (밀치기)
//   hold       — 버튼을 누르는 동안 유지하며 지속 제어 (들기)
//   projectile — 투사체가 날아가 실제로 맞은 대상에 적용 (파이어볼)
// modes: 이 효과를 쓸 수 있는 대상 모드. 나머지 조합은 기획 미정이라 막아 둔다(임시).
export const WORDS = {
  PUSH: { id: 'PUSH', label: '밀치기', kind: KIND.EFFECT, cast: 'instant', modes: ['AIM', 'SELF', 'NEAR'] },
  LIFT: { id: 'LIFT', label: '들기', kind: KIND.EFFECT, cast: 'hold', modes: ['AIM'] },
  FIREBALL: { id: 'FIREBALL', label: '파이어볼', kind: KIND.EFFECT, cast: 'projectile', modes: ['AIM'] },
  BIG: { id: 'BIG', label: '큰', kind: KIND.MOD },
  STRONG: { id: 'STRONG', label: '세게', kind: KIND.MOD },
};

export const MOD_IDS = Object.values(WORDS).filter((w) => w.kind === KIND.MOD).map((w) => w.id);

// 공통 속성. 효과는 대상이 속성을 가지는지로 적용 여부를 정한다(친구·적·사물 구분 없음).
export const TRAIT = { MOVABLE: 'movable', LIFTABLE: 'liftable', DAMAGEABLE: 'damageable' };

// "<큰> × 3 + <파이어볼>" 형태의 표시. modCounts: { BIG: 3, STRONG: 0 }
export function spellLabel(effectId, modCounts = {}) {
  const parts = [];
  for (const id of MOD_IDS) if (modCounts[id] > 0) parts.push(`<${WORDS[id].label}>${modCounts[id] > 1 ? ` × ${modCounts[id]}` : ''}`);
  parts.push(effectId ? `<${WORDS[effectId].label}>` : '[효과]');
  return parts.join(' + ');
}
