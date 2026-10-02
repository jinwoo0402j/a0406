// 단어 정의 (v0.3). 주문 = 효과 단어 1개 + 수식 단어(보유한 개수까지 중첩).
// 대상은 단어가 아니라 버튼으로 바꾸는 "대상 모드"다(조준 대상 / 본인 / 주변).

export const KIND = { EFFECT: 'effect', MOD: 'mod' };

export const MODE = { AIM: 'AIM', SELF: 'SELF', NEAR: 'NEAR' };
export const MODE_ORDER = ['AIM', 'SELF', 'NEAR'];
export const MODE_LABEL = { AIM: '조준 대상', SELF: '본인', NEAR: '주변' };

// cast: 효과마다 시전·전달·적용 방식이 다르다.
//   instant    — 즉시 발동, 한 번 적용 (밀치기, 당기기)
//   hold       — 시전하면 유지되는 지속형. 시전자가 '시전 종료'로 직접 끝낸다 (들기)
//   projectile — 투사체가 날아가 실제로 맞은 대상에 적용 (파이어볼)
// modes: 이 효과를 쓸 수 있는 대상 모드. 빠진 조합은 막아 둔다.
//   본인+들기·본인+당기기: 막음 — 혼자 높은 곳에 오르면 "친구가 들어 줘야 넘는" 협동이 깨진다 [제안안]
export const WORDS = {
  PUSH: { id: 'PUSH', label: '밀치기', kind: KIND.EFFECT, cast: 'instant', modes: ['AIM', 'SELF', 'NEAR'] },
  PULL: { id: 'PULL', label: '당기기', kind: KIND.EFFECT, cast: 'instant', modes: ['AIM', 'NEAR'] },
  LIFT: { id: 'LIFT', label: '들기', kind: KIND.EFFECT, cast: 'hold', modes: ['AIM', 'NEAR'] },
  FIREBALL: { id: 'FIREBALL', label: '파이어볼', kind: KIND.EFFECT, cast: 'projectile', modes: ['AIM', 'SELF', 'NEAR'] },
  // 세계에서 얻는 성질 단어(v0.5). 단어의 뜻이 곧 효과다.
  WATER: { id: 'WATER', label: '물', kind: KIND.EFFECT, cast: 'projectile', modes: ['AIM', 'SELF', 'NEAR'] },
  FIRE: { id: 'FIRE', label: '불', kind: KIND.EFFECT, cast: 'instant', modes: ['AIM', 'NEAR'] },
  STEAM: { id: 'STEAM', label: '수증기', kind: KIND.EFFECT, cast: 'instant', modes: ['AIM', 'NEAR'] },
  BIG: { id: 'BIG', label: '큰', kind: KIND.MOD },
  STRONG: { id: 'STRONG', label: '세게', kind: KIND.MOD },
};

export const MOD_IDS = Object.values(WORDS).filter((w) => w.kind === KIND.MOD).map((w) => w.id);

// 공통 속성. 효과는 대상이 속성을 가지는지로 적용 여부를 정한다(친구·적·사물 구분 없음).
//   fixed     — 제자리에 박혀 움직이지 않는다(바위·모닥불·샘)
//   breakable — 마법으로 때리면 조금씩 부서지고, 부서질 때마다 성질 단어가 떨어진다(커다란 바위 → <큰>)
//   heatable  — <불>이 통한다(그을림·피해·녹음·불붙음)
//   source    — <당기기>로 성질을 단어로 뽑아낼 수 있다(모닥불 → <불>, 샘 → <물>)
export const TRAIT = {
  MOVABLE: 'movable', LIFTABLE: 'liftable', DAMAGEABLE: 'damageable',
  FIXED: 'fixed', BREAKABLE: 'breakable', HEATABLE: 'heatable', SOURCE: 'source',
};

// 사물 종류별 속성(서버 판정과 클라이언트 미리보기가 같이 쓴다)
const MOVE = { movable: true, liftable: true };
const KIND_TRAITS = {
  player: { ...MOVE, heatable: true },
  dummy: { ...MOVE, damageable: true, heatable: true },
  ice: { ...MOVE, heatable: true },
  boulder: { fixed: true, breakable: true },
  campfire: { fixed: true, heatable: true, source: 'FIRE' },
  well: { fixed: true, source: 'WATER' },
};
export function traitsOf(kind) {
  return { ...(KIND_TRAITS[kind] || MOVE) };
}

// ---------------------------------------------------------------- 반응(단어 + 단어 → 새 단어)
// 섞는 칸에 넣은 단어의 "종류와 개수"만 본다. 놓은 순서·자리는 상관없다(마인크래프트의 모양 없는 조합법).
export const REACTIONS = [
  { id: 'steam', needs: { WATER: 1, FIRE: 1 }, makes: 'STEAM' }, // 물 + 불 → 수증기
];

export function wordCounts(words) {
  const c = {};
  for (const w of words) if (WORDS[w]) c[w] = (c[w] || 0) + 1;
  return c;
}

// words: 단어 id 목록(순서 무관). 정확히 맞는 반응이 있으면 그 반응, 없으면 null
export function reactionFor(words) {
  if (!words.length || words.some((w) => !WORDS[w])) return null;
  const c = wordCounts(words);
  const keys = Object.keys(c);
  for (const r of REACTIONS) {
    const need = Object.keys(r.needs);
    if (need.length === keys.length && need.every((w) => c[w] === r.needs[w])) return r;
  }
  return null;
}

// "<큰> × 3 + <파이어볼>" 형태의 표시. modCounts: { BIG: 3, STRONG: 0 }
export function spellLabel(effectId, modCounts = {}) {
  const parts = [];
  for (const id of MOD_IDS) if (modCounts[id] > 0) parts.push(`<${WORDS[id].label}>${modCounts[id] > 1 ? ` × ${modCounts[id]}` : ''}`);
  parts.push(effectId ? `<${WORDS[effectId].label}>` : '[효과]');
  return parts.join(' + ');
}
