// 단어 정의. 단어는 "표시명 + 슬롯 분류 + 선택 규칙 ID 또는 작용 ID"로만 정의한다.
// 문장은 두 토큰(대상 지정 1 + 작용 1)을 참조한다. 여섯 문장을 따로 하드코딩하지 않는다.

export const SLOT = { TARGET: 'target', ACTION: 'action' };

export const WORDS = {
  AIMED: { id: 'AIMED', label: '대상을', slot: SLOT.TARGET, rule: 'AIMED' },
  SELF: { id: 'SELF', label: '자신을', slot: SLOT.TARGET, rule: 'SELF' },
  NEARBY: { id: 'NEARBY', label: '주변의 대상들을', slot: SLOT.TARGET, rule: 'NEARBY' },
  PUSH: { id: 'PUSH', label: '민다', slot: SLOT.ACTION, action: 'PUSH' },
  LIFT: { id: 'LIFT', label: '띄운다', slot: SLOT.ACTION, action: 'LIFT' },
};

// 공통 속성(trait). 작용은 대상이 해당 속성을 가지는지만 검사한다.
export const TRAIT = { MOVABLE: 'movable', FLOATABLE: 'floatable' };

export function sentenceLabel(targetWordId, actionWordId) {
  const t = targetWordId ? WORDS[targetWordId].label : '[대상 지정]';
  const a = actionWordId ? WORDS[actionWordId].label : '[작용]';
  return `${t} ${a}`;
}
