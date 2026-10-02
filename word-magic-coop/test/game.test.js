// v0.3 반영 후 확인 기준 T1~T6 (T7 두 화면 일치는 net.test.js)과 유지되는 기본 규칙
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNING } from '../shared/tuning.js';
import { REASON } from '../shared/targeting.js';
import { newGame, run, place, cast, grab, attach, lookAt, bottom, assertTokenInvariant, walkTo, addBig } from './helpers.js';

const CD = TUNING.castCooldown + 0.02;
const angleOf = (c, p) => Math.atan2(p[0] - c[0], p[2] - c[2]);

test('T1: 대상은 모드 전환으로 고르고, 같은 <밀치기>가 조준 대상·본인·주변에 모두 쓰인다(단어 교체 없음)', () => {
  const g = newGame();
  const slots = JSON.stringify(g.players.A.slots);
  const setup = () => {
    place(g, 'A', [0, 0, 8]); place(g, 'B', [1.5, 0, 8]); place(g, 'rock', [-1.5, 0, 8]);
    run(g, 0.3);
  };
  setup();
  let r = cast(g, 'A', 'B');
  assert.deepEqual(r.targets, ['B']);
  run(g, CD); setup();
  r = cast(g, 'A', null, { mode: 'SELF', dir: [1, 0, 0] });
  assert.deepEqual(r.targets, ['A']);
  assert.ok(g.body('A').ext[0] > 3.9);
  run(g, CD); setup();
  r = cast(g, 'A', null, { mode: 'NEAR' });
  assert.deepEqual([...r.targets].sort(), ['B', 'rock']);
  assert.ok(g.body('B').ext[0] > 3.9 && g.body('rock').ext[0] < -3.9, '바깥쪽으로 퍼진다');
  assert.equal(JSON.stringify(g.players.A.slots), slots, '장착 단어는 그대로');
  // 막아 둔 모드 조합: 본인 + 들기(혼자 높은 곳에 오르면 협동이 깨진다)
  run(g, CD);
  assert.match(cast(g, 'B', null, { mode: 'SELF' }).reason, /본인 모드로 쓸 수 없어요/);
  // 수식은 효과 칸에 넣을 수 없다
  grab(g, 'A', 'w2');
  assert.equal(g.handle('A', { t: 'equip', slot: 'effect', token: 'w2' }).ok, false);
});

test('T2: 파이어볼은 날아가서 실제로 맞은 대상에 적용한다(미리 적용 없음, 가로막으면 막은 대상이 맞는다)', () => {
  const g = newGame();
  grab(g, 'A', 'w1');
  g.handle('A', { t: 'equip', slot: 'effect', token: 'w1' });
  place(g, 'A', [-2.6, 0, 12.8]);
  place(g, 'B', [5, 0, 10]);
  run(g, 0.3);
  const r = cast(g, 'A', 'dummy');
  assert.ok(r.ok && g.projectiles.length === 1);
  assert.equal(g.body('dummy').hp, 100, '발사 순간에는 아무것도 적용되지 않는다');
  assert.ok(!g.events.some((e) => e.k === 'boom'));
  // 날아가는 도중 B가 앞을 가로막는다
  run(g, 0.1);
  place(g, 'B', [-2.6, 0, 16.3]);
  run(g, 1);
  const boom = g.events.filter((e) => e.k === 'boom').at(-1);
  assert.equal(boom.direct, 'B', '실제로 맞은 것은 B');
  assert.equal(g.body('dummy').hp, 100, '조준했던 허수아비는 피해 없음');
  assert.ok(g.body('B').debuffUntil > g.time);
  // 가로막는 사람이 없으면 허수아비가 맞는다
  place(g, 'B', [5, 0, 10]);
  run(g, CD);
  cast(g, 'A', 'dummy');
  run(g, 1);
  assert.ok(g.body('dummy').hp < 100);
});

