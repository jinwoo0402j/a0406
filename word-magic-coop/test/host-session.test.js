// 브라우저 안 호스트(HostSession): 방장(A) + 원격 참가자(B) 연결 관리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession } from '../client/host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeConn() {
  const c = { got: [], closed: false };
  c.send = (m) => c.got.push(JSON.parse(JSON.stringify(m))); // 실제 전송처럼 직렬화
  c.close = () => { c.closed = true; };
  return c;
}

test('방장 + 원격 참가자: 시작·동기화·같은 검증·가득 참·퇴장', async () => {
  const local = [];
  const s = new HostSession((m) => local.push(m));
  try {
    await sleep(20);
    assert.equal(local[0].t, 'welcome');
    assert.equal(local[0].you, 'A');
    assert.ok(!local.some((m) => m.t === 'start'), '혼자서는 시작하지 않는다');

    const b = fakeConn();
    const link = s.attachRemote(b);
    assert.equal(b.got[0].t, 'welcome');
    assert.equal(b.got[0].you, 'B');
    assert.ok(b.got.some((m) => m.t === 'start') && local.some((m) => m.t === 'start'));

    // 방장 이동과 원격 이동이 모두 반영되고, 양쪽이 같은 스냅숏을 받는다
    s.send({ t: 'input', wish: [1, 0] });
    link.receive({ t: 'input', wish: [-1, 0] });
    await sleep(400);
    s.send({ t: 'input', wish: [0, 0] });
    link.receive({ t: 'input', wish: [0, 0] });
    await sleep(100);
    const lastLocal = local.filter((m) => m.t === 's').at(-1);
    const lastRemote = b.got.filter((m) => m.t === 's').at(-1);
    assert.deepEqual(lastLocal, lastRemote);
    const A = lastLocal.b.find((x) => x.id === 'A').p;
    const B = lastLocal.b.find((x) => x.id === 'B').p;
    assert.ok(A[0] > -1.2 && B[0] < 1.2, `A=${A} B=${B}`);

    // 원격 시전도 같은 판정: 쿨다운 중 두 번째 요청은 B에게만 실패 안내
    const aim = { origin: B, dir: [A[0] - B[0], A[1] - B[1], A[2] - B[2]] };
    link.receive({ t: 'cast', ...aim });
    link.receive({ t: 'cast', ...aim });
    await sleep(80);
    assert.ok(b.got.some((m) => m.k === 'cast' && m.by === 'B' && m.targets.includes('A')));
    assert.ok(local.some((m) => m.k === 'cast' && m.by === 'B'), '방장 화면에도 시전 이벤트');
    assert.ok(b.got.some((m) => m.k === 'castFail'));
    assert.ok(!local.some((m) => m.k === 'castFail'), '실패 안내는 시전자에게만');

    // 세 번째 사람은 거절
    const c = fakeConn();
    s.attachRemote(c);
    assert.equal(c.got[0].t, 'full');

    // 원격이 끊기면 방장은 로비로, 새 참가자가 오면 처음부터
    link.closed();
    assert.ok(local.some((m) => m.t === 'peerLeft'));
    const b2 = fakeConn();
    s.attachRemote(b2);
    await sleep(80);
    const snap = b2.got.filter((m) => m.t === 's').at(-1);
    assert.deepEqual(snap.b.find((x) => x.id === 'A').p, [-1.5, 0.65, 1], '새 판은 처음 상태');
  } finally {
    s.close();
  }
});

test('혼자 해보기: Q 전환으로 같은 탭에서 A·B를 조작', async () => {
  const local = [];
  const s = new HostSession((m) => local.push(m), { solo: true });
  try {
    await sleep(20);
    assert.ok(local.some((m) => m.t === 'start'));
    s.send({ t: 'input', wish: [0, 1] });
    await sleep(200);
    s.switchTo('B');
    s.send({ t: 'input', wish: [0, 1] });
    await sleep(200);
    s.send({ t: 'input', wish: [0, 0] });
    await sleep(80);
    const snap = local.filter((m) => m.t === 's').at(-1);
    const A = snap.b.find((x) => x.id === 'A').p;
    const B = snap.b.find((x) => x.id === 'B').p;
    assert.ok(A[2] > 1.3 && B[2] > 1.3, `A=${A} B=${B}`);
    const aStopped = A[2];
    await sleep(150);
    const A2 = local.filter((m) => m.t === 's').at(-1).b.find((x) => x.id === 'A').p;
    assert.ok(Math.abs(A2[2] - aStopped) < 0.05, '전환된 뒤 A는 멈춰 있다');
  } finally {
    s.close();
  }
});
