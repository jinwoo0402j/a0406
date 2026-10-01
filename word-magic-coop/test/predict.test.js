// 내 캐릭터 예측(client/predict.js): 서버(호스트)가 실제로 움직인 결과와 맞는지, 벽을 뚫지 않는지,
// 새 스냅숏으로 기준이 바뀌어도 화면 위치가 튀지 않는지. + 왕복 지연 재기(pong)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL } from '../shared/level.js';
import { SelfPredictor } from '../client/predict.js';
import { newGame, run, place } from './helpers.js';

const HALF = LEVEL.playerSize.map((x) => x / 2);
const snapOf = (g, id) => g.snapshot().b.find((b) => b.id === id);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function settled() {
  const g = newGame();
  place(g, 'A', [0, 0, 8]);
  place(g, 'B', [6, 0, 8]);
  run(g, 0.4);
  return g;
}

// 두 스냅숏(멈춰 있음)을 받은 예측기. 마지막 스냅숏은 이 컴퓨터 시각 at에 도착
function primed(g, at) {
  const P = new SelfPredictor(LEVEL.statics);
  P.onSnapshot(snapOf(g, 'A'), g.time - 1 / 30, at - 1 / 30);
  P.onSnapshot(snapOf(g, 'A'), g.time, at);
  return P;
}

test('예측: 지연이 없으면 W를 누른 뒤의 위치가 호스트가 실제로 움직인 결과와 같다', () => {
  const g = settled();
  const P = primed(g, 10);
  P.input(10, [0, 1]);
  g.handle('A', { t: 'input', wish: [0, 1] });
  run(g, 0.2);
  const pred = P.simulate(P.base, 10.2, [], HALF);
  const real = g.body('A').pos;
  assert.ok(real[2] > 8.6, `호스트에서 걸어감 z=${real[2]}`);
  assert.ok(dist(pred.p, real) < 0.06, `예측 ${pred.p.map((x) => x.toFixed(3))} / 실제 ${real.map((x) => x.toFixed(3))}`);
});

test('예측: 왕복 지연 동안 아직 서버에 닿지 않은 입력도 미리 반영한다', () => {
  const g = settled();
  // 0.1초 전에 W를 눌렀지만 지금 막 도착한 스냅숏은 아직 멈춰 있는 상태(서버가 못 받음)
  const P = primed(g, 10);
  P.rtt = 0.1;
  P.input(9.95, [0, 1]);
  const withRtt = P.simulate(P.base, 10, [], HALF);
  // 입력 뒤 0.05초 걸은 만큼 앞서 있어야 한다(같은 0.05초를 호스트에서 걸려 본 결과와 비교)
  g.handle('A', { t: 'input', wish: [0, 1] });
  run(g, 0.05);
  const real = g.body('A').pos;
  assert.ok(withRtt.p[2] > 8.02, `앞서 나감 z=${withRtt.p[2]}`);
  assert.ok(Math.abs(withRtt.p[2] - real[2]) < 0.03, `예측 ${withRtt.p[2].toFixed(3)} / 호스트 0.05초 뒤 ${real[2].toFixed(3)}`);
  P.rtt = 0;
  assert.ok(Math.abs(P.simulate(P.base, 10, [], HALF).p[2] - P.base.p[2]) < 1e-6, '지연이 없다고 보면 아직 제자리');
});

test('예측: 앞에 있는 물체(다른 몸)를 뚫고 나가지 않는다', () => {
  const g = settled();
  const P = primed(g, 10);
  P.input(10, [0, 1]);
  const box = { id: 'box', pos: [0, 0.5, 9], half: [0.5, 0.5, 0.5] };
  const pred = P.simulate(P.base, 10.3, [box], HALF);
  assert.ok(pred.p[2] <= 9 - 0.5 - HALF[2] + 1e-6, `막혀서 멈춤 z=${pred.p[2]}`);
});

test('예측: 새 스냅숏으로 기준이 바뀌어도 화면 위치는 튀지 않고 서서히 맞춰진다', () => {
  const g = settled();
  const P = primed(g, 10);
  P.input(10, [0, 1]);
  const opts = { colliders: [], half: HALF, enabled: true, fallback: null };
  let shown = null;
  for (let t = 10; t <= 10.2 + 1e-9; t += 1 / 60) shown = P.present(t, 1 / 60, opts).p;
  // 서버가 예측보다 0.3m 뒤처진 상태를 알려 왔다(예: 잠깐 걸림)
  const lag = { ...snapOf(g, 'A'), p: [shown[0], shown[1], shown[2] - 0.3] };
  P.onSnapshot(lag, g.time + 0.2, 10.2);
  const next = P.present(10.2 + 1 / 60, 1 / 60, opts).p;
  assert.ok(Math.abs(next[2] - shown[2]) < 0.15, `한 프레임에 크게 튀지 않음 ${shown[2].toFixed(3)} → ${next[2].toFixed(3)}`);
  let later = next;
  for (let t = 10.2 + 2 / 60; t < 11; t += 1 / 60) later = P.present(t, 1 / 60, opts).p;
  const raw = P.simulate(P.base, 11 - 1 / 60, [], HALF).p;
  assert.ok(dist(later, raw) < 0.02, '조금 지나면 새 기준에 맞춰진다');
});

test('예측을 끄면(들려 있는 등) 보간 위치를 쓰고, 전환할 때도 튀지 않는다', () => {
  const g = settled();
  const P = primed(g, 10);
  const half = HALF;
  const a = P.present(10, 1 / 60, { colliders: [], half, enabled: true, fallback: [0, 0.65, 8] });
  const b = P.present(10 + 1 / 60, 1 / 60, { colliders: [], half, enabled: false, fallback: [0, 0.65, 8.5] });
  assert.equal(b.predicted, false);
  assert.ok(dist(a.p, b.p) < 0.1, '전환 순간에는 이어서 보인다');
  let c = b;
  for (let i = 0; i < 60; i++) c = P.present(10 + (i + 2) / 60, 1 / 60, { colliders: [], half, enabled: false, fallback: [0, 0.65, 8.5] });
  assert.ok(dist(c.p, [0, 0.65, 8.5]) < 0.01, '곧 보간 위치로');
});

test('왕복 지연 재기: rtt를 보낸 사람에게만 같은 값으로 pong을 돌려준다', () => {
  const g = settled();
  g.drainEvents();
  assert.equal(g.handle('B', { t: 'rtt', c: 12.5 }).ok, true);
  assert.equal(g.handle('B', { t: 'rtt', c: 'x' }).ok, false);
  const ev = g.drainEvents().filter((e) => e.k === 'pong');
  assert.deepEqual(ev, [{ k: 'pong', to: 'B', c: 12.5 }]);
});
