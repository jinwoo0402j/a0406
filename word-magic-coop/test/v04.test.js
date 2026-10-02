// 미정 사항 제안안 반영: 모드 조합(주변+들기, 본인·주변+파이어볼), 같이 들기, 새 효과 <당기기>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNING } from '../shared/tuning.js';
import { REASON } from '../shared/targeting.js';
import { newGame, run, place, cast, grab, lookAt, bottom, assertTokenInvariant } from './helpers.js';

const CD = TUNING.castCooldown + 0.02;
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function equip(g, pid, tokenId) {
  grab(g, pid, tokenId);
  assert.ok(g.handle(pid, { t: 'equip', slot: 'effect', token: tokenId }).ok);
}

test('주변+들기: 반경 안의 것을 가벼운 것부터 힘이 닿는 만큼 들고, 시점을 돌리면 같이 돈다', () => {
  const g = newGame();
  place(g, 'B', [0, 0, 8]); place(g, 'rock', [-1.5, 0, 8]); place(g, 'box1', [1.5, 0, 8]); place(g, 'A', [0, 0, 10]);
  run(g, 0.3);
  // 돌 0.5 + 상자 1 = 1.5, 여기에 A(1.6)까지 더하면 3.1로 힘 3을 넘는다 → A는 빠진다
  const r = cast(g, 'B', null, { mode: 'NEAR', dir: [0, 0, 1] });
  assert.ok(r.ok);
  assert.deepEqual([...r.targets].sort(), ['box1', 'rock']);
  assert.deepEqual(g.body('A').heldBy, []);
  lookAt(g, 'B', [0, 1, 12]);
  run(g, 1.5);
  for (const id of ['rock', 'box1']) {
    assert.deepEqual(g.body(id).heldBy, ['B']);
    assert.ok(bottom(g.body(id)) > 1.2, `${id}가 떠오른다 ${bottom(g.body(id)).toFixed(2)}`);
  }
  assert.ok(g.body('rock').pos[0] < -0.8 && g.body('box1').pos[0] > 0.8, '처음 자리 배치 그대로');
  // 시점을 천천히 뒤로 돌리면 둘레를 따라 돈다(왼쪽에 있던 돌이 오른쪽으로)
  let yaw = 0;
  run(g, 1.5, () => { yaw = Math.min(Math.PI, yaw + Math.PI / 80); lookAt(g, 'B', [Math.sin(yaw) * 4, 1, 8 + Math.cos(yaw) * 4]); });
  run(g, 1.5);
  assert.ok(g.body('rock').pos[0] > 0.8 && g.body('box1').pos[0] < -0.8, `회전: 돌 x=${g.body('rock').pos[0].toFixed(2)}`);
  // 시전 종료하면 모두 떨어진다
  assert.ok(g.handle('B', { t: 'endCast' }).ok);
  run(g, 1.5);
  assert.ok(bottom(g.body('rock')) < 0.05 && bottom(g.body('box1')) < 0.05);
  // 힘이 닿는 게 하나도 없으면 거절
  run(g, CD);
  place(g, 'B', [2.4, 0, 16.5]); run(g, 0.3);
  assert.equal(cast(g, 'B', null, { mode: 'NEAR' }).reason, REASON.TOO_HEAVY, '무거운 상자만 있으면 못 든다');
});

test('본인+파이어볼: 발밑 폭발 — 시전자는 피해 없이 땅에서만 튀어 오르고(단차는 못 넘음), 주변은 폭발을 맞는다', () => {
  const g = newGame();
  equip(g, 'A', 'w1');
  place(g, 'A', [-1, 0, 16]); place(g, 'B', [-0.2, 0, 16]); place(g, 'dummy', [-1, 0, 17.2]);
  run(g, 0.3);
  const r = cast(g, 'A', null, { mode: 'SELF' });
  assert.ok(r.ok && r.launched);
  const boom = g.events.filter((e) => e.k === 'boom').at(-1);
  assert.equal(boom.by, 'A');
  assert.ok(boom.hits.some((h) => h.id === 'B' && h.effects.includes('debuff')), '친구는 디버프');
  assert.ok(boom.hits.some((h) => h.id === 'dummy' && h.effects.includes('damage')), '적은 피해');
  assert.ok(!boom.hits.some((h) => h.id === 'A'), '시전자는 제외');
  assert.equal(g.body('A').debuffUntil, 0);
  let top = 0;
  run(g, 1.2, () => { top = Math.max(top, bottom(g.body('A'))); });
  assert.ok(top > 0.4 && top < 1.0, `튀어 오른 높이 ${top.toFixed(2)}m (단차 1.6m 미만)`);
  // 공중에서 쓰면 튀어 오르지 않는다(점프와 겹쳐 단차를 넘지 못하게)
  run(g, CD);
  g.handle('A', { t: 'input', wish: [0, 0], jump: true });
  run(g, 0.25);
  assert.ok(!g.body('A').grounded);
  assert.equal(cast(g, 'A', null, { mode: 'SELF' }).launched, false);
});