test('T3: 밀치기는 즉시·한 번, 들기는 시전 종료까지 유지되며 시점을 계속 따라온다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 5]); place(g, 'B', [0, 0, 7]); place(g, 'rock', [2, 0, 9]);
  run(g, 0.3);
  // 밀치기: 시전하는 그 순간 적용(이동을 기다리지 않음)
  cast(g, 'A', 'B');
  assert.ok(g.body('B').ext[1] > 3.9);
  // 들기: 시전 후 놓을 때까지 계속 들려 있고 대기시간은 놓을 때 시작
  place(g, 'B', [0, 0, 7]); run(g, 0.5);
  assert.ok(cast(g, 'B', 'rock').ok);
  assert.deepEqual(g.body('rock').heldBy, ['B']);
  assert.equal(g.players.B.cooldownUntil, 0);
  const b = g.body('B');
  for (const [x, z] of [[4, 9], [-3, 9], [0, 10]]) {
    lookAt(g, 'B', [x, 1.8, z]);
    run(g, 1.2);
    const rp = g.body('rock').pos;
    assert.ok(Math.abs(angleOf(b.pos, rp) - angleOf(b.pos, [x, 0, z])) < 0.15, `시선(${x},${z})을 따라온다`);
  }
  assert.deepEqual(g.body('rock').heldBy, ['B'], '2초 넘게 지나도 유지');
  assert.equal(cast(g, 'B', 'rock').ok, false, '유지 중에는 새로 시전하지 않는다');
  g.handle('B', { t: 'endCast' });
  assert.deepEqual(g.body('rock').heldBy, []);
  assert.ok(g.players.B.cooldownUntil > g.time);
  run(g, 1.5);
  assert.ok(g.body('rock').grounded, '놓으면 떨어진다');
});

test('시전 종료: 자신이 유지하는 마법은 시전자만 끝내고, R(친구 마법에서 벗어나기)과는 별개다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 5]); place(g, 'B', [0, 0, 7]); place(g, 'rock', [2, 0, 9]);
  run(g, 0.3);
  assert.equal(g.handle('B', { t: 'endCast' }).ok, false, '유지 중인 마법이 없으면 아무 일도 없다');
  assert.ok(cast(g, 'B', 'rock').ok);
  g.drainEvents();
  // 유지 중 재시전은 거절되고, 이유는 시전 종료를 안내한다
  const again = cast(g, 'B', 'rock');
  assert.equal(again.reason, REASON.SUSTAINING);
  assert.ok(g.drainEvents().some((e) => e.k === 'castFail' && e.to === 'B' && e.reason === REASON.SUSTAINING));
  // 시전자 본인의 R은 해제(남이 건 마법에서 벗어나기)일 뿐, 자기 들기를 끝내지 않는다
  g.handle('B', { t: 'release' });
  run(g, 0.3);
  assert.deepEqual(g.body('rock').heldBy, ['B']);
  // 다른 사람이 시전 종료를 눌러도 B의 들기는 계속된다
  assert.equal(g.handle('A', { t: 'endCast' }).ok, false);
  assert.deepEqual(g.body('rock').heldBy, ['B']);
  // 시전자가 시전 종료 → 놓는다
  assert.ok(g.handle('B', { t: 'endCast' }).ok);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.k === 'liftEnd' && e.by === 'B' && e.target === 'rock' && e.reason === 'released'));
  assert.deepEqual(g.body('rock').heldBy, []);
  run(g, 1.5);
  assert.ok(g.body('rock').grounded, '놓으면 떨어진다');
});

