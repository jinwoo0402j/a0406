// 호스트 시뮬레이션으로 확인하는 기능 완료 체크리스트 T2~T7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNING } from '../shared/tuning.js';
import { REASON } from '../shared/targeting.js';
import { newGame, run, place, cast, walkTo, equip, bottom, assertTokenInvariant } from './helpers.js';

const CD = TUNING.castCooldown + 0.02;

test('T2: 문장을 바꾸지 않고 「대상을 띄운다」를 친구·돌·상자에 적용', () => {
  const g = newGame();
  const slotsBefore = { ...g.players.B.slots };
  place(g, 'B', [0, 0, 3]);
  place(g, 'A', [0, 0, 6]);
  place(g, 'rock', [-2, 0, 6]);
  place(g, 'box1', [2, 0, 6]);
  run(g, 0.2);
  for (const id of ['A', 'rock', 'box1']) {
    const r = cast(g, 'B', id);
    assert.ok(r.ok, `${id}에 시전 실패: ${r.reason}`);
    assert.deepEqual(r.targets, [id]);
    run(g, CD);
  }
  assert.deepEqual(g.players.B.slots, slotsBefore);
  // 마지막 대상(상자)은 아직 떠 있고 약 2m 올라가 있다
  const box = g.body('box1');
  assert.ok(box.float);
  assert.ok(Math.abs(bottom(box) - 2) < 0.15, `상자 높이 ${bottom(box)}`);
});

