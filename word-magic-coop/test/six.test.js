// 최대 6인: 자리 A~F, 게임 중 참가·퇴장, 토큰 유일성, 클리어 조건
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { SEAT_IDS } from '../shared/level.js';
import { run, place, cast, bottom, lookAt, assertTokenInvariant } from './helpers.js';

test('6명으로 시작: 자리별 캐릭터·시작 효과, 토큰 12개(시작 6 + 월드 6)', () => {
  const g = new Game({ seats: SEAT_IDS });
  run(g, 0.3);
  assert.deepEqual(g.seats, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(g.bodies.filter((b) => b.kind === 'player').length, 6);
  assert.deepEqual(g.players.C.slots, { effect: 't3', mods: [] });
  assert.deepEqual(g.players.F.slots, { effect: 't6', mods: [] });
  assert.ok(g.bodies.every((b) => b.grounded), '겹치지 않고 모두 바닥에 선다');
  assertTokenInvariant(assert, g, 12);
  // C(밀치기)와 D(들기)도 같은 규칙으로 시전
  assert.ok(cast(g, 'C', 'A').ok);
  assert.ok(cast(g, 'D', 'B').ok);
  run(g, 0.8, () => lookAt(g, 'D', [g.body('B').pos[0], 5, g.body('B').pos[2]]));
  assert.ok(bottom(g.body('B')) > 1);
});

test('게임 중 참가: 시작 위치 근처에 나타나고 자기 시작 단어를 받는다', () => {
  const g = new Game();
  run(g, 0.3);
  assert.equal(g.tokens.length, 8);
  assert.ok(g.addPlayer('C'));
  assert.ok(!g.addPlayer('C'), '같은 자리는 두 번 참가하지 않는다');
  run(g, 0.3);
  const c = g.body('C');
  assert.ok(c && c.grounded && Math.hypot(c.pos[0] + 4.5, c.pos[2] - 1) < 2.5);
  assert.deepEqual(g.players.C.slots, { effect: 't3', mods: [] });
  assert.ok(g.events.some((e) => e.k === 'join' && e.id === 'C'));
  assert.ok(g.snapshot().p.C);
  assertTokenInvariant(assert, g, 9);
});

test('퇴장: 가진 단어는 그 자리에 떨어지고, 다시 들어오면 자기 시작 단어만 돌려받는다(복제 없음)', () => {
  const g = new Game({ seats: ['A', 'B', 'C'] });
  run(g, 0.3);
  // C가 <파이어볼>을 줍고 A가 C 위에 올라선 상태에서 C가 나간다
  place(g, 'C', [-5, 0, 16]);
  run(g, 0.2);
  assert.ok(g.handle('C', { t: 'pickup' }).ok);
  place(g, 'A', [-5, 1.3, 16]);
  run(g, 0.3);
  assert.equal(g.body('A').groundId, 'C');
  assert.ok(g.removePlayer('C'));
  assert.equal(g.body('C'), undefined);
  assert.equal(g.players.C, undefined);
  for (const id of ['w1', 't3']) {
    const t = g.tokens.find((x) => x.id === id);
    assert.ok(!t.owner && t.pos && Math.hypot(t.pos[0] + 5, t.pos[2] - 16) < 1, `${id}가 C 자리에 떨어짐`);
  }
  run(g, 1);
  assert.ok(g.body('A').grounded, '받침이 사라져도 A는 정상적으로 떨어져 선다');
  assert.equal(g.token('t3').owner, 'A', '떨어진 단어 위에 서면 닿아서 자동으로 줍는다');
  assertTokenInvariant(assert, g, 9);
  // A가 C의 시작 단어만 다시 내려놓는다
  g.handle('A', { t: 'drop', token: 't3' });
  run(g, 0.5);
  // 남은 사람만으로 클리어 조건 판단
  place(g, 'cargo', [0, 1.6, 34]);
  place(g, 'A', [-1.5, 1.6, 34]);
  place(g, 'B', [1.5, 1.6, 34]);
  run(g, 2.2);
  assert.equal(g.goal.cleared, true);
  // 다시 들어오면 떨어져 있던 자기 시작 단어(t3)만 인벤토리로, 다른 사람이 가진 <파이어볼>은 그대로
  assert.equal(g.token('t3').owner, null);
  g.addPlayer('C');
  assertTokenInvariant(assert, g, 9);
  assert.equal(g.tokens.find((t) => t.id === 't3').owner, 'C');
  assert.notEqual(g.tokens.find((t) => t.id === 'w1').owner, 'C');
});

test('다른 사람이 가져간 시작 단어는 재참가해도 뺏지 않는다', () => {
  const g = new Game({ seats: ['A', 'B', 'D'] });
  run(g, 0.3);
  place(g, 'D', [0, 0, 8]);
  place(g, 'B', [0, 0, 9]);
  run(g, 0.2);
  g.handle('D', { t: 'drop', token: 't4' }); // D의 <들기>를 앞(B 쪽)에 떨군다
  run(g, 1);
  assert.equal(g.tokens.find((t) => t.id === 't4').owner, 'B');
  g.removePlayer('D');
  g.addPlayer('D');
  assert.equal(g.tokens.find((t) => t.id === 't4').owner, 'B');
  assert.deepEqual(g.players.D.slots, { effect: null, mods: [] });
  assertTokenInvariant(assert, g, 9); // A·B·D 자리 단어 3개 + 월드 6개
});

test('클리어는 짐 + 접속한 모든 사람이 함께 있어야 한다', () => {
  const g = new Game({ seats: ['A', 'B', 'C', 'D'] });
  run(g, 0.3);
  place(g, 'cargo', [0, 1.6, 34]);
  const spots = { A: [-2, 1.6, 33], B: [2, 1.6, 33], C: [-2, 1.6, 35.5], D: [2, 1.6, 35.5] };
  for (const [id, p] of Object.entries(spots)) if (id !== 'D') place(g, id, p);
  run(g, 2.5);
  assert.equal(g.goal.cleared, false, 'D가 없으면 성공이 아니다');
  assert.equal(g.goal.inside.D, false);
  place(g, 'D', spots.D);
  run(g, 2.2);
  assert.equal(g.goal.cleared, true);
});