test('T4: 들기 — 무게별 높이, 힘 부족, 시점 회전을 늦게 따라오고 멈춘 뒤 더 움직였다 돌아온다', () => {
  const g = newGame();
  // 무게별 높이: 같은 시선(위쪽)으로 들어도 돌이 짐보다 높다
  const liftHeight = (id, at) => {
    place(g, 'B', [0, 0, at - 2.5]); place(g, id, [0, 0, at]);
    run(g, 0.3);
    assert.ok(cast(g, 'B', id).ok, `${id} 들기`);
    lookAt(g, 'B', [0, 8, at]);
    run(g, 2);
    const h = bottom(g.body(id));
    g.handle('B', { t: 'endCast' });
    run(g, 1.5);
    return h;
  };
  const rockH = liftHeight('rock', 9);
  const cargoH = liftHeight('cargo', 26.5);
  assert.ok(rockH > cargoH + 1, `돌 ${rockH.toFixed(2)}m > 짐 ${cargoH.toFixed(2)}m`);
  // 힘 부족: 무거운 상자는 혼자 붙잡을 수는 있지만 바닥에서 뜨지 않는다. <세게> 하나면 들 수 있다.
  place(g, 'B', [2.4, 0, 16]); run(g, 0.3);
  const heavy = cast(g, 'B', 'box2');
  assert.ok(heavy.ok);
  assert.deepEqual(heavy.heavy, ['box2'], '붙잡기만 된다는 표시');
  lookAt(g, 'B', [2.4, 3, 18.4]); run(g, 1.5);
  assert.ok(bottom(g.body('box2')) < 0.05, '혼자서는 안 올라간다');
  assert.equal(g.snapshot().b.find((x) => x.id === 'box2').hv, 1);
  g.handle('B', { t: 'endCast' });
  run(g, CD);
  grab(g, 'B', 'w5');
  attach(g, 'B');
  place(g, 'B', [2.4, 0, 16]); run(g, 0.3);
  const strong = cast(g, 'B', 'box2');
  assert.ok(strong.ok && !strong.heavy.length, '<세게> 1개로 들 수 있다');
  lookAt(g, 'B', [2.4, 3, 18.4]); run(g, 1.5);
  assert.ok(bottom(g.body('box2')) > 0.4, `<세게>로 들려 올라간다 ${bottom(g.body('box2')).toFixed(2)}`);
  g.handle('B', { t: 'endCast' });
  run(g, CD);

  // 관성: 시선을 일정 속도로 돌리면 늦게 따라오고, 멈추면 지나쳤다가 돌아온다
  place(g, 'B', [0, 0, 6]); place(g, 'rock', [0, 0, 9]); run(g, 0.5);
  assert.ok(cast(g, 'B', 'rock').ok);
  const c = () => g.body('B').pos;
  let yaw = 0;
  const look = () => lookAt(g, 'B', [c()[0] + Math.sin(yaw) * 3, 1.6, c()[2] + Math.cos(yaw) * 3]);
  look(); run(g, 1.5);
  let maxLag = 0;
  run(g, 0.5, () => { yaw += 2.5 / 60; look(); maxLag = Math.max(maxLag, yaw - angleOf(c(), g.body('rock').pos)); });
  const stopYaw = yaw;
  let maxPast = 0;
  run(g, 1.2, () => { look(); maxPast = Math.max(maxPast, angleOf(c(), g.body('rock').pos) - stopYaw); });
  run(g, 1.5, look);
  const settle = Math.abs(angleOf(c(), g.body('rock').pos) - stopYaw);
  assert.ok(maxLag > 0.1, `돌릴 때 늦게 따라온다(최대 지연 ${maxLag.toFixed(2)}rad)`);
  assert.ok(maxPast > 0.02, `멈춘 뒤 지나친다(${maxPast.toFixed(3)}rad)`);
  assert.ok(settle < 0.05, `다시 바라보는 쪽으로 돌아온다(${settle.toFixed(3)}rad)`);
  // 딛고 선 물체는 들 수 없다(무한 상승 방지)
  g.handle('B', { t: 'endCast' }); run(g, CD);
  place(g, 'box1', [0, 0, 12]); place(g, 'B', [0, 0.9, 12]); run(g, 0.3);
  assert.equal(g.body('B').groundId, 'box1');
  const bp = g.body('B').pos;
  assert.equal(g.handle('B', { t: 'cast', mode: 'AIM', origin: [...bp], dir: [0, -1, 0] }).reason, REASON.STANDING_ON);
});

