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

test('방장 + 원격 참가자: 시작·동기화·같은 검증·최대 6명·퇴장', async () => {
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

    // 원격 시전도 같은 판정: B의 <들기>로 A를 들고 놓은 직후 다시 시전하면 대기시간 안내는 B에게만
    const aim = { mode: 'AIM', origin: B, dir: [A[0] - B[0], A[1] - B[1], A[2] - B[2]] };
    link.receive({ t: 'cast', ...aim });
    await sleep(80);
    link.receive({ t: 'liftEnd' });
    link.receive({ t: 'cast', ...aim });
    await sleep(80);
    assert.ok(b.got.some((m) => m.k === 'liftStart' && m.by === 'B' && m.target === 'A'));
    assert.ok(local.some((m) => m.k === 'liftStart' && m.by === 'B'), '방장 화면에도 들기 이벤트');
    assert.ok(b.got.some((m) => m.k === 'castFail' && /대기/.test(m.reason)));
    assert.ok(!local.some((m) => m.k === 'castFail'), '실패 안내는 시전자에게만');

    // 세 번째부터는 진행 중인 판에 참가(C~F), 일곱 번째는 거절
    const others = ['C', 'D', 'E', 'F'].map(() => fakeConn());
    const links = others.map((c) => s.attachRemote(c));
    others.forEach((c, i) => {
      assert.equal(c.got[0].you, 'CDEF'[i]);
      assert.ok(c.got.some((m) => m.t === 'start'), '진행 중인 판에 바로 들어간다');
    });
    await sleep(80);
    assert.deepEqual(Object.keys(local.filter((m) => m.t === 's').at(-1).p), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.ok(local.some((m) => m.k === 'join' && m.id === 'F'));
    const g7 = fakeConn();
    s.attachRemote(g7);
    assert.equal(g7.got[0].t, 'full');

    // 한 명이 나가도 게임은 계속, 모두 나가면 방장은 로비로
    links[0].closed();
    await sleep(60);
    assert.ok(local.some((m) => m.k === 'leave' && m.id === 'C'));
    assert.ok(!local.some((m) => m.t === 'peerLeft'));
    assert.ok(!('C' in local.filter((m) => m.t === 's').at(-1).p));
    for (const l of links.slice(1)) l.closed();
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

test('같은 사람이 다시 연결하면 새 자리 대신 원래 자리를 이어 준다', async () => {
  const local = [];
  const s = new HostSession((m) => local.push(m));
  try {
    await sleep(20);
    const first = fakeConn();
    s.attachRemote({ ...first, key: 'peer-x' });
    const again = fakeConn();
    const link = s.attachRemote({ ...again, key: 'peer-x' });
    assert.equal(again.got[0].you, 'B', '같은 사람은 같은 자리(B)');
    assert.ok(again.got.some((m) => m.t === 'start'));
    await sleep(80);
    assert.deepEqual(Object.keys(local.filter((m) => m.t === 's').at(-1).p), ['A', 'B'], '유령 자리 없음');
    const other = fakeConn();
    s.attachRemote({ ...other, key: 'peer-y' });
    assert.equal(other.got[0].you, 'C');
    link.receive({ t: 'input', wish: [1, 0] });
    await sleep(150);
    const B = local.filter((m) => m.t === 's').at(-1).b.find((x) => x.id === 'B').p;
    assert.ok(B[0] > 1.6, '새 연결로 조작이 이어진다');
  } finally {
    s.close();
  }
});

test('안내를 못 받은 참가자가 hello를 다시 보내면 안내와 시작을 다시 받는다', async () => {
  const s = new HostSession(() => {});
  try {
    await sleep(20);
    const b = fakeConn();
    const link = s.attachRemote({ ...b, key: 'peer-z' });
    const start = b.got.find((m) => m.t === 'start');
    assert.equal(start.you, 'B', '시작 메시지에도 자리가 담긴다');
    b.got.length = 0;
    link.hello();
    assert.deepEqual(b.got.slice(0, 2).map((m) => [m.t, m.you]), [['welcome', 'B'], ['start', 'B']]);
  } finally {
    s.close();
  }
});