test('주변+파이어볼: 사방으로 4발, 각각 실제로 맞은 대상에만 적용(뒤쪽 허수아비도 맞는다)', () => {
  const g = newGame();
  equip(g, 'A', 'w1');
  place(g, 'A', [-1, 0, 16]); place(g, 'dummy', [-1, 0, 13.6]); place(g, 'B', [5, 0, 10]);
  run(g, 0.3);
  const r = cast(g, 'A', null, { mode: 'NEAR', dir: [0, 0, 1] });
  assert.ok(r.ok);
  assert.equal(r.projectiles.length, 4);
  assert.equal(g.body('dummy').hp, 100, '발사 순간에는 아무것도 적용되지 않는다');
  const dirs = g.projectiles.map((p) => [Math.sign(Math.round(p.vel[0])), Math.sign(Math.round(p.vel[2]))].join(','));
  assert.deepEqual(dirs.sort(), ['-1,0', '0,-1', '0,1', '1,0'].sort());
  run(g, 1.5);
  assert.ok(g.body('dummy').hp < 100, '뒤쪽으로 간 투사체가 맞힌다');
  assert.equal(g.body('A').debuffUntil, 0, '자기 투사체는 맞지 않는다');
});

test('같이 들기: 혼자 못 드는 상자를 붙잡고 있다가 친구가 합류하면 올라가고, 한 명이 놓으면 다시 내려앉는다', () => {
  const g = newGame({ seats: ['A', 'B', 'D'] }); // B·D가 <들기>
  place(g, 'B', [1.2, 0, 16]); place(g, 'D', [3.6, 0, 16]); place(g, 'A', [-4, 0, 6]);
  run(g, 0.3);
  const box = g.body('box2');
  const look = () => { lookAt(g, 'B', [2.4, 3, 18.4]); lookAt(g, 'D', [2.4, 3, 18.4]); };
  const r1 = cast(g, 'B', 'box2');
  assert.ok(r1.ok);
  assert.deepEqual(r1.heavy, ['box2'], '혼자서는 붙잡기만');
  run(g, 1, look);
  assert.ok(bottom(box) < 0.05, '혼자서는 안 올라간다');
  const r2 = cast(g, 'D', 'box2');
  assert.ok(r2.ok);
  assert.deepEqual(r2.joined, ['box2'], 'D가 합류');
  assert.deepEqual(r2.heavy, [], '둘이면 1.8씩이라 들린다');
  assert.deepEqual(box.heldBy, ['B', 'D']);
  run(g, 2, look);
  assert.ok(bottom(box) > 0.8, `같이 들어 올린다 ${bottom(box).toFixed(2)}m`);
  // 물체는 두 사람의 목표 지점 가운데로 간다: B는 왼쪽, D는 오른쪽 앞을 보면 그 사이
  run(g, 2, () => { lookAt(g, 'B', [0.5, 2.5, 19]); lookAt(g, 'D', [4.5, 2.5, 19]); });
  assert.ok(box.pos[0] > 1.6 && box.pos[0] < 3.2, `가운데 x=${box.pos[0].toFixed(2)}`);
  // 한 명이 시전 종료 → 남은 사람의 힘으로는 버거워 내려앉지만 붙잡은 채
  assert.ok(g.handle('D', { t: 'endCast' }).ok);
  run(g, 2, look);
  assert.deepEqual(box.heldBy, ['B']);
  assert.ok(bottom(box) < 0.05, '다시 내려앉는다');
  assert.equal(g.snapshot().b.find((x) => x.id === 'box2').hv, 1);
  // R(친구 마법에서 벗어나기)은 들고 있는 사람에게 영향 없음, 시전 종료만 놓는다
  assert.ok(g.handle('B', { t: 'endCast' }).ok);
  assert.deepEqual(box.heldBy, []);
});

test('같이 들기: 친구를 둘이 들면 무게를 나눠 더 높이 들고, 들린 사람이 R을 누르면 모두에게서 풀려난다', () => {
  const g = newGame({ seats: ['A', 'B', 'D'] });
  place(g, 'A', [0, 0, 8]); place(g, 'B', [-1.5, 0, 6]); place(g, 'D', [1.5, 0, 6]);
  run(g, 0.3);
  assert.ok(cast(g, 'B', 'A').ok);
  assert.ok(cast(g, 'D', 'A').ok);
  assert.deepEqual(g.body('A').heldBy, ['B', 'D']);
  run(g, 2, () => { lookAt(g, 'B', [0, 6, 8]); lookAt(g, 'D', [0, 6, 8]); });
  const together = bottom(g.body('A'));
  assert.ok(g.handle('A', { t: 'release' }).ok);
  assert.deepEqual(g.body('A').heldBy, []);
  assert.equal(g.players.B.holding, null);
  assert.equal(g.players.D.holding, null);
  // 혼자 들 때보다 높다
  run(g, TUNING.releaseImmunity + 0.5);
  place(g, 'A', [0, 0, 8]); run(g, 0.3);
  assert.ok(cast(g, 'B', 'A').ok);
  run(g, 2, () => lookAt(g, 'B', [0, 6, 8]));
  assert.ok(together > bottom(g.body('A')) + 0.5, `둘 ${together.toFixed(2)}m > 혼자 ${bottom(g.body('A')).toFixed(2)}m`);
});