test('T3: 6개 조합이 모두 동작한다 (SELF는 자신만, NEARBY는 자신 제외·반경·가림)', () => {
  const g = newGame();
  // B가 「자신을」「주변의 대상들을」을 줍는다
  place(g, 'B', [-5, 0, 16]);
  run(g, 0.1);
  assert.ok(g.handle('B', { t: 'pickup' }).ok);
  place(g, 'B', [5, 0, 16.5]);
  run(g, 0.1);
  assert.ok(g.handle('B', { t: 'pickup' }).ok);
  // A의 「민다」를 B에게 넘긴다(내려놓기 → 줍기)
  place(g, 'A', [0, 0, 8]);
  place(g, 'B', [0, 0, 9]);
  run(g, 0.1);
  assert.ok(g.handle('A', { t: 'drop', token: 't2' }).ok);
  run(g, 0.3);
  assert.ok(g.handle('B', { t: 'pickup' }).ok);
  assert.equal(g.tokens.find((t) => t.id === 't2').owner, 'B');

  const setup = () => {
    place(g, 'B', [0, 0, 8]);
    place(g, 'A', [1.5, 0, 8]);
    place(g, 'rock', [-1.5, 0, 8]);
    place(g, 'box1', [0, 0, 10]);
    place(g, 'cargo', [5, 0, 8]); // 반경 밖
    for (const b of g.bodies) { b.float = null; b.ext = [0, 0]; }
    run(g, 0.3);
  };

  // 대상을 + 민다
  setup();
  equip(g, 'B', 'target', 't3'); equip(g, 'B', 'action', 't2');
  let r = cast(g, 'B', 'box1');
  assert.deepEqual(r.targets, ['box1']);
  assert.ok(g.body('box1').ext[1] > 3.9, '시전자 → 대상 방향(+z)으로 밀린다');
  run(g, CD);

  // 대상을 + 띄운다
  setup();
  equip(g, 'B', 'action', 't4');
  r = cast(g, 'B', 'rock');
  assert.deepEqual(r.targets, ['rock']);
  assert.ok(g.body('rock').float);
  run(g, CD);

  // 자신을 + 민다: 카메라 수평 전방
  setup();
  equip(g, 'B', 'target', 't5'); equip(g, 'B', 'action', 't2');
  r = cast(g, 'B', null, [1, -0.3, 0]);
  assert.deepEqual(r.targets, ['B']);
  assert.ok(g.body('B').ext[0] > 3.9 && Math.abs(g.body('B').ext[1]) < 1e-6);
  run(g, CD);

  // 자신을 + 띄운다: 외부 대상 없음
  setup();
  equip(g, 'B', 'action', 't4');
  r = cast(g, 'B');
  assert.deepEqual(r.targets, ['B']);
  assert.ok(g.body('B').float && !g.body('A').float && !g.body('rock').float);
  run(g, CD);

  // 주변의 대상들을 + 민다: 바깥쪽으로 퍼진다, 반경 밖·자신 제외
  setup();
  equip(g, 'B', 'target', 't6'); equip(g, 'B', 'action', 't2');
  r = cast(g, 'B');
  assert.deepEqual([...r.targets].sort(), ['A', 'box1', 'rock']);
  assert.ok(g.body('A').ext[0] > 3.9, 'A는 +x 바깥쪽');
  assert.ok(g.body('rock').ext[0] < -3.9, '돌은 -x 바깥쪽');
  assert.ok(g.body('box1').ext[1] > 3.9, '상자는 +z 바깥쪽');
  assert.deepEqual(g.body('cargo').ext, [0, 0]);
  assert.deepEqual(g.body('B').ext, [0, 0]);
  run(g, CD);

  // 주변의 대상들을 + 띄운다: 친구도 함께 떠오른다
  setup();
  equip(g, 'B', 'action', 't4');
  r = cast(g, 'B');
  assert.deepEqual([...r.targets].sort(), ['A', 'box1', 'rock']);
  assert.ok(!g.body('B').float);
  run(g, 0.8);
  assert.ok(bottom(g.body('A')) > 1.5, '친구도 함께 뜬다');
  run(g, 3);
  assert.ok(g.body('A').grounded, '3초 후 정상 중력');
  run(g, CD);

  // 벽(지형)을 관통해 뒤를 선택하지 않는다
  equip(g, 'B', 'target', 't3'); equip(g, 'B', 'action', 't2');
  place(g, 'B', [5, 0, 10.5]);
  place(g, 'box1', [5, 0, 14]); // 울타리(z 12~12.4, 높이 0.8) 너머
  run(g, 0.3);
  const origin = [5, 0.6, 10.5];
  r = g.handle('B', { t: 'cast', origin, dir: [0, -0.02, 1] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASON.TERRAIN);
  assert.deepEqual(g.body('box1').ext, [0, 0]);
});

test('T3: 무효 조합·무효 대상은 대기시간을 소비하지 않는다', () => {
  const g = newGame();
  equip(g, 'A', 'action', null);
  let r = cast(g, 'A', 'B');
  assert.equal(r.reason, REASON.INCOMPLETE);
  equip(g, 'A', 'action', 't2');
  r = g.handle('A', { t: 'cast', origin: g.body('A').pos, dir: [0, -1, 0] }); // 바닥
  assert.equal(r.ok, false);
  assert.equal(g.players.A.cooldownUntil, 0);
  r = cast(g, 'A', 'B');
  assert.ok(r.ok);
  r = cast(g, 'A', 'B');
  assert.equal(r.reason, REASON.COOLDOWN);
});

test('T4: 부양과 밀기가 함께 작동하고, 속도·높이가 누적되지 않는다', () => {
  const g = newGame();
  place(g, 'B', [0, 0, 8]);
  place(g, 'A', [0, 0, 5]);
  place(g, 'box1', [0, 0, 7]);
  run(g, 0.3);
  const box = g.body('box1');
  // B가 띄우고, A가 민다
  assert.ok(cast(g, 'B', 'box1').ok);
  run(g, 0.8);
  const y0 = bottom(box);
  assert.ok(Math.abs(y0 - 2) < 0.1, `부양 높이 ${y0}`);
  const z0 = box.pos[2];
  assert.ok(cast(g, 'A', 'box1').ok);
  run(g, 0.5);
  assert.ok(box.pos[2] > z0 + 1.2, '공중에서 수평 이동');
  assert.ok(box.float, '밀기가 부양을 지우지 않는다');
  assert.ok(Math.abs(bottom(box) - 2) < 0.1, '밀기 중에도 높이 유지');

  // 공중 반복 띄우기: 높이 누적 없음, 지속시간만 갱신
  run(g, CD);
  assert.ok(cast(g, 'B', 'box1').ok);
  run(g, 0.8);
  assert.ok(Math.abs(bottom(box) - 2) < 0.1, `반복 부양 후 높이 ${bottom(box)}`);
  assert.ok(box.float.left > 2);

  // 연속 밀기: 속도 상한
  const g2 = newGame();
  place(g2, 'A', [0, 0, 2]);
  place(g2, 'B', [0, 0, 4]);
  run(g2, 0.2);
  for (let i = 0; i < 5; i++) {
    const r = cast(g2, 'A', 'B');
    if (!r.ok) break;
    const s = Math.hypot(...g2.body('B').ext);
    assert.ok(s <= TUNING.extMaxSpeed + 1e-9);
    run(g2, CD);
  }
  // 입력 이동이 마법 이동을 덮어쓰지 않는다
  const g3 = newGame();
  place(g3, 'A', [0, 0, 2]);
  place(g3, 'B', [0, 0, 4]);
  run(g3, 0.2);
  cast(g3, 'A', 'B');
  g3.handle('B', { t: 'input', wish: [0, -1] }); // 반대 방향으로 걷기
  run(g3, 0.05);
  assert.ok(g3.body('B').ext[1] > 3, '외부 속도는 입력과 별도로 유지된다');
});

test('T4: 떠 있는 상자 위에 선 캐릭터는 함께 이동하고, 떠 있는 받침으로 높이를 쌓지 못한다', () => {
  const g = newGame();
  place(g, 'box1', [0, 0, 7]);
  place(g, 'A', [0, 0.9, 7]);
  place(g, 'B', [0, 0, 4]);
  run(g, 0.3);
  assert.equal(g.body('A').groundId, 'box1');
  cast(g, 'B', 'box1');
  run(g, 0.8);
  assert.ok(bottom(g.body('A')) > 2.8, '받침과 함께 올라간다');
  const ax = g.body('A').pos[2];
  // 상자를 떠 있는 채로 민다 → 위의 A도 따라간다
  const r = g.handle('B', { t: 'equip', slot: 'action', token: 't4' });
  assert.ok(r.ok);
  // B의 작용을 PUSH로 바꾸려면 PUSH 토큰이 필요하므로, 대신 box를 직접 외부 속도로 민다(물리만 확인)
  g.body('box1').ext = [0, 3];
  run(g, 0.4);
  assert.ok(g.body('A').pos[2] > ax + 0.8, '받침의 수평 이동을 따라간다');
  // A를 띄우면 기준 높이는 떠 있는 상자가 아니라 마지막 안정 착지 높이(상자 윗면이 바닥에 있을 때)다
  run(g, CD);
  cast(g, 'B', 'A');
  run(g, 1);
  assert.ok(bottom(g.body('A')) < 0.9 + TUNING.liftHeight + 0.15, `높이 누적 없음: ${bottom(g.body('A'))}`);
});

test('T5: 교환하면 구성 가능한 문장이 달라지고, 이미 발동한 효과는 유지된다', () => {
  const g = newGame();
  // B가 「주변의 대상들을」을 주워 장착
  place(g, 'B', [5, 0, 16.5]);
  run(g, 0.1);
  g.handle('B', { t: 'pickup' });
  equip(g, 'B', 'target', 't6');
  place(g, 'A', [6, 0, 16.5]);
  run(g, 0.2);
  const r1 = cast(g, 'B');
  assert.ok(r1.ok && r1.targets.includes('A'), '「주변의 대상들을 띄운다」로 A도 떠오른다');
  // B가 단어를 내려놓으면 슬롯이 비고, 이미 발동한 A의 부양은 유지
  assert.ok(g.handle('B', { t: 'drop', token: 't6' }).ok);
  assert.equal(g.players.B.slots.target, null);
  assert.ok(g.body('A').float);
  run(g, CD);
  assert.equal(cast(g, 'B').reason, REASON.INCOMPLETE);
  // A가 주워서 「주변의 대상들을 민다」를 만든다
  run(g, 3);
  place(g, 'A', [g.tokens.find((t) => t.id === 't6').pos[0], 0, g.tokens.find((t) => t.id === 't6').pos[2] - 0.5]);
  run(g, 0.2);
  assert.ok(g.handle('A', { t: 'pickup' }).ok);
  assert.ok(equip(g, 'A', 'target', 't6').ok);
  place(g, 'B', [g.body('A').pos[0] + 1.2, 0, g.body('A').pos[2]]);
  run(g, 0.2);
  const r2 = cast(g, 'A');
  assert.ok(r2.ok && r2.targets.includes('B'));
  assert.ok(Math.hypot(...g.body('B').ext) > 3.9, 'B도 함께 밀린다');
  // 다른 사람의 토큰은 장착할 수 없다
  assert.equal(equip(g, 'B', 'target', 't6').ok, false);
  assertTokenInvariant(assert, g);
});

test('T5: 동시에 줍기·낙하·재시작에서도 토큰 6개와 단일 소유권 보존', () => {
  const g = newGame();
  place(g, 'A', [-5.5, 0, 16]);
  place(g, 'B', [-4.5, 0, 16]);
  run(g, 0.2);
  // 같은 틱에 둘 다 「자신을」을 줍는다
  const ra = g.handle('A', { t: 'pickup' });
  const rb = g.handle('B', { t: 'pickup' });
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, '한 사람만 주울 수 있다');
  assert.equal(g.tokens.find((t) => t.id === 't5').owner, ra.ok ? 'A' : 'B');
  assertTokenInvariant(assert, g);

  // 낭떠러지 밖에 단어를 내려놓으면 떨어졌다가 안전 지점으로 돌아온다
  const holder = ra.ok ? 'A' : 'B';
  place(g, holder, [5.5, 1.6, 33]);
  run(g, 0.3);
  g.body(holder).yaw = Math.PI / 2; // +x(낭떠러지) 방향
  assert.ok(g.handle(holder, { t: 'drop', token: 't5' }).ok);
  run(g, 2.5);
  const t5 = g.tokens.find((t) => t.id === 't5');
  assert.ok(t5.pos && t5.pos[1] > 1.5, `복구된 위치 ${t5.pos}`);
  assert.ok(g.events.some((e) => e.k === 'tokenRecover'));
  assertTokenInvariant(assert, g);

  // 재시작: 위치·소유권·슬롯·효과·대기시간을 최초 상태로
  cast(g, 'A', 'B');
  g.handle('B', { t: 'release' });
  g.handle('A', { t: 'restart' });
  assert.deepEqual(g.players.A.slots, { target: 't1', action: 't2' });
  assert.deepEqual(g.players.B.slots, { target: 't3', action: 't4' });
  assert.equal(g.players.A.cooldownUntil, 0);
  assert.equal(g.tokens.find((t) => t.id === 't5').owner, null);
  assert.deepEqual(g.tokens.find((t) => t.id === 't5').pos, [-5, 0, 17]);
  assert.ok(g.bodies.every((b) => !b.float && b.ext[0] === 0 && b.immuneUntil === 0));
  assert.deepEqual(g.body('A').pos, [-1.5, 0.65, 1]);
  assertTokenInvariant(assert, g);
});

