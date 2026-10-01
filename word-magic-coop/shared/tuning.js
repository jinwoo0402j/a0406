// 조절 가능한 수치 모음. 서버(판정)와 클라이언트(미리보기·표시)가 같은 값을 쓴다.
// [임시] 표시는 v0.3 기획에서 아직 정하지 않은 정책을 구현하려고 둔 임시값이다. 플레이테스트 후 조정한다.

export const TUNING = {
  // 시뮬레이션
  tickRate: 60, // 서버 시뮬레이션 Hz
  snapshotRate: 30, // 서버 → 클라이언트 상태 전송 Hz
  interpDelay: 0.07, // 클라이언트 보간 지연(초)

  // 캐릭터 이동
  gravity: 20, // m/s²
  terminalFall: 30, // 최대 낙하 속도 m/s
  walkSpeed: 5, // m/s
  groundAccel: 50, // 입력 속도 가속 m/s²
  airAccel: 25,
  jumpSpeed: 6.5, // 점프 높이 ≈ jumpSpeed² / (2·gravity) ≈ 1.06m

  // 외부 이동(마법) — 입력 이동과 별도로 누적된다
  extGroundFriction: 6, // 지면에서 외부 수평 속도 감속 m/s²
  extAirDrag: 1.2, // 공중에서 감속 m/s²

  // 대상 모드 [임시: v0.2 값을 시작점으로 사용, 확정값 아님]
  aimedMaxRange: 8, // 조준 대상 최대 거리(시전자 중심 → 대상 중심)
  aimRayLength: 20, // 카메라 조준선 최대 길이
  nearbyRadius: 3, // 주변 모드 반경(시전자 중심, 자신 제외, 지형에 가려지면 제외)

  // <밀치기> — 즉시 발동, 한 번 적용
  pushDeltaV: 4, // 초기 속도 변화 m/s
  pushMaxSpeed: 8, // 외부 수평 속도 상한 m/s
  pushSelfEpsilon: 0.05,

  // <당기기> — 즉시 발동, 한 번 적용. 대상을 내 앞까지 끌어온다(마찰로 멈출 거리를 계산).
  // 지형을 조준하면 내가 그쪽으로 끌려간다(수평으로만 — 단차를 오르는 데는 못 쓴다) [제안안·임시 수치]
  pullMaxSpeed: 9, // 당기는 속도 상한 m/s
  pullStopDistance: 1.2, // 이 거리쯤에서 멈추도록 당긴다(중심 간 거리)

  // <파이어볼> — 투사체, 실제 명중 시 적용 [임시: 시전 준비시간 없음, 직선 비행, 명중 시 작은 폭발]
  fireballSpeed: 14, // m/s
  fireballRadius: 0.22, // 충돌 반지름 m
  fireballLife: 2.5, // 수명 s (그 뒤엔 소멸)
  fireballSpawnForward: 0.6, // 시전자 앞 발사 위치
  fireballBlastRadius: 1.0, // 명중 지점 폭발 반경 m
  fireballDamage: 25, // 적 피해
  fireballKnockback: 3, // 폭발에 휩쓸린 대상의 밀림 m/s
  aimPointRange: 40, // 파이어볼이 향할 조준점을 찾는 거리
  fireballSelfLaunch: 5, // 본인 모드(발밑 폭발): 땅에 있을 때만 튀어 오르는 속도 m/s (≈0.6m) [제안안]
  fireballNearCount: 4, // 주변 모드: 사방으로 쏘는 개수 [제안안]

  // <들기> — 시전하면 유지, 시전 종료로 놓음, 시점을 따라 무게·관성 있게 끌려온다 [임시 수치]
  liftRange: 8, // 들 수 있는 거리
  liftCapacity: 3, // 들기 힘(들 수 있는 최대 무게). 이보다 무거우면 들 수 없다
  liftHeightScale: 3.4, // 최대 높이 = 시전자 발밑 + scale·(1 − 무게/힘) + base
  liftHeightBase: 0.2,
  liftSpring: 30, // 목표 지점으로 끄는 스프링 강도(1/s²)
  liftDamping: 5, // 감쇠(1/s). 임계 감쇠보다 작아 멈춘 뒤 조금 더 움직였다 돌아온다
  liftMaxAccel: 30, // 끄는 가속도 상한 m/s² (무게가 클수록 줄어든다)
  liftHoldMin: 1.6, // 시선 앞 유지 거리 범위
  liftHoldMax: 5,
  liftEye: 0.5, // 시전자 중심에서 시선 높이
  liftBreakDistance: 10, // 이보다 멀어지면 놓친다
  liftMaxSpeed: 15,
  liftNearHeight: 1.6, // 주변 모드: 시전자 발밑 기준 띄우는 높이(무게 상한이 더 낮으면 그쪽) [제안안]
  // 같이 들기: 한 물체의 무게를 드는 사람 수로 똑같이 나눈다. 각자 나눠 든 무게의 합이 자기 힘을 넘으면 놓친다 [제안안]

  // 수식 단어 중첩 [임시: 곱 연산, 중첩당 배율, 최대 중첩 수]
  maxModStacks: 5,
  mods: {
    BIG: { fireballRadius: 1.35, blastRadius: 1.35, pushReach: 1.2, pullReach: 1.2, liftReach: 1.2 }, // <큰>: 크기·범위 계열
    STRONG: { pushForce: 1.3, pullForce: 1.3, liftCapacity: 1.4, fireballDamage: 1.5 }, // <세게>: 힘·위력 계열
  },

  // 아군 명중 [제안안 디버프: 그을림 — 2초 느려짐. 체력 감소 없음. 다시 맞으면 쌓이지 않고 2초로 갱신]
  allyDebuffDuration: 2,
  allyDebuffSpeed: 0.5,

  // 시험용 적(허수아비)
  dummyHp: 100,
  dummyRespawn: 3,

  // 시전
  castCooldown: 1, // 정상 시전 재사용 대기 s (들기는 놓을 때 적용)

  // 보호·복구
  releaseImmunity: 2, // R 이후 다른 플레이어의 마법에 면역 s
  releaseCooldown: 0,
  killY: -12,

  // 단어
  pickupRadius: 2,
  dropForward: 0.9,

  // 목표
  goalHoldTime: 2,

  // 네트워크
  aimHistory: 1.0,
  maxCameraOffset: 8,
};

// 수식 배율: 보유·장착한 개수만큼 중첩(상한 maxModStacks)
export function modFactor(tuning, modCounts, word, key) {
  const step = tuning.mods[word]?.[key];
  if (!step) return 1;
  const n = Math.min(tuning.maxModStacks, modCounts?.[word] || 0);
  return step ** n;
}

export function modProduct(tuning, modCounts, key) {
  let f = 1;
  for (const word of Object.keys(tuning.mods)) f *= modFactor(tuning, modCounts, word, key);
  return f;
}