test('T5: <큰>은 0/1/3개에 따라 결과가 다르고, 가진 것보다 많이 붙이거나 넘긴 뒤 복제되지 않는다', () => {
  const g = newGame();
  addBig(g);
  grab(g, 'A', 'w1');
  g.handle('A', { t: 'equip', slot: 'effect', token: 'w1' });
  for (const id of ['w2', 'w3', 'w4']) grab(g, 'A', id);
  assert.equal(g.modCounts('A').BIG, 0, '마인크래프트처럼 주우면 가방으로(자동으로 안 붙음)');
  assert.ok(attach(g, 'A').ok, '가방 창에서 수식 칸에 넣는다');
  assert.equal(g.modCounts('A').BIG, 3);
  const radiusWith = (n) => {
    g.handle('A', { t: 'mod', word: 'BIG', count: n });
    place(g, 'A', [0, 0, 8]); run(g, CD);
    const r = g.handle('A', { t: 'cast', mode: 'AIM', origin: [0, 1, 7], dir: [0, 0, 1] });
    assert.ok(r.ok);
    return g.projectiles.find((p) => p.id === r.projectile).radius;
  };
  const [r0, r1, r3] = [radiusWith(0), radiusWith(1), radiusWith(3)];
  assert.ok(r0 < r1 && r1 < r3, `반지름 ${r0} < ${r1} < ${r3}`);
  assert.equal(g.handle('A', { t: 'mod', word: 'BIG', count: 9 }).count, 3, '가진 개수까지만');
  // 하나를 B에게 던져 주면(Q → 닿아서 줍기) A는 2개, B는 1개
  place(g, 'A', [-5, 0, 8]); place(g, 'B', [-5, 0, 9.2]); run(g, 0.3); // 출발 구역 가운데의 <당기기> 단어를 피해서
  assert.ok(g.handle('A', { t: 'throw', token: 'w4', dir: [0, 0, 1] }).ok);
  run(g, 1);
  assert.equal(g.token('w4').owner, 'B');
  assert.equal(g.modCounts('A').BIG, 2);
  assert.equal(g.modCounts('B').BIG, 0, '받은 수식도 가방으로');
  attach(g, 'B');
  assert.equal(g.modCounts('B').BIG, 1);
  assertTokenInvariant(assert, g, 10);
  // <세게>는 밀치기 힘을 올린다
  const g2 = newGame();
  place(g2, 'A', [0, 0, 5]); place(g2, 'B', [0, 0, 7]); run(g2, 0.3);
  cast(g2, 'A', 'B');
  const base = g2.body('B').ext[1];
  run(g2, 2);
  grab(g2, 'A', 'w5');
  attach(g2, 'A');
  place(g2, 'A', [0, 0, 5]); place(g2, 'B', [0, 0, 7]); run(g2, 0.3);
  cast(g2, 'A', 'B');
  assert.ok(g2.body('B').ext[1] > base * 1.2, `<세게> ${g2.body('B').ext[1].toFixed(2)} > ${base.toFixed(2)}`);
});

test('T6: 같은 파이어볼이 적에게는 피해, 친구에게는 디버프(체력 감소 없음), 시전자 자신은 제외', () => {
  const g = newGame();
  grab(g, 'A', 'w1');
  g.handle('A', { t: 'equip', slot: 'effect', token: 'w1' });
  // 적(허수아비): 피해, 체력이 0이 되면 쓰러졌다가 다시 선다
  place(g, 'A', [-2.6, 0, 15]); place(g, 'B', [4, 0, 12]); run(g, 0.3);
  for (let i = 0; i < 4; i++) { cast(g, 'A', 'dummy'); run(g, CD + 0.4); }
  assert.ok(g.events.some((e) => e.k === 'dummyDown'));
  run(g, TUNING.dummyRespawn);
  assert.equal(g.body('dummy').hp, TUNING.dummyHp);
  // 친구: 디버프로 잠시 느려진다(체력 개념 없음)
  place(g, 'A', [0, 0, 5]); place(g, 'B', [0, 0, 8]); run(g, CD);
  cast(g, 'A', 'B');
  run(g, 0.4);
  const boom = g.events.filter((e) => e.k === 'boom').at(-1);
  assert.deepEqual(boom.hits.find((h) => h.id === 'B').effects.sort(), ['debuff', 'push']);
  assert.equal(g.body('B').hp, null);
  assert.ok(!boom.hits.some((h) => h.id === 'A'), '시전자는 폭발에서 제외');
  run(g, 0.5);
  const z0 = g.body('B').pos[2];
  g.handle('B', { t: 'input', wish: [0, 1] });
  run(g, 0.6);
  const slow = g.body('B').pos[2] - z0;
  run(g, TUNING.allyDebuffDuration);
  const z1 = g.body('B').pos[2];
  run(g, 0.6);
  const normal = g.body('B').pos[2] - z1;
  assert.ok(slow < normal * 0.75, `디버프 중 ${slow.toFixed(2)}m < 평소 ${normal.toFixed(2)}m`);
});

test('유지: R은 자신에게 걸린 들림·외부 이동을 풀고 다른 사람의 마법에 잠시 면역', () => {
  const g = newGame();
  place(g, 'B', [0, 0, 4]); place(g, 'A', [0, 0, 6]); run(g, 0.3);
  assert.ok(cast(g, 'B', 'A').ok);
  lookAt(g, 'B', [0, 3, 6]); run(g, 0.6);
  assert.ok(bottom(g.body('A')) > 0.5);
  assert.ok(g.handle('A', { t: 'release' }).ok);
  assert.deepEqual(g.body('A').heldBy, []);
  assert.equal(g.players.B.holding, null);
  run(g, CD);
  assert.equal(cast(g, 'B', 'A').reason, REASON.PROTECTED);
  run(g, TUNING.releaseImmunity);
  assert.ok(cast(g, 'B', 'A').ok, '면역이 끝나면 다시 적용');
});

