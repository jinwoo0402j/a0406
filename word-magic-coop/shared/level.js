// 작은 고정 공간 1개: 출발·연습 → 발견·실험 → 도착.
// 좌표: x 오른쪽, y 위, z 앞(출발 → 도착). 단위 m.
// 정적 지형은 AABB(min, max)이며 어떤 속성도 가지지 않는다(움직임 효과를 받지 않음).

const box = (id, min, max, color, extra = {}) => ({ id, min, max, color, ...extra });

export const LEVEL = {
  statics: [
    // 바닥: 출발(z -2~12) · 발견(12~24) · 도착 아래쪽(24~29)
    box('floor', [-8, -1, -2], [8, 0, 29], '#bfe3a6', { ground: true }),
    // 도착 구역의 단차(높이 1.6m). 점프(약 1.06m)로는 바로 오를 수 없다.
    box('plateau', [-6, -1, 29], [6, 1.6, 38], '#f4d9a0', { ground: true }),

    // 출발·발견 구역은 벽으로 둘러싼다(낙하 위험 없음). 도착 구역은 가장자리가 열려 있다.
    box('wall-back', [-8.5, 0, -2.5], [8.5, 3, -2], '#f6dce9'),
    box('wall-left', [-8.5, 0, -2], [-8, 3, 24], '#f6dce9'),
    box('wall-right', [8, 0, -2], [8.5, 3, 24], '#f6dce9'),

    // 출발 / 발견 구역 경계의 낮은 울타리(가운데 6m가 열려 있다)
    box('hedge-left', [-8, 0, 12], [-3, 0.8, 12.4], '#9ccf8a'),
    box('hedge-right', [3, 0, 12], [8, 0.8, 12.4], '#9ccf8a'),

    // 발견 구역의 낮은 턱: 사물이 모이는 작은 공간을 만든다
    box('ledge-disc', [-1.2, 0, 21.5], [1.2, 0.5, 22.3], '#d8c3f0'),
  ],

  // 플레이어 자리(최대 6명). 접속한 자리만 캐릭터가 생긴다. spawn은 바닥 중심 좌표.
  seats: [
    { id: 'A', spawn: [-1.5, 0, 1], color: '#ff7f73' },
    { id: 'B', spawn: [1.5, 0, 1], color: '#5fa8ff' },
    { id: 'C', spawn: [-4.5, 0, 1], color: '#4fc27f' },
    { id: 'D', spawn: [4.5, 0, 1], color: '#f2b632' },
    { id: 'E', spawn: [-3, 0, -0.6], color: '#b48cff' },
    { id: 'F', spawn: [3, 0, -0.6], color: '#34c3bd' },
  ],
  playerSize: [0.7, 1.3, 0.7],
  playerMass: 1.6, // [임시] 친구도 들 수 있지만 무거운 편

  // 이동 사물. pos는 바닥 중심 좌표. size는 AABB 한 변의 길이. mass는 들기 판정용 무게 [임시 수치].
  // 기본 들기 힘(3)으로: 돌·상자는 높이, 사람은 단차(1.6m)를 넘을 만큼, 짐은 낮게 든다.
  // 무거운 상자(3.6)는 혼자서는 <세게> 없이 들 수 없고, 둘이 같이 들면 들린다(1.8씩).
  bodies: [
    { id: 'rock', kind: 'rock', pos: [-3, 0, 6], size: [0.7, 0.7, 0.7], mass: 0.5 },
    { id: 'box1', kind: 'box', pos: [3, 0, 6], size: [0.9, 0.9, 0.9], mass: 1 },
    { id: 'box2', kind: 'heavy', pos: [2.4, 0, 18.4], size: [0.9, 0.9, 0.9], mass: 3.6 },
    { id: 'dummy', kind: 'dummy', pos: [-2.6, 0, 19.6], size: [0.7, 1.5, 0.7], mass: 1.4 },
    { id: 'cargo', kind: 'cargo', pos: [0, 0, 26], size: [1, 1, 1], mass: 2.6 },
    // 세계의 성질을 단어로(v0.5). 모두 제자리에 박혀 있다(fixed).
    // 커다란 바위: 밀치기·당기기·파이어볼로 조금씩 부수면 작아지면서 <큰>이 떨어진다.
    { id: 'boulder', kind: 'boulder', pos: [-5.4, 0, 8.6], size: [1.8, 1.6, 1.8], mass: 50 },
    // 모닥불: <당기기>로 불을 뽑아내면 <불>이 나온다(불은 꺼진다). <불>로 다시 붙일 수 있다.
    { id: 'campfire', kind: 'campfire', pos: [5.4, 0, 8.6], size: [0.9, 0.5, 0.9], mass: 50 },
    // 샘: <당기기>로 물을 길어 올리면 <물>이 나온다(샘이 빈다). 조금 지나면 다시 찬다.
    { id: 'well', kind: 'well', pos: [-6.3, 0, 21], size: [1, 0.7, 1], mass: 50 },
  ],

  // 처음엔 없고 마법으로 생기는 사물(같은 것을 다시 쓴다). 추운 곳에 <물>을 쏘면 얼음 덩이가 생긴다.
  reserve: [
    { id: 'ice1', kind: 'ice', pos: [0, -50, 0], size: [0.9, 0.9, 0.9], mass: 1.2 },
    { id: 'ice2', kind: 'ice', pos: [0, -50, 0], size: [0.9, 0.9, 0.9], mass: 1.2 },
    { id: 'ice3', kind: 'ice', pos: [0, -50, 0], size: [0.9, 0.9, 0.9], mass: 1.2 },
    // 김: 얼음이 녹거나 모닥불이 물에 꺼지면 잠깐 떠 있다. 부딪히지 않는다. <당기기>로 거두면 <수증기>
    { id: 'steam1', kind: 'steamcloud', pos: [0, -50, 0], size: [1.2, 1, 1.2], mass: 0 },
    { id: 'steam2', kind: 'steamcloud', pos: [0, -50, 0], size: [1.2, 1, 1.2], mass: 0 },
  ],

  // 환경 구역. 추운 곳(눈밭): 여기에 닿은 <물>은 얼음이 되고, 얼음은 여기서는 녹지 않는다.
  zones: [
    { id: 'snow', kind: 'cold', min: [-8, -1, 24], max: [-3, 4, 29] },
  ],

  // 단어 토큰. seat가 있으면 그 자리 플레이어가 가지고 시작하고(접속한 자리만 생긴다),
  // pos가 있으면 월드에 놓여 있다. 대상 지정 단어는 없다(대상은 모드 버튼).
  // 시작 효과: A·C·E <밀치기>, B·D·F <들기>. 월드: <당기기> 1, <들기> 1, <파이어볼> 1, <큰> 1, <세게> 2.
  // <큰>은 바닥에 하나만 두고, 나머지는 커다란 바위를 부숴서 얻는다(세계의 성질을 단어로).
  tokens: [
    { id: 't1', word: 'PUSH', seat: 'A' },
    { id: 't2', word: 'LIFT', seat: 'B' },
    { id: 't3', word: 'PUSH', seat: 'C' },
    { id: 't4', word: 'LIFT', seat: 'D' },
    { id: 't5', word: 'PUSH', seat: 'E' },
    { id: 't6', word: 'LIFT', seat: 'F' },
    { id: 'w1', word: 'FIREBALL', pos: [-5, 0, 17] },
    { id: 'w2', word: 'BIG', pos: [4.6, 0, 17.1] },
    { id: 'w5', word: 'STRONG', pos: [-6.2, 0, 25.4] },
    { id: 'w6', word: 'STRONG', pos: [6.2, 0, 27.2] },
    { id: 'w7', word: 'PULL', pos: [0, 0, 9.5] }, // 출발 구역 가운데: 일찍 발견해 여러 용도로 써 본다
    { id: 'w8', word: 'LIFT', pos: [4.2, 0, 20.4] }, // 무거운 상자 옆: 2인 플레이에서도 둘이 같이 들 수 있게
  ],

  // 안전 위치. 마지막으로 서 있던 지면 조각(ground)과 같은 조각의 가장 가까운 지점으로 복구한다.
  respawns: [
    { ground: 'floor', pos: [0, 0, 2] },
    { ground: 'floor', pos: [0, 0, 15] },
    { ground: 'floor', pos: [0, 0, 26] },
    { ground: 'plateau', pos: [0, 1.6, 31] },
  ],

  // 목표 짐과 두 플레이어가 함께 2초 이상 머물러야 하는 도착 구역
  goal: { min: [-3, 1.6, 32], max: [3, 6, 37] },

  // 표시용 구역 이름(벽·단차에 붙은 표지판). yaw는 표지판 앞면이 향하는 방향(0 = +z).
  labels: [
    // 표지판은 기호로(text는 설명용)
    { text: '출발·연습 구역', icons: ['walk', 'wand'], pos: [-7.94, 1.9, 5], yaw: Math.PI / 2 },
    { text: '출발·연습 구역', icons: ['walk', 'wand'], pos: [7.94, 1.9, 5], yaw: -Math.PI / 2 },
    { text: '발견·실험 구역', icons: ['eye', 'leaf'], pos: [-7.94, 1.9, 17], yaw: Math.PI / 2 },
    { text: '발견·실험 구역', icons: ['eye', 'leaf'], pos: [7.94, 1.9, 17], yaw: -Math.PI / 2 },
    { text: '도착 구역 ▲', icons: ['flag', 'up'], pos: [0, 0.8, 28.97], yaw: Math.PI },
  ],
};

// 점 p가 그 종류의 환경 구역 안인가
export function inZone(p, kind, level = LEVEL) {
  return (level.zones || []).some((z) => z.kind === kind
    && p[0] >= z.min[0] && p[0] <= z.max[0] && p[1] >= z.min[1] && p[1] <= z.max[1] && p[2] >= z.min[2] && p[2] <= z.max[2]);
}

export const SEAT_IDS = LEVEL.seats.map((s) => s.id);
export const MAX_PLAYERS = SEAT_IDS.length;

// 캐릭터 + 이동 사물의 정의(렌더링·미리보기용). 캐릭터는 자리 수만큼.
export function bodyDefs(level = LEVEL) {
  return [
    ...level.seats.map((s) => ({ id: s.id, kind: 'player', pos: s.spawn, size: level.playerSize, color: s.color, mass: level.playerMass })),
    ...level.bodies,
    ...(level.reserve || []),
  ];
}
