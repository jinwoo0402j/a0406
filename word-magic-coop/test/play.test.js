// 플레이 중심 개선: 마인크래프트식 주고받기(Q 던지기 + 닿으면 자동 줍기)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNING } from '../shared/tuning.js';
import { newGame, run, place, assertTokenInvariant } from './helpers.js';

test('Q 던지기: 앞으로 날아가 친구 몸에 닿으면 자동으로 주워지고, 주고받기로 기록된다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 5]); place(g, 'B', [0, 0, 8]);
  run(g, 0.3);
  assert.ok(g.handle('A', { t: 'throw', token: 't1', dir: [0, -0.3, 1] }).ok, 'A의 <밀치기>를 던진다');
  assert.equal(g.players.A.slots.effect, null, '던지면 손(효과 칸)에서 빠진다');
  const t1 = g.token('t1');
  assert.ok(!t1.owner && t1.pos, '날아가는 중');
  run(g, 1.2);
  assert.equal(t1.owner, 'B', 'B가 닿아서 줍는다');
  const ev = g.events.filter((e) => e.k === 'pickup' && e.token === 't1').at(-1);
  assert.equal(ev.from, 'A', '누가 던진 것을 주웠는지 기록');
  assert.equal(g.players.B.slots.effect, 't2', 'B는 효과 칸이 차 있어 가방으로');
  assertTokenInvariant(assert, g, 10);
});

test('던지기: 벽에 막혀 떨어지고, 던진 사람은 잠깐 뒤에야 다시 주울 수 있다', () => {
  const g = newGame();
  place(g, 'A', [7.2, 0, 6]); place(g, 'B', [-4, 0, 6]);
  run(g, 0.3);
  assert.ok(g.handle('A', { t: 'throw', token: 't1', dir: [1, 0, 0] }).ok);
  run(g, 0.6);
  const t1 = g.token('t1');
  assert.ok(t1.pos && t1.pos[0] < 8, `벽(x=8)을 넘지 않는다 x=${t1.pos?.[0]}`);
  assert.equal(t1.owner, null, '던진 사람은 바로 다시 줍지 않는다');
  run(g, TUNING.pickupDelayOwn);
  assert.equal(t1.owner, 'A', '잠깐 뒤에는 닿아 있으면 다시 줍는다');
  assertTokenInvariant(assert, g, 10);
});

test('땅의 단어는 걸어가 닿으면 줍고, 효과 칸이 비어 있으면 바로 장착된다', () => {
  const g = newGame();
  g.handle('A', { t: 'drop', token: 't1' });
  run(g, 0.5);
  place(g, 'A', [-5, 0, 15]); run(g, 0.2);
  assert.equal(g.players.A.slots.effect, null);
  for (let i = 0; i < 90 && g.token('w1').owner !== 'A'; i++) { g.handle('A', { t: 'input', wish: [0, 1] }); run(g, 1 / 60); }
  g.handle('A', { t: 'input', wish: [0, 0] });
  assert.equal(g.token('w1').owner, 'A', '걸어가서 닿으면 줍는다');
  assert.equal(g.players.A.slots.effect, 'w1', '<파이어볼>이 바로 장착');
});

test('가방 장착(loadout): 손에 든 효과와 수식 칸을 한꺼번에 정하고, 남의 단어·종류 틀림·칸 초과는 거절', () => {
  const g = newGame();
  for (const id of ['w2', 'w3', 'w4']) {
    const t = g.token(id);
    if (t.owner === 'A') continue; // 옆 단어를 주우며 이미 닿았다
    place(g, 'A', [t.pos[0], 0, t.pos[2] - 0.5]);
    run(g, 0.1);
  }
  assert.deepEqual(g.players.A.slots.mods, [], '주운 수식은 가방으로');
  assert.ok(g.handle('A', { t: 'loadout', effect: 't1', mods: ['w2', 'w4'] }).ok);
  assert.equal(g.modCounts('A').BIG, 2);
  assert.equal(g.handle('A', { t: 'loadout', effect: 't2', mods: [] }).ok, false, 'B의 단어');
  assert.equal(g.handle('A', { t: 'loadout', effect: 'w2', mods: [] }).ok, false, '수식은 손(효과)에 못 든다');
  assert.equal(g.handle('A', { t: 'loadout', effect: 't1', mods: ['t1'] }).ok, false, '효과는 수식 칸에 못 넣는다');
  assert.equal(g.handle('A', { t: 'loadout', effect: 't1', mods: ['w2', 'w2'] }).ok, false, '같은 단어 두 번');
  assert.ok(g.handle('A', { t: 'loadout', effect: null, mods: ['w3'] }).ok, '빈손도 된다');
  assert.equal(g.players.A.slots.effect, null);
  assert.equal(g.modCounts('A').BIG, 1);
  assert.equal(TUNING.modSlots, 5);
  assertTokenInvariant(assert, g, 10);
});
