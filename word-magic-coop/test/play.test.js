// 플레이 중심 개선: 건네주기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, run, place, cast, grab, assertTokenInvariant } from './helpers.js';

test('건네주기: 가까운 친구에게 단어를 바로 넘기고, 받는 사람은 주울 때처럼 장착된다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 6]); place(g, 'B', [1.5, 0, 6]); place(g, 'rock', [1.5, 0, 8]);
  run(g, 0.3);
  // 수식: A의 <큰>을 B에게 → 바로 붙는다
  grab(g, 'A', 'w2');
  place(g, 'A', [0, 0, 6]); run(g, 0.2);
  assert.equal(g.modCounts('A').BIG, 1);
  assert.ok(g.handle('A', { t: 'give', token: 'w2' }).ok);
  assert.equal(g.modCounts('A').BIG, 0);
  assert.equal(g.modCounts('B').BIG, 1, '받자마자 붙는다');
  const ev = g.events.filter((e) => e.k === 'give').at(-1);
  assert.deepEqual([ev.by, ev.target, ev.word], ['A', 'B', 'BIG']);
  // 효과: B가 들고 있던 중에 <들기>를 넘기면 놓치고, 효과 칸이 빈 A는 바로 장착
  assert.ok(g.handle('A', { t: 'give', token: 't1' }).ok, 'A의 <밀치기>를 B에게');
  assert.equal(g.players.A.slots.effect, null);
  assert.equal(g.players.B.slots.effect, 't2', 'B는 효과 칸이 차 있어 그대로(받은 <밀치기>는 가방에)');
  assert.ok(cast(g, 'B', 'rock').ok);
  assert.ok(g.handle('B', { t: 'give', token: 't2' }).ok);
  run(g, 0.1);
  assert.deepEqual(g.body('rock').heldBy, [], '<들기>를 넘기면 놓친다');
  assert.equal(g.players.A.slots.effect, 't2', '효과 칸이 비어 있던 A는 바로 장착');
  assertTokenInvariant(assert, g, 10);
});

test('건네주기: 멀거나 벽 너머면 안 넘어가고 이유를 알려 준다, 남의 단어는 못 넘긴다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 6]); place(g, 'B', [5, 0, 6]);
  run(g, 0.3);
  assert.equal(g.handle('A', { t: 'give', token: 't1' }).ok, false);
  assert.ok(g.events.some((e) => e.k === 'giveFail' && e.to === 'A' && /가까이 없어요/.test(e.reason)));
  assert.equal(g.token('t1').owner, 'A');
  assert.equal(g.handle('A', { t: 'give', token: 't2' }).ok, false, 'B의 단어');
  // 울타리(높이 0.8) 너머 2m
  place(g, 'A', [5, 0, 11]); place(g, 'B', [5, 0, 13.4]);
  run(g, 0.3);
  assert.equal(g.handle('A', { t: 'give', token: 't1' }).ok, false, '지형에 가리면 안 된다');
  assertTokenInvariant(assert, g, 10);
});
