// 가방(client/inventory.js): 마인크래프트식 끌어서 나눠 놓기 · 두 번 클릭 모으기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory, HOTBAR } from '../client/inventory.js';

const counts = (I) => I.slots.map((s) => (s ? `${s.word}${s.tokens.length}` : '-'));

function withBig(n) {
  const I = new Inventory(5);
  for (let i = 0; i < n; i++) I.add(`b${i}`, 'BIG'); // 같은 수식은 한 칸에 겹친다(핫바 0번)
  return I;
}

test('좌클릭으로 끌면 커서 묶음을 고르게 나누고 남는 건 커서에 남는다', () => {
  const I = withBig(5);
  I.clickSlot(0, 0, false, 0); // 집기
  assert.equal(I.cursor.tokens.length, 5);
  assert.equal(I.dragPlace([{ area: 'inv', i: HOTBAR }, { area: 'inv', i: HOTBAR + 1 }], 0, 0), true);
  assert.equal(I.slots[HOTBAR].tokens.length, 2);
  assert.equal(I.slots[HOTBAR + 1].tokens.length, 2);
  assert.equal(I.cursor.tokens.length, 1, '5 ÷ 2 = 2씩, 1개 남음');
});

test('우클릭으로 끌면 칸마다 하나씩, 같은 수식 묶음 위에도 놓인다', () => {
  const I = withBig(4);
  I.add('s1', 'STRONG');
  I.clickSlot(0, 0, false, 0);
  I.add('b9', 'BIG'); // 빈 핫바 0번에 새 <큰> 묶음
  I.dragPlace([{ area: 'inv', i: 0 }, { area: 'inv', i: 2 }, { area: 'inv', i: 3 }], 2, 0);
  assert.equal(I.slots[0].tokens.length, 2, '같은 묶음에 하나 더');
  assert.equal(I.slots[2].tokens.length, 1);
  assert.equal(I.slots[3].tokens.length, 1);
  assert.equal(I.cursor.tokens.length, 1);
  // 다른 단어 칸(<세게>)과 효과 칸에는 끌어 놓을 수 없다
  assert.equal(I.canDrag('inv', 1), false);
});

test('커서 개수보다 많은 칸을 끌면 넘는 칸은 무시하고, 빈 수식 칸에는 하나씩 붙는다', () => {
  const I = withBig(2);
  I.clickSlot(0, 0, false, 0);
  I.dragPlace([{ area: 'mod', i: 0 }, { area: 'mod', i: 1 }, { area: 'inv', i: 5 }], 0, 0);
  assert.deepEqual(I.mods, ['b1', 'b0']);
  assert.equal(I.slots[5], null, '세 번째 칸은 무시');
  assert.equal(I.cursor, null);
});

test('효과 단어는 끌어도 한 칸에만, 수식 칸에는 못 넣는다', () => {
  const I = new Inventory(5);
  I.add('p', 'PUSH');
  I.clickSlot(0, 0, false, 0);
  assert.equal(I.canDrag('mod', 0), false);
  I.dragPlace([{ area: 'inv', i: 4 }, { area: 'inv', i: 5 }], 0, 0);
  assert.equal(I.slots[4].word, 'PUSH');
  assert.equal(I.slots[5], null);
  assert.equal(I.cursor, null);
});

test('두 번 클릭하면 같은 수식을 커서로 모두 모은다(수식 칸·다른 단어는 그대로)', () => {
  const I = withBig(6);
  I.clickSlot(0, 0, false, 0);
  I.dragPlace([{ area: 'inv', i: 1 }, { area: 'inv', i: 2 }, { area: 'inv', i: 3 }], 0, 0); // 2·2·2
  I.add('s', 'STRONG');
  I.setMods(['m1'], 0);
  I.clickSlot(1, 0, false, 0); // 하나 집고
  assert.equal(I.collect(), true); // 두 번째 클릭에서 모으기
  assert.equal(I.cursor.tokens.length, 6);
  assert.deepEqual(counts(I).filter((x) => x !== '-'), ['STRONG1']);
  assert.deepEqual(I.mods, ['m1']);
  // 효과 단어는 모으지 않는다
  const J = new Inventory(5);
  J.add('p1', 'PUSH');
  J.add('p2', 'PUSH');
  J.clickSlot(0, 0, false, 0);
  assert.equal(J.collect(), false);
});
