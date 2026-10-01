// 대상 모드(조준 대상/본인/주변)와 효과별 적용 가능 여부
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTargets, resolveTargets, liftMaxBottom, liftStrain, REASON } from '../shared/targeting.js';
import { WORDS, KIND } from '../shared/words.js';
import { LEVEL } from '../shared/level.js';
import { TUNING } from '../shared/tuning.js';

const traits = { movable: true, liftable: true, damageable: false };
const body = (id, pos, kind = 'box', extra = {}) => ({ id, kind, pos, half: [0.4, 0.4, 0.4], mass: 1, traits, immune: false, heldBy: [], ...extra });
const wall = { id: 'wall', min: [-5, 0, 5], max: [5, 3, 5.5] };
const world = (bodies, statics = []) => ({ statics, bodies });
const fwd = { origin: [0, 0.5, 0], dir: [0, 0, 1] };

test('대상 지정 단어는 없다: 단어는 효과와 수식뿐이고 월드·시작 단어에도 없다', () => {
  assert.deepEqual([...new Set(Object.values(WORDS).map((w) => w.kind))].sort(), [KIND.EFFECT, KIND.MOD].sort());
  for (const t of LEVEL.tokens) assert.ok(['PUSH', 'PULL', 'LIFT', 'FIREBALL', 'BIG', 'STRONG'].includes(t.word));
});

test('조준 대상: 처음 맞힌 것 하나, 시전자 제외, 벽에 막히면 뒤를 찾지 않음, 거리 제한', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('near', [0, 0.5, 2]), body('far', [0, 0.5, 4])]);
  assert.deepEqual(selectTargets('AIM', w, 'me', fwd).selected, [{ type: 'body', id: 'near' }]);
  const w2 = world([body('me', [0, 0.5, 0], 'player'), body('behind', [0, 0.5, 7])], [wall]);
  assert.equal(resolveTargets('AIM', 'PUSH', w2, 'me', fwd).reason, REASON.TERRAIN);
  const w3 = world([body('me', [0, 0.5, 0], 'player'), body('far', [0, 0.5, 8.6])]);
  assert.equal(selectTargets('AIM', w3, 'me', fwd).reason, REASON.OUT_OF_RANGE);
  assert.deepEqual(selectTargets('AIM', w3, 'me', fwd, { range: 9.6 }).selected, [{ type: 'body', id: 'far' }], '<큰>으로 늘어난 거리');
});

test('본인 모드는 자신만, 주변 모드는 자신 제외·반경·가림', () => {
  const w = world([
    body('me', [0, 0.5, 0], 'player'), body('friend', [2, 0.5, 0], 'player'),
    body('rock', [-1, 0.5, 1]), body('out', [3.5, 0.5, 0]), body('hidden', [0, 0.5, 2.9]),
  ], [{ id: 'w', min: [-1, 0, 2], max: [1, 3, 2.3] }]);
  assert.deepEqual(selectTargets('SELF', w, 'me', null).selected, [{ type: 'body', id: 'me' }]);
  assert.deepEqual(selectTargets('NEAR', w, 'me', null).selected.map((s) => s.id).sort(), ['friend', 'rock']);
  assert.deepEqual(selectTargets('NEAR', w, 'me', null, { radius: 3.6 }).selected.map((s) => s.id).sort(), ['friend', 'out', 'rock']);
});

