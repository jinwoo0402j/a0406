// 조절 가능한 수치 모음. 서버(판정)와 클라이언트(미리보기·표시)가 같은 값을 쓴다.
// 기획서 v0.2의 초기값을 따르며, 테스트 후 조절하는 것을 전제로 한다.

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
  extAirDrag: 1.2, // 공중(부양 포함)에서 감속 m/s²
  extMaxSpeed: 8, // 외부 수평 속도 상한 m/s

  // 대상 지정 단어
  aimedMaxRange: 8, // 「대상을」 최대 거리(시전자 중심 → 대상 중심)
  aimRayLength: 20, // 카메라 조준선 최대 길이
  nearbyRadius: 3, // 「주변의 대상들을」 반경(시전자 중심 기준)

  // 작용 단어
  pushDeltaV: 4, // 「민다」 초기 속도 변화 m/s
  liftHeight: 2, // 「띄운다」 기준 높이에서 상승량 m
  liftDuration: 3, // 「띄운다」 총 부양 시간 s
  liftRiseGain: 6, // 목표 높이로 수렴하는 비율(1/s)
  liftMaxVSpeed: 7, // 부양 중 최대 수직 속도 m/s

  // 시전
  castCooldown: 1, // 정상 시전 재사용 대기시간 s
  pushSelfEpsilon: 0.05, // 시전자와 대상의 수평 위치가 이만큼 가까우면 카메라 전방 사용

  // 보호·복구
  releaseImmunity: 2, // R 이후 다른 플레이어의 이동 마법 면역 s
  releaseCooldown: 0, // R 재사용 대기(초기 0: 제한 없음)
  killY: -12, // 이 높이 아래로 떨어지면 안전 위치로 복구

  // 단어
  pickupRadius: 2, // E로 주울 수 있는 거리(수평)
  dropForward: 0.9, // 내려놓을 때 앞쪽 거리

  // 목표
  goalHoldTime: 2, // 짐과 두 사람이 도착 구역에 함께 있어야 하는 시간 s

  // 네트워크
  aimHistory: 1.0, // 조준 판정에 쓰는 과거 위치 기록 길이(초). 이보다 오래된 시점은 이 한도로 잘린다.
  maxCameraOffset: 8, // 시전 요청의 조준 원점이 시전자에게서 떨어질 수 있는 최대 거리
};