test('<당기기>: 대상을 내 앞까지 끌어오고(지나치지 않음), 주변 것을 모으고, 지형을 당기면 내가 끌려간다', () => {
  const g = newGame();
  equip(g, 'A', 'w7');
  assert.equal(g.effectWord('A'), 'PULL');
  // 조준: 6m 떨어진 돌이 내 앞에 와서 멈춘다
  place(g, 'A', [0, 0, 4]); place(g, 'rock', [0, 0, 10]); run(g, 0.3);
  assert.ok(cast(g, 'A', 'rock').ok);
  run(g, 2);
  const d = flat(g.body('rock').pos, g.body('A').pos);
  assert.ok(d > 0.6 && d < 2.2 && g.body('rock').pos[2] > g.body('A').pos[2], `돌이 앞에 멈춤: ${d.toFixed(2)}m`);
  // 친구 구해 오기
  run(g, CD);
  place(g, 'B', [-3, 0, 9]); run(g, 0.3);
  const before = flat(g.body('B').pos, g.body('A').pos);
  assert.ok(cast(g, 'A', 'B').ok);
  run(g, 2);
  assert.ok(flat(g.body('B').pos, g.body('A').pos) < before - 2.5, '친구가 끌려온다');
  // 주변: 반경 안의 것들을 모은다
  run(g, CD);
  place(g, 'A', [0, 0, 6]); place(g, 'rock', [-2.6, 0, 6]); place(g, 'box1', [2.6, 0, 6]); place(g, 'B', [-5, 0, 2]);
  run(g, 0.3);
  const r = cast(g, 'A', null, { mode: 'NEAR' });
  assert.deepEqual([...r.targets].sort(), ['box1', 'rock']);
  run(g, 2);
  assert.ok(flat(g.body('rock').pos, g.body('A').pos) < 1.8 && flat(g.body('box1').pos, g.body('A').pos) < 1.8, '가까이 모인다');
  // 지형(오른쪽 벽)을 당기면 내가 벽 쪽으로 끌려간다. 수평으로만이라 높이 변화 없음
  run(g, CD);
  place(g, 'A', [2, 0, 6]); place(g, 'rock', [-3, 0, 6]); place(g, 'box1', [-3, 0, 8]); run(g, 0.3);
  const x0 = g.body('A').pos[0];
  let top = 0;
  const wall = g.handle('A', { t: 'cast', mode: 'AIM', origin: [...g.body('A').pos], dir: [1, 0, 0] });
  assert.ok(wall.ok);
  assert.deepEqual(wall.targets, ['A']);
  run(g, 2, () => { top = Math.max(top, bottom(g.body('A'))); });
  assert.ok(g.body('A').pos[0] > x0 + 3, `끌려감: x ${x0.toFixed(2)} → ${g.body('A').pos[0].toFixed(2)}`);
  assert.ok(top < 0.05, '뜨지 않는다');
  // 본인 모드는 막아 둠
  run(g, CD);
  assert.match(cast(g, 'A', null, { mode: 'SELF' }).reason, /본인 모드로 쓸 수 없어요/);
  // 보호 중인 친구는 당길 수 없다
  place(g, 'B', [2, 0, 9]); run(g, 0.3);
  g.handle('B', { t: 'release' });
  assert.equal(cast(g, 'A', 'B').reason, REASON.PROTECTED);
  assertTokenInvariant(assert, g, 8);
});

test('고리로 들 수 없다: B가 D를, D가 F를 들고 있으면 F는 B를 못 든다(끝없이 올라가는 것 방지)', () => {
  const g = newGame({ seats: ['B', 'D', 'F'] }); // 셋 다 <들기>
  place(g, 'B', [-2, 0, 6]); place(g, 'D', [2, 0, 6]); place(g, 'F', [0, 0, 9]);
  run(g, 0.3);
  assert.ok(cast(g, 'B', 'D').ok);
  run(g, 0.3);
  assert.ok(cast(g, 'D', 'F').ok);
  run(g, 0.3);
  assert.equal(cast(g, 'F', 'B').reason, REASON.HOLDING_YOU);
  assert.equal(cast(g, 'F', 'D').reason, REASON.HOLDING_YOU, '직접 들고 있는 사람도');
});

test('2인 플레이에서도 같이 들기: 발견 구역의 <들기>를 A가 주워 B와 함께 무거운 상자를 든다', () => {
  const g = newGame();
  equip(g, 'A', 'w8');
  place(g, 'A', [1.2, 0, 16]); place(g, 'B', [3.6, 0, 16]);
  run(g, 0.3);
  assert.deepEqual(cast(g, 'B', 'box2').heavy, ['box2']);
  assert.deepEqual(cast(g, 'A', 'box2').joined, ['box2']);
  run(g, 2, () => { lookAt(g, 'A', [2.4, 3, 18.4]); lookAt(g, 'B', [2.4, 3, 18.4]); });
  assert.ok(bottom(g.body('box2')) > 0.8);
});
