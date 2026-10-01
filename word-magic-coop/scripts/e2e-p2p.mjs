// 웹 버전(P2P) E2E: 로컬 신호 서버 + 브라우저 여러 개로 실제 WebRTC 연결을 맺어 확인한다.
// 필요: npm i --no-save peer peerjs playwright  (+ npx playwright install chromium)
// 실행: node scripts/e2e-p2p.mjs  → e2e-output/p2p-*.png
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const req = createRequire(path.join(ROOT, 'package.json'));
const tryReq = (name) => {
  for (const base of [path.join(ROOT, 'package.json'), process.env.PLAYWRIGHT_GLOBAL, '/opt/node22/lib/node_modules/']) {
    if (!base) continue;
    try { return createRequire(base.endsWith('.json') ? base : `${base}/`)(name); } catch { /* 다음 */ }
  }
  console.error(`${name}을(를) 찾을 수 없어요. npm i --no-save peer peerjs playwright 후 다시 실행하세요.`);
  process.exit(2);
};
const { chromium } = tryReq('playwright');
const { PeerServer } = tryReq('peer');
const peerjsFile = req.resolve('peerjs/dist/peerjs.min.js');

execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-web.mjs')], { stdio: 'inherit' });
const WEB = path.join(ROOT, 'dist/web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const web = http.createServer((q, s) => {
  let p = new URL(q.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(WEB, p));
  if (!f.startsWith(WEB) || !fs.existsSync(f)) { s.writeHead(404).end(); return; }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => web.listen(0, r));
