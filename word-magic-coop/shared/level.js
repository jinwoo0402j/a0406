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

  // 이동 사물. pos는 바닥 중심 좌표. size는 AABB 한 변(가로·세로·깊이)의 길이.
  bodies: [
    { id: 'rock', kind: 'rock', pos: [-3, 0, 6], size: [0.7, 0.7, 0.7] },
    { id: 'box1', kind: 'box', pos: [3, 0, 6], size: [0.9, 0.9, 0.9] },
    { id: 'box2', kind: 'box', pos: [2.4, 0, 18.4], size: [0.9, 0.9, 0.9] },
    { id: 'cargo', kind: 'cargo', pos: [0, 0, 26], size: [1, 1, 1] },
  ],

  // 단어 토큰. seat가 있으면 그 자리 플레이어의 인벤토리에서 시작하고(접속한 자리만 생긴다),
  // pos가 있으면 월드에 놓여 있다. 2명이면 토큰 6개, 6명이면 14개.
  // 시작 문장: A·C·E는 「대상을 민다」, B·D·F는 「대상을 띄운다」.
  tokens: [
    { id: 't1', word: 'AIMED', seat: 'A' },
    { id: 't2', word: 'PUSH', seat: 'A' },
    { id: 't3', word: 'AIMED', seat: 'B' },
    { id: 't4', word: 'LIFT', seat: 'B' },
    { id: 't5', word: 'SELF', pos: [-5, 0, 17] },
    { id: 't6', word: 'NEARBY', pos: [5, 0, 17.5] },
    { id: 't7', word: 'AIMED', seat: 'C' },
    { id: 't8', word: 'PUSH', seat: 'C' },
    { id: 't9', word: 'AIMED', seat: 'D' },
    { id: 't10', word: 'LIFT', seat: 'D' },
    { id: 't11', word: 'AIMED', seat: 'E' },
    { id: 't12', word: 'PUSH', seat: 'E' },
    { id: 't13', word: 'AIMED', seat: 'F' },
    { id: 't14', word: 'LIFT', seat: 'F' },
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
    { text: '출발·연습 구역', pos: [-7.94, 1.9, 5], yaw: Math.PI / 2 },
    { text: '출발·연습 구역', pos: [7.94, 1.9, 5], yaw: -Math.PI / 2 },
    { text: '발견·실험 구역', pos: [-7.94, 1.9, 17], yaw: Math.PI / 2 },
    { text: '발견·실험 구역', pos: [7.94, 1.9, 17], yaw: -Math.PI / 2 },
    { text: '도착 구역 ▲', pos: [0, 0.8, 28.97], yaw: Math.PI },
  ],
};

export const SEAT_IDS = LEVEL.seats.map((s) => s.id);
export const MAX_PLAYERS = SEAT_IDS.length;

// 캐릭터 + 이동 사물의 정의(렌더링·미리보기용). 캐릭터는 자리 수만큼.
export function bodyDefs(level = LEVEL) {
  return [
    ...level.seats.map((s) => ({ id: s.id, kind: 'player', pos: s.spawn, size: level.playerSize, color: s.color })),
    ...level.bodies,
  ];
}
