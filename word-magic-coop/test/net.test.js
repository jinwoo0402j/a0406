// T1 등: 실제 호스트 프로세스(HTTP + WebSocket)에 두 클라이언트가 접속해 같은 상태를 받는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [], snaps: new Map(), closed: false };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.msgs.push(m);
    if (m.t === 's') c.snaps.set(m.tick, m);
  });
  ws.on('close', () => { c.closed = true; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = c.msgs.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')); }
    }, 10);
  });
  c.latest = () => [...c.snaps.values()].at(-1);
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('클라이언트 접속·동기화·교환·게임 중 참가·최대 6명·연결 끊김 (T1)', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const a = client(srv.port);
    const wa = await a.waitFor((m) => m.t === 'welcome');
    assert.equal(wa.you, 'A');
    const b = client(srv.port);
    const wb = await b.waitFor((m) => m.t === 'welcome');
    assert.equal(wb.you, 'B');
    await a.waitFor((m) => m.t === 'start');
    await b.waitFor((m) => m.t === 'start');

    // 세 번째 접속은 진행 중인 판에 C로 참가하고, 기존 사람들에게 참가 이벤트가 간다
    const c = client(srv.port);
    assert.equal((await c.waitFor((m) => m.t === 'welcome')).you, 'C');
    await c.waitFor((m) => m.t === 'start');
    await a.waitFor((m) => m.t === 'ev' && m.k === 'join' && m.id === 'C');

    // A가 +x로 걷는다 → 두 클라이언트가 같은 틱에서 같은 위치를 받는다
    a.send({ t: 'input', wish: [1, 0] });
    await sleep(500);
    a.send({ t: 'input', wish: [0, 0] });
    await sleep(300);
    const common = [...a.snaps.keys()].filter((k) => b.snaps.has(k)).slice(-10);
    assert.ok(common.length >= 5, '공통 스냅숏');
    for (const k of common) assert.deepEqual(a.snaps.get(k), b.snaps.get(k), `틱 ${k} 상태 일치`);
    const aPos = a.latest().b.find((x) => x.id === 'A').p;
    assert.ok(aPos[0] > -0.5, `A가 이동했다: ${aPos}`);

    // A가 조준 대상 모드로 B에게 <밀치기> → 두 클라이언트 모두 시전 이벤트를 받는다
    const bPos = b.latest().b.find((x) => x.id === 'B').p;
    a.send({ t: 'cast', mode: 'AIM', origin: aPos, dir: [bPos[0] - aPos[0], bPos[1] - aPos[1], bPos[2] - aPos[2]] });
    const ea = await a.waitFor((m) => m.t === 'ev' && m.k === 'cast');
    const eb = await b.waitFor((m) => m.t === 'ev' && m.k === 'cast');
    assert.deepEqual(ea, eb);
    assert.deepEqual(ea.targets, ['B']);

    // 게스트(B)의 요청도 같은 검증: <들기>로 A를 들면 두 화면 모두 들린 상태를 보고,
    // 놓은 직후 다시 시전하면 대기시간으로 거절(본인에게만 안내)
    const liftAim = { t: 'cast', mode: 'AIM', origin: bPos, dir: [aPos[0] - bPos[0], aPos[1] - bPos[1], aPos[2] - bPos[2]] };
    b.send(liftAim);
    await a.waitFor((m) => m.t === 'ev' && m.k === 'liftStart' && m.by === 'B');
    await sleep(200);
    const common2 = [...a.snaps.keys()].filter((k) => b.snaps.has(k)).slice(-3);
    for (const k of common2) {
      assert.equal(a.snaps.get(k).b.find((x) => x.id === 'A').h, 'B', '두 화면 모두 A가 B에게 들려 있다');
      assert.deepEqual(a.snaps.get(k), b.snaps.get(k));
    }
    b.send({ t: 'endCast' });
    b.send(liftAim);
    const fail = await b.waitFor((m) => m.t === 'ev' && m.k === 'castFail');
    assert.match(fail.reason, /대기/);
    await sleep(100);
    assert.ok(!a.msgs.some((m) => m.k === 'castFail'), '실패 안내는 시전자에게만');

    // 교환: A가 <밀치기>를 내려놓고 B가 줍는다 → 두 화면 모두 소유권이 바뀐다
    a.send({ t: 'drop', token: 't1' });
    await b.waitFor((m) => m.t === 'ev' && m.k === 'drop');
    await sleep(200);
    // B를 A 근처로 이동시키기 위해 걷기
    const t2 = b.latest().k.find((k) => k.id === 't1').p;
    for (let i = 0; i < 60; i++) {
      const bp = b.latest().b.find((x) => x.id === 'B').p;
      const dx = t2[0] - bp[0];
      const dz = t2[2] - bp[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.5) break;
      b.send({ t: 'input', wish: [dx / d, dz / d] });
      await sleep(33);
    }
    b.send({ t: 'input', wish: [0, 0] });
    b.send({ t: 'pickup' });
    await b.waitFor((m) => m.t === 'ev' && m.k === 'pickup' && m.token === 't1');
    await sleep(150);
    for (const cl of [a, b]) {
      const s = cl.latest();
      assert.equal(s.k.find((k) => k.id === 't1').o, 'B');
      assert.equal(s.p.A.e, null, 'A의 효과 칸이 비었다');
      assert.ok(s.p.B.inv.includes('t1'));
    }

    // D·E·F까지 6명, 일곱 번째는 거절
    const more = ['D', 'E', 'F'].map(() => client(srv.port));
    for (const [i, cl] of more.entries()) assert.equal((await cl.waitFor((m) => m.t === 'welcome')).you, 'DEF'[i]);
    const g = client(srv.port);
    await g.waitFor((m) => m.t === 'full');
    await sleep(150);
    assert.deepEqual(Object.keys(a.latest().p), ['A', 'B', 'C', 'D', 'E', 'F']);

    // B가 끊겨도 나머지는 계속한다(B가 가진 단어는 그 자리에 떨어짐)
    b.ws.close();
    await a.waitFor((m) => m.t === 'ev' && m.k === 'leave' && m.id === 'B');
    await sleep(150);
    assert.ok(!a.msgs.some((m) => m.t === 'peerLeft'));
    assert.equal(a.latest().k.find((k) => k.id === 't1').o, null, 'B가 가지고 있던 <밀치기>가 월드에 떨어졌다');

    // 혼자 남으면 안내 후 로비로
    for (const cl of [c, ...more]) cl.ws.close();
    await a.waitFor((m) => m.t === 'peerLeft');
    const lobby = a.msgs.filter((m) => m.t === 'lobby').at(-1);
    assert.equal(lobby.state, 'lobby');

    // 새 상대가 접속하면 처음 상태로 다시 시작
    const b2 = client(srv.port);
    assert.equal((await b2.waitFor((m) => m.t === 'welcome')).you, 'B');
    await b2.waitFor((m) => m.t === 'start');
    await sleep(150);
    assert.equal(b2.latest().p.A.e, 't1', '재시작: 장착이 최초 상태');
    for (const cl of [a, b2, g]) cl.ws.close();
  } finally {
    await srv.close();
  }
});