test('T6: R은 자신의 부양·외부 이동을 풀고, 다른 사람의 이동 마법에 2초 면역', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 5]);
  place(g, 'B', [0, 0, 3]);
  run(g, 0.2);
  assert.ok(cast(g, 'B', 'A').ok);
  run(g, 0.5);
  assert.ok(g.body('A').float);
  g.body('A').ext = [3, 0];
  assert.ok(g.handle('A', { t: 'release' }).ok);
  assert.equal(g.body('A').float, null);
  assert.deepEqual(g.body('A').ext, [0, 0]);
  run(g, 1.0);
  assert.ok(g.body('A').grounded, '해제 후 착지');
  // 보호 중에는 B의 마법을 받지 않고 B의 대기시간도 소비되지 않는다
  const cdBefore = g.players.B.cooldownUntil;
  const r = cast(g, 'B', 'A');
  assert.equal(r.reason, REASON.PROTECTED);
  assert.equal(g.players.B.cooldownUntil, cdBefore);
  // 스냅숏에 보호 상태가 실려 양쪽 화면에 표시된다
  assert.ok(g.snapshot().b.find((b) => b.id === 'A').i > 0);
  // 자기 시전은 보호와 구분된다
  place(g, 'A', [-5, 0, 16]);
  run(g, 0.1);
  g.handle('A', { t: 'pickup' });
  equip(g, 'A', 'target', 't5');
  assert.ok(cast(g, 'A', null, [0, 0, 1]).ok, '보호 중에도 자기 시전은 적용');
  run(g, 1.2);
  place(g, 'A', [0, 0, 5]);
  run(g, 0.3);
  assert.ok(cast(g, 'B', 'A').ok, '2초 후 다시 적용 가능');
});

