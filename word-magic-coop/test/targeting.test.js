// 대상 지정 규칙과 적용 가능 여부(선택과 적용의 분리)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTargets, resolveSpell, REASON } from '../shared/targeting.js';

const body = (id, pos, kind = 'box', extra = {}) => ({
  id, kind, pos, half: [0.4, 0.4, 0.4], traits: { movable: true, floatable: true }, immune: false, ...extra,
});
const wall = { id: 'wall', min: [-5, 0, 5], max: [5, 3, 5.5] };

function world(bodies, statics = []) {
  return { statics, bodies };
}

test('AIMED: 조준선이 처음 맞힌 대상 1개, 시전자 제외', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('near', [0, 0.5, 2]), body('far', [0, 0.5, 4])]);
  const r = selectTargets('AIMED', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] });
  assert.deepEqual(r.selected, [{ type: 'body', id: 'near' }]);
});

test('AIMED: 벽에 막히면 그 뒤를 찾지 않고, 지형은 작용을 받지 못한다', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('behind', [0, 0.5, 7])], [wall]);
  const r = resolveSpell('AIMED', 'PUSH', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] });
  assert.deepEqual(r.applicable, []);
  assert.equal(r.selection.selected[0].type, 'static');
  assert.equal(r.reason, REASON.TERRAIN);
});

test('AIMED: 최대 8m', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('far', [0, 0.5, 8.6])]);
  const r = selectTargets('AIMED', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] });
  assert.equal(r.reason, REASON.OUT_OF_RANGE);
  const w2 = world([body('me', [0, 0.5, 0], 'player'), body('ok', [0, 0.5, 7.9])]);
  assert.deepEqual(selectTargets('AIMED', w2, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] }).selected, [{ type: 'body', id: 'ok' }]);
});

test('SELF: 조준과 무관하게 자신만 선택', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('x', [0, 0.5, 1])]);
  assert.deepEqual(selectTargets('SELF', w, 'me', null).selected, [{ type: 'body', id: 'me' }]);
  assert.deepEqual(selectTargets('SELF', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] }).selected, [{ type: 'body', id: 'me' }]);
});

test('NEARBY: 시전자 중심 반경 3m, 자신 제외, 가려진 대상 제외, 친구·사물 구분 없음', () => {
  const w = world([
    body('me', [0, 0.5, 0], 'player'),
    body('friend', [2, 0.5, 0], 'player'),
    body('rock', [-1, 0.5, 1], 'rock'),
    body('out', [3.5, 0.5, 0]),
    body('hidden', [0, 0.5, 2.9]),
  ], [{ id: 'w', min: [-1, 0, 2], max: [1, 3, 2.3] }]);
  const r = selectTargets('NEARBY', w, 'me', { origin: [0, 5, -5], dir: [0, 0, 1] });
  assert.deepEqual(r.selected.map((s) => s.id).sort(), ['friend', 'rock']);
});

test('NEARBY: 범위 기준은 조준점이 아니라 시전자 위치', () => {
  const w = world([body('me', [0, 0.5, 0], 'player'), body('aimedFar', [0, 0.5, 6])]);
  const r = selectTargets('NEARBY', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] });
  assert.equal(r.selected.length, 0);
  assert.equal(r.reason, REASON.NOTHING_NEARBY);
});

test('보호 중인 친구는 다른 사람의 마법을 받지 않지만 자기 시전은 받는다', () => {
  const w = world([body('me', [0, 0.5, 0], 'player', { immune: true }), body('B', [0, 0.5, 2], 'player', { immune: true })]);
  const r = resolveSpell('AIMED', 'LIFT', w, 'me', { origin: [0, 0.5, 0], dir: [0, 0, 1] });
  assert.equal(r.reason, REASON.PROTECTED);
  const s = resolveSpell('SELF', 'LIFT', w, 'me', null);
  assert.deepEqual(s.applicable, ['me']);
});

test('범위 안에 유효·무효 대상이 섞이면 유효한 대상에만 적용', () => {
  const w = world([
    body('me', [0, 0.5, 0], 'player'),
    body('B', [1, 0.5, 0], 'player', { immune: true }),
    body('box', [-1, 0.5, 0]),
    body('anchored', [0, 0.5, 1], 'box', { traits: { movable: false, floatable: false } }),
  ]);
  const r = resolveSpell('NEARBY', 'PUSH', w, 'me', null);
  assert.deepEqual(r.applicable, ['box']);
  assert.deepEqual(r.rejected.map((x) => x.id).sort(), ['B', 'anchored']);
});
