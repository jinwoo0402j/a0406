// 반응 지연 측정: 인위적 지연(한 방향 LAG ms, 기본 60)을 넣은 TCP 중계로 두 명이 접속해,
// 두 번째 플레이어(B) 화면에서 내 캐릭터 예측을 끄고/켜고 잰다.
//   moved: W를 누르고 5cm 움직이기까지(ms) · coastAfterStop: W를 뗀 뒤 더 미끄러진 거리(m)
//   maxBackStep: 걷는 중 뒤로 튄 가장 큰 값(0이면 튐 없음) · restDiff: 멈춘 뒤 서버 위치와의 차이(m)
// 실행: LAG=60 node scripts/lag-check.mjs   (playwright 필요)
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
for (const base of [path.join(ROOT, 'package.json'), process.env.PLAYWRIGHT_GLOBAL, '/opt/node22/lib/node_modules/']) {
  if (!base) continue;
  try { ({ chromium } = createRequire(base.endsWith('.json') ? base : `${base}/`)('playwright')); break; } catch { /* 다음 */ }
}
if (!chromium) { console.error('playwright를 찾을 수 없어요.'); process.exit(2); }
const LAG = Number(process.env.LAG || 60);
const srv = await startServer({ port: 0, log: () => {} });
const proxy = net.createServer((c) => {
  const up = net.connect(srv.port, '127.0.0.1');
  const pipe = (from, to) => from.on('data', (d) => setTimeout(() => { if (!to.destroyed) to.write(d); }, LAG));
  pipe(c, up); pipe(up, c);
  const end = () => { c.destroy(); up.destroy(); };
  c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
});
await new Promise((r) => proxy.listen(0, r));
const url = `http://localhost:${proxy.address().port}/?autojoin=1&gfx=low`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errs = [];
const open = async () => {
  const p = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await p.goto(url);
  return p;
};
const A = await open();
const B = await open();
await B.waitForFunction(() => window.__wm?.phase === 'playing' && window.__wm.latest, null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
await B.bringToFront();
for (const on of [false, true]) {
  const res = await B.evaluate(async (on) => {
    const W = window.__wm;
    W.setPredict(on);
    W.setView(0, -0.08);
    await new Promise((r) => setTimeout(r, 700));
    const start = W.previewNow().me.slice();
    const t0 = performance.now();
    W.hold('KeyW', true);
    let moved = -1;
    const zs = [];
    await new Promise((res) => {
      const loop = () => {
        const me = W.previewNow().me;
        zs.push(me[2]);
        if (moved < 0 && Math.hypot(me[0] - start[0], me[2] - start[2]) > 0.05) moved = performance.now() - t0;
        if (performance.now() - t0 > 1200) res(); else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    W.hold('KeyW', false);
    const t1 = performance.now();
    const stopAt = W.previewNow().me[2];
    let maxOver = 0;
    await new Promise((res) => {
      const loop = () => { maxOver = Math.max(maxOver, W.previewNow().me[2] - stopAt); if (performance.now() - t1 > 900) res(); else requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    let back = 0;
    for (let i = 1; i < zs.length; i++) back = Math.min(back, zs[i] - zs[i - 1]);
    const final = W.previewNow().me[2];
    const server = W.latest.b.find((b) => b.id === W.me).p[2];
    return { moved: Math.round(moved), frames: zs.length, maxBackStep: +back.toFixed(3), coastAfterStop: +maxOver.toFixed(3), restDiff: +Math.abs(final - server).toFixed(3), rtt: +W.rtt.toFixed(3) };
  }, on);
  console.log(`LAG ${LAG}ms 한 방향 · 예측 ${on ? '켬' : '끔'}`, JSON.stringify(res));
}
console.log('errors', errs);
await browser.close();
proxy.close();
await srv.close?.();
process.exit(0);