const signalPort = 20000 + Math.floor(Math.random() * 20000);
const signal = PeerServer({ port: signalPort, path: '/', host: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 300));
const base = `http://localhost:${web.address().port}/?peer=127.0.0.1:${signalPort}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const errors = [];
const opened = [];
async function openPage(name, url) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  if (process.env.E2E_VERBOSE) p.on('console', (m) => console.log(`[${name}] ${m.text()}`));
  // 이 환경은 외부 글꼴 서버에 닿지 못한다: 기다리지 않고 바로 실패시킨다
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // CDN 대신 로컬 파일(이 환경은 CDN에 닿지 못한다)
  await p.route('https://cdn.jsdelivr.net/npm/three@*/build/*', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build', path.basename(new URL(r.request().url()).pathname))) }));
  await p.route('https://cdn.jsdelivr.net/npm/peerjs@*/dist/peerjs.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(peerjsFile) }));
  await p.goto(url);
  opened.push({ name, p });
  return p;
}
const bodyOf = (p, id) => p.evaluate((i) => window.__wm.latest?.b.find((x) => x.id === i), id);

try {
  // 1) 방장: 방 만들기
  const host = await openPage('방장', base);
  await host.click('#create-btn');
  await host.waitForFunction(() => /^[a-z2-9]{6}$/.test(window.__wm.roomCode), null, { timeout: 15000 });
  const code = await host.evaluate(() => window.__wm.roomCode);
  const link = await host.evaluate(() => document.getElementById('room-link').textContent);
  check('방 만들기 → 방 코드와 링크 표시', !!code && link.endsWith(`#${code}`), `${code}`);
  await host.screenshot({ path: `${OUT}/p2p-1-host-room.png` });

  // 2) 친구: 링크(#코드)로 열면 바로 참가
  const guest = await openPage('친구', link);
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest, null, { timeout: 40000 })));
  const roles = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__wm.me)));
  check('링크로 들어온 친구와 P2P 연결 → 게임 시작', roles.join() === 'A,B', roles.join());
  await sleep(600);

  // 3) 방장 이동이 친구 화면에 반영
  const a0 = await bodyOf(guest, 'A');
  await host.evaluate(() => window.__wm.setView(0, -0.08));
  await host.keyboard.down('KeyW'); await sleep(800); await host.keyboard.up('KeyW');
  await sleep(500);
  const a1 = await bodyOf(guest, 'A');
  check('방장(A) 이동이 친구 화면에 반영', a1.p[2] - a0.p[2] > 2, `${(a1.p[2] - a0.p[2]).toFixed(2)}m`);

  // 4) 친구 시전(호스트가 판정) → 방장 화면에서 A가 뜬다
  await guest.evaluate(() => { window.__wm.aimAt('A'); window.__wm.cast(); });
  await sleep(900);
  const aOnHost = await bodyOf(host, 'A');
  check('친구(B)의 <들기>가 방장 화면에서 A를 든다', aOnHost.h?.includes('B'), `h=${aOnHost.h}`);
  await host.screenshot({ path: `${OUT}/p2p-2-host-lifted.png` });
  await guest.screenshot({ path: `${OUT}/p2p-2-guest-view.png` });

  // 5) 친구가 단어를 내려놓으면 방장 화면에 보인다
  await guest.keyboard.press('Tab');
  await sleep(300);
  await guest.evaluate(() => window.__wm.endCast());
  await guest.locator('.inv-card', { hasText: '들기' }).getByRole('button', { name: '내려놓기' }).click();
  await sleep(500);
  await guest.keyboard.press('Tab');
  const t2 = await host.evaluate(() => window.__wm.latest.k.find((k) => k.id === 't2'));
  check('친구가 내려놓은 <들기>가 방장 화면의 월드에 있음', !t2.o && !!t2.p);

  // 6) 세 번째 사람은 진행 중인 판에 C로 참가 → 모두의 화면에 보이고, 나가도 게임은 계속
  const third = await openPage('세번째', link);
  await third.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest, null, { timeout: 40000 }).catch(() => {});
  const thirdMe = await third.evaluate(() => window.__wm.me);
  await sleep(600);
  const cOnHost = await bodyOf(host, 'C');
  const cOnGuest = await bodyOf(guest, 'C');
  const aOnThird = await bodyOf(third, 'A');
  check('세 번째 사람이 C로 참가해 모두의 화면에 보임', thirdMe === 'C' && !!cOnHost && !!cOnGuest && !!aOnThird, `me=${thirdMe}`);
  await third.screenshot({ path: `${OUT}/p2p-2b-third-view.png` });
  await third.context().close();
  await host.waitForFunction(() => !window.__wm.latest.b.some((b) => b.id === 'C'), null, { timeout: 20000 }).catch(() => {});
  const stillPlaying = await host.evaluate(() => window.__wm.phase === 'playing' && !window.__wm.latest.b.some((b) => b.id === 'C'));
  check('C가 나가도 방장·친구는 계속 플레이', stillPlaying);

  // 7) 친구가 나가면 방장은 로비로(방은 유지), 같은 링크로 새 친구가 들어오면 처음부터
  await guest.context().close();
  await host.waitForFunction(() => !document.getElementById('lobby').hidden, null, { timeout: 15000 });
  const note = await host.evaluate(() => document.getElementById('lobby-note').textContent);
  const roomVisible = await host.evaluate(() => !document.getElementById('room-info').hidden);
  check('친구가 나가면 방장은 로비로, 방 링크는 유지', /연결이 끊겨/.test(note) && roomVisible, note);
  await host.screenshot({ path: `${OUT}/p2p-3-host-after-leave.png` });
  const guest2 = await openPage('친구2', link);
  await Promise.all([host, guest2].map((p) => p.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest, null, { timeout: 20000 })));
  await sleep(400);
  const fresh = await bodyOf(guest2, 'A');
  check('같은 링크로 새 친구 참가 → 처음 상태로 다시 시작', Math.hypot(fresh.p[0] + 1.5, fresh.p[2] - 1) < 0.05, `${fresh.p}`);

  // 8) 방장이 나가면 친구는 안내 후 로비로
  await host.context().close();
  await guest2.waitForFunction(() => !document.getElementById('lobby').hidden, null, { timeout: 15000 }).catch(() => {});
  const g2 = await guest2.evaluate(() => document.getElementById('lobby-status').textContent);
  check('방장이 나가면 친구는 로비로', /방장과 연결이 끊겼어요/.test(g2), g2);
  await guest2.screenshot({ path: `${OUT}/p2p-4-guest-host-left.png` });

  check('페이지 스크립트 오류 없음', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('P2P E2E 실행', false, e.message.split('\n')[0]);
  for (const { name, p } of opened) {
    const st = await p.evaluate(() => ({
      phase: window.__wm?.phase, me: window.__wm?.me,
      status: document.getElementById('lobby-status')?.textContent,
      note: document.getElementById('lobby-note')?.textContent,
    })).catch((err) => `닫힘/오류: ${err.message.split('\n')[0]}`);
    console.log(`  [진단] ${name}:`, JSON.stringify(st));
  }
} finally {
  await browser.close();
  web.close();
  signal.close?.();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