test('유지: 넘긴 <세게>로는 계속 강화할 수 없고(무거운 물체가 내려앉음), <들기>를 내려놓으면 놓친다', () => {
  const g = newGame();
  grab(g, 'B', 'w5');
  attach(g, 'B');
  place(g, 'B', [2.4, 0, 16]); place(g, 'A', [0, 0, 16]); run(g, 0.3);
  assert.ok(cast(g, 'B', 'box2').ok, '<세게>로 무거운 상자를 든다');
  lookAt(g, 'B', [2.4, 3, 18.4]); run(g, 1.5);
  assert.ok(bottom(g.body('box2')) > 0.4);
  g.handle('B', { t: 'drop', token: 'w5' });
  run(g, 1.5);
  assert.deepEqual(g.body('box2').heldBy, ['B'], '붙잡은 채로');
  assert.ok(bottom(g.body('box2')) < 0.05, '힘이 모자라 내려앉는다(넘긴 <세게>로는 더 이상 강화되지 않는다)');
  g.handle('B', { t: 'drop', token: 't2' });
  run(g, 0.1);
  assert.deepEqual(g.body('box2').heldBy, [], '<들기>를 내려놓으면 놓친다');
  assert.ok(g.events.some((e) => e.k === 'liftEnd' && e.reason === 'word'));
  assert.equal(g.effectWord('B'), null);
  assertTokenInvariant(assert, g, 8);
});

test('유지: 낙하 복구·단어 복구·동시 줍기·재시작에서 소유권과 토큰 수 보존', () => {
  const g = newGame();
  place(g, 'A', [-5.5, 0, 16.5]); place(g, 'B', [-4.5, 0, 16.5]); run(g, 0.2);
  const w1 = g.token('w1');
  assert.ok(w1.owner === 'A' || w1.owner === 'B', '둘이 동시에 닿아도 한 사람만 줍는다');
  assert.equal(g.events.filter((e) => e.k === 'pickup' && e.token === 'w1').length, 1);
  assertTokenInvariant(assert, g, 8);
  // 사람·짐이 떨어지면 같은 지면의 안전 지점으로
  place(g, 'B', [7.2, 0, 26]); place(g, 'A', [5.5, 0, 26]); run(g, 0.3);
  if (g.effectWord('A') !== 'PUSH') g.handle('A', { t: 'equip', slot: 'effect', token: 't1' });
  assert.ok(cast(g, 'A', 'B').ok);
  run(g, 3);
  assert.ok(g.events.some((e) => e.k === 'recover' && e.id === 'B'));
  assert.ok(g.body('B').grounded && Math.abs(bottom(g.body('B'))) < 0.01);
  // 낭떠러지 밖에 내려놓은 단어는 안전 지점으로
  place(g, 'A', [5.5, 1.6, 33]); run(g, 0.3);
  g.body('A').yaw = Math.PI / 2;
  g.handle('A', { t: 'drop', token: 't1' });
  run(g, 2.5);
  const t1 = g.token('t1');
  assert.ok(t1.pos && t1.pos[1] > 1.5);
  // 재시작: 위치·소유권·장착·효과·대기시간·투사체·체력
  g.handle('A', { t: 'restart' });
  assert.deepEqual(g.players.A.slots, { effect: 't1', mods: [] });
  assert.deepEqual(g.players.B.slots, { effect: 't2', mods: [] });
  assert.equal(g.token('w1').owner, null);
  assert.equal(g.projectiles.length, 0);
  assert.equal(g.body('dummy').hp, TUNING.dummyHp);
  assert.deepEqual(g.body('A').pos, [-1.5, 0.65, 1]);
  assertTokenInvariant(assert, g, 8);
});

test('클리어: 짐 + 접속한 모든 사람이 도착 구역에 2초 이상', () => {
  const g = newGame();
  place(g, 'cargo', [0, 1.6, 34]); place(g, 'A', [-1.5, 1.6, 34]); place(g, 'B', [1.5, 1.6, 34]);
  run(g, 1.8);
  assert.equal(g.goal.cleared, false);
  run(g, 0.4);
  assert.equal(g.goal.cleared, true);
});