test('T6: 낙하하면 안전한 위치로 복구되고 효과·속도가 초기화되어 계속 플레이할 수 있다', () => {
  const g = newGame();
  // 도착 구역 아래층 가장자리에서 A가 B를 바깥으로 민다
  place(g, 'B', [7.2, 0, 26]);
  place(g, 'A', [5.5, 0, 26]);
  run(g, 0.3);
  assert.ok(cast(g, 'A', 'B').ok);
  run(g, 3);
  const a = g.body('B');
  assert.ok(g.events.some((e) => e.k === 'recover' && e.id === 'B'));
  assert.ok(a.grounded && Math.abs(bottom(a)) < 0.01, '바닥 위로 복구');
  assert.ok(Math.abs(a.pos[2] - 26) < 4, `같은 구역으로 복구: z=${a.pos[2]}`);
  assert.deepEqual(a.ext, [0, 0]);
  assert.equal(a.float, null);
  const z0 = a.pos[2];
  g.handle('B', { t: 'input', wish: [0, -1] });
  run(g, 0.5);
  assert.ok(a.pos[2] < z0 - 1, '복구 후 바로 움직일 수 있다');
  // 목표 짐도 떨어지면 자기 안전 위치로 돌아온다
  place(g, 'cargo', [6.5, 0, 27.6]);
  run(g, 0.3);
  g.body('cargo').ext = [8, 0];
  const recBefore = g.events.filter((e) => e.k === 'recover' && e.id === 'cargo').length;
  run(g, 4);
  const c = g.body('cargo');
  assert.equal(g.events.filter((e) => e.k === 'recover' && e.id === 'cargo').length, recBefore + 1, '짐이 떨어졌다가 복구');
  assert.ok(c.grounded && Math.abs(bottom(c)) < 0.01 && Math.hypot(c.pos[0], c.pos[2] - 26) < 4, `짐 복구 위치 ${c.pos}`);
});