test('들기 적용 가능 여부: 무게·힘, 딛고 선 물체, 다른 사람이 든 물체, 보호', () => {
  const w = world([
    body('me', [0, 0.5, 0], 'player'),
    body('heavy', [0, 0.5, 2], 'heavy', { mass: 3.6 }),
  ]);
  assert.equal(resolveTargets('AIM', 'LIFT', w, 'me', fwd, { capacity: 3 }).reason, REASON.TOO_HEAVY);
  assert.deepEqual(resolveTargets('AIM', 'LIFT', w, 'me', fwd, { capacity: 4.2 }).applicable, ['heavy']);
  assert.equal(resolveTargets('AIM', 'LIFT', w, 'me', fwd, { capacity: 5, casterGround: 'heavy' }).reason, REASON.STANDING_ON);
  // 같이 들기: 다른 사람이 든 물체에 합류하면 무게를 나눠 든다
  const shared = (mass, heldBy) => world([body('me', [0, 0.5, 0], 'player'), body('box', [0, 0.5, 2], 'box', { mass, heldBy })]);
  assert.deepEqual(resolveTargets('AIM', 'LIFT', shared(3.6, ['B']), 'me', fwd, { capacity: 3 }).applicable, ['box'], '혼자 못 드는 3.6도 둘이면 1.8씩');
  assert.equal(resolveTargets('AIM', 'LIFT', shared(7, ['B']), 'me', fwd, { capacity: 3 }).reason, REASON.TOO_HEAVY, '나눠도 3.5라 힘 3으로는 못 든다');
  assert.deepEqual(resolveTargets('AIM', 'LIFT', shared(7, ['B', 'C']), 'me', fwd, { capacity: 3 }).applicable, ['box'], '셋이면 7/3');
  assert.equal(resolveTargets('AIM', 'LIFT', shared(1, ['me']), 'me', fwd, { capacity: 3 }).reason, REASON.ALREADY_HELD);
  assert.equal(resolveTargets('AIM', 'LIFT', shared(1, []), 'me', fwd, { capacity: 3, load: 2.5 }).reason, REASON.TOO_HEAVY, '이미 나눠 든 무게(load)까지 합쳐 본다');
  // 나를 들고 있는 사람은 들 수 없다(서로 들면 끝없이 올라간다)
  const mutual = world([body('me', [0, 0.5, 0], 'player'), body('B', [0, 0.5, 2], 'player', { holding: ['me'] })]);
  assert.equal(resolveTargets('AIM', 'LIFT', mutual, 'me', fwd, { capacity: 3 }).reason, REASON.HOLDING_YOU);
  const prot = world([body('me', [0, 0.5, 0], 'player'), body('B', [0, 0.5, 2], 'player', { immune: true })]);
  assert.equal(resolveTargets('AIM', 'PUSH', prot, 'me', fwd).reason, REASON.PROTECTED);
  assert.deepEqual(resolveTargets('SELF', 'PUSH', world([body('me', [0, 0.5, 0], 'player', { immune: true })]), 'me', null).applicable, ['me'], '자기 시전은 보호와 구분');
});

test('들기 최대 높이는 무거울수록 낮고, 시전자가 높은 곳에 서면 그만큼 높다', () => {
  const c = TUNING.liftCapacity;
  const rock = liftMaxBottom(0, 0.5 / c);
  const player = liftMaxBottom(0, LEVEL.playerMass / c);
  const cargo = liftMaxBottom(0, 2.6 / c);
  assert.ok(rock > player && player > cargo);
  assert.ok(player > 1.6, '친구는 아래에서 단차 위로 올릴 수 있다');
  assert.ok(cargo < 1.6, '짐은 아래에서는 단차 높이까지 못 든다');
  assert.ok(liftMaxBottom(1.6, 2.6 / c) > 1.6 + 0.5, '단차 위에서는 짐을 끌어올릴 수 있다');
  // 둘이 나눠 들면 덜 버거워서 더 높이 든다
  const together = liftStrain([{ load: 1.3, capacity: c }, { load: 1.3, capacity: c }]);
  assert.ok(Math.abs(together - 1.3 / c) < 1e-9);
  assert.ok(liftMaxBottom(0, together) > 1.6, '둘이 들면 짐도 아래에서 단차 위로 올릴 수 있다');
  assert.ok(Math.abs(liftStrain([{ load: 2.6, capacity: c }]) - 2.6 / c) < 1e-9, '혼자면 무게/힘');
});