test('실제 조작만으로 클리어: B가 A를 들어 올리고, <들기>를 넘겨받은 A가 B와 짐을 단차 위로 끌어올린다', () => {
  const g = newGame();
  const near = (pid, xz) => assert.ok(walkTo(g, pid, xz) < 0.4, `${pid} 이동 실패 → ${xz} (현재 ${g.body(pid).pos.map((v) => v.toFixed(2))})`);
  // 시선을 point로 두고(필요하면 걸으면서) seconds 동안 유지
  const hold = (pid, point, seconds, wish = [0, 0]) => run(g, seconds, () => lookAt(g, pid, point, wish));
  // 허수아비(-2.6, 19.6)·낮은 턱·무거운 상자(2.4, 18.4)·짐(0, 26)을 피해서 이동
  near('A', [-1.7, 11]); near('A', [-1.7, 23]); near('A', [-1.6, 28.3]);
  near('B', [1.5, 11]); near('B', [1.5, 13.5]); near('B', [3.4, 16]); near('B', [3.4, 23]); near('B', [-1.6, 26]);

  // 1) B가 A를 들고 단차 쪽으로 걸어가 위에 올려 준다(사람 무게면 단차 높이를 넘겨 들 수 있다)
  assert.ok(cast(g, 'B', 'A').ok, 'B가 A를 든다');
  hold('B', [-1.6, 4, 28.3], 1.2);
  hold('B', [-1.6, 4.5, 31], 1.2, [0, 1]);
  hold('B', [-1.6, 4.5, 31], 0.6);
  g.handle('B', { t: 'endCast' });
  run(g, 1);
  assert.ok(bottom(g.body('A')) > 1.55 && g.body('A').grounded, `A가 단차 위: ${g.body('A').pos}`);

  // 2) B가 단차 앞에 <들기>를 내려놓고, A가 위에서 줍는다
  near('A', [-1.6, 29.5]);
  g.body('B').yaw = 0;
  g.handle('B', { t: 'drop', token: 't2' });
  run(g, 0.5);
  assert.ok(g.handle('A', { t: 'pickup' }).ok, 'A가 단차 위에서 <들기>를 줍는다');
  assert.ok(g.handle('A', { t: 'equip', slot: 'effect', token: 't2' }).ok);

  // 3) A가 B를 끌어올린다(단차 위에 서 있으면 그만큼 높이 든다)
  near('B', [-1.6, 27.4]);
  run(g, CD);
  assert.ok(cast(g, 'A', 'B').ok, 'A가 B를 든다');
  hold('A', [-1.6, 5, 28], 1.2);
  hold('A', [0, 3.5, 31], 1.5);
  g.handle('A', { t: 'endCast' });
  run(g, 1);
  assert.ok(bottom(g.body('B')) > 1.55 && g.body('B').grounded, `B가 단차 위: ${g.body('B').pos}`);

  // 4) A가 짐을 끌어올려(머리 위를 지나지 않게 옆으로 돌려서) 도착 구역에 내려놓는다
  run(g, CD);
  assert.ok(cast(g, 'A', 'cargo').ok, 'A가 짐을 든다');
  hold('A', [0, 6, 26.5], 1.5);
  hold('A', [3, 3, 29.5], 1.5);
  hold('A', [0.5, 3, 33], 1.5);
  g.handle('A', { t: 'endCast' });
  run(g, 1.2);
  const cargo = g.body('cargo');
  assert.ok(bottom(cargo) > 1.55 && cargo.grounded, `짐이 단차 위: ${cargo.pos}`);

  // 5) 두 사람도 도착 구역으로
  // 도착 구역 안에서 짐과 겹치지 않는 x에 한 명씩
  const bx = cargo.pos[0] > 0.5 ? -0.3 : 2.2;
  near('A', [-2.2, 30.2]); near('A', [-2.2, 34.5]);
  near('B', [bx, 30.8]); near('B', [bx, 34.5]);
  run(g, 2.2);
  assert.ok(g.goal.inside.cargo && g.goal.inside.A && g.goal.inside.B, JSON.stringify(g.goal.inside) + ` cargo=${cargo.pos}`);
  assert.equal(g.goal.cleared, true);
  assertTokenInvariant(assert, g, 8);
});