test('T7: 짐과 두 사람이 도착 구역에 2초 이상 함께 있으면 성공(순서 무관)', () => {
  const g = newGame();
  place(g, 'cargo', [0, 1.6, 34]);
  place(g, 'A', [-1.5, 1.6, 34]);
  place(g, 'B', [1.5, 1.6, 34]);
  run(g, 1.8);
  assert.equal(g.goal.cleared, false);
  // 한 명이 잠시 나가면 타이머가 초기화된다
  place(g, 'B', [1.5, 1.6, 30]);
  run(g, 0.3);
  assert.equal(g.goal.timer, 0);
  place(g, 'B', [1.5, 1.6, 34]);
  run(g, 2.1);
  assert.equal(g.goal.cleared, true);
  assert.ok(g.events.some((e) => e.k === 'clear'));
  g.handle('B', { t: 'restart' });
  assert.equal(g.goal.cleared, false);
  assert.equal(g.goal.timer, 0);
});

test('T7: 실제 이동·마법만으로 짐을 도착 구역까지 옮겨 클리어(입력 메시지만 사용)', () => {
  const g = newGame();
  const near = (pid, xz) => assert.ok(walkTo(g, pid, xz) < 0.4, `${pid} 이동 실패 → ${xz}`);
  // B: 발견 구역에서 단어 두 개를 줍는다
  near('B', [2, 11]);
  near('B', [4.6, 16.2]);
  assert.ok(g.handle('B', { t: 'pickup' }).ok, 'NEARBY 줍기');
  near('B', [-4.2, 16.5]);
  assert.ok(g.handle('B', { t: 'pickup' }).ok, 'SELF 줍기');
  near('B', [-2.5, 23]);
  near('B', [-1.8, 25.2]);
  // A: 짐 뒤쪽으로
  near('A', [-2, 11]);
  near('A', [-2, 23]);
  near('A', [0, 24.2]);
  // B가 짐을 띄우고 A가 공중의 짐을 도착 구역 쪽으로 민다
  let r = cast(g, 'B', 'cargo');
  assert.ok(r.ok, r.reason);
  run(g, 0.8);
  r = cast(g, 'A', 'cargo');
  assert.ok(r.ok, r.reason);
  run(g, 3.2);
  const cargo = g.body('cargo');
  assert.ok(bottom(cargo) > 1.55 && cargo.grounded, `짐이 단차 위에 착지: ${cargo.pos}`);
  // B가 A를 띄워 단차 위로 올린다
  r = cast(g, 'B', 'A');
  assert.ok(r.ok, r.reason);
  run(g, 0.7);
  near('A', [0, 30.5]);
  assert.ok(bottom(g.body('A')) > 1.55, 'A가 단차 위');
  // B는 「자신을 띄운다」로 스스로 올라간다
  equip(g, 'B', 'target', 't5');
  run(g, 0.3);
  r = cast(g, 'B');
  assert.ok(r.ok, r.reason);
  run(g, 0.7);
  near('B', [-1.5, 30.5]);
  assert.ok(bottom(g.body('B')) > 1.55, 'B가 단차 위');
  // A가 바닥에서 짐을 한 번 더 밀어 도착 구역 안쪽으로
  near('A', [cargo.pos[0], cargo.pos[2] - 1.3]);
  r = cast(g, 'A', 'cargo');
  assert.ok(r.ok, r.reason);
  run(g, 1.5);
  near('A', [-1.6, cargo.pos[2] + 0.5]);
  near('B', [1.6, cargo.pos[2] + 0.5]);
  run(g, 2.2);
  assert.ok(g.goal.inside.cargo && g.goal.inside.A && g.goal.inside.B, JSON.stringify(g.goal.inside));
  assert.equal(g.goal.cleared, true);
  assertTokenInvariant(assert, g);
});

test('조준 표시와 판정 일치: 보고 있던 시점의 위치로 대상을 고른다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 2]);
  place(g, 'B', [0, 0, 6]);
  run(g, 0.3);
  // 클라이언트가 본 시점(과거)의 B 위치를 조준
  const vt = g.time;
  const seen = [...g.body('B').pos];
  // 그 사이 B가 옆으로 빠르게 이동
  g.body('B').ext = [8, 0];
  run(g, 0.1);
  assert.ok(Math.abs(g.body('B').pos[0] - seen[0]) > 0.6, '현재 위치는 조준선에서 벗어남');
  const origin = [...g.body('A').pos];
  const dir = [seen[0] - origin[0], seen[1] - origin[1], seen[2] - origin[2]];
  // 시점 정보가 없으면 현재 위치로 판정해 빗나간다
  assert.equal(g.handle('A', { t: 'cast', origin, dir }).ok, false);
  // 보고 있던 시점을 알려 주면 그때의 위치로 판정한다
  const r = g.handle('A', { t: 'cast', origin, dir, vt });
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.targets, ['B']);
  // 너무 오래된 시점은 기록 한도로 잘린다
  assert.ok(g.viewAt(-100));
});
