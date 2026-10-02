// 세계의 성질을 단어로(v0.5) 화면 확인용 스크린숏(규칙 검증은 test/world.test.js). 실행: node scripts/shot-world.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { startServer } from '../server/index.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* 전역 설치 확인 */ }
  for (const base of [process.env.PLAYWRIGHT_GLOBAL, '/opt/node22/lib/node_modules/', '/usr/local/lib/node_modules/', '/usr/lib/node_modules/']) {
    if (!base) continue;
    try { return createRequire(base.endsWith('/') ? base : `${base}/`)('playwright'); } catch { /* 다음 */ }
  }
  console.error('playwright를 찾을 수 없어요.');
  process.exit(2);
}
const { chromium } = await loadPlaywright();
const OUT = process.argv[2] || 'e2e-output';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = await startServer({ port: 0, log: () => {} });
const url = `http://localhost:${srv.port}/?autojoin=1`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const pages = {};
for (const id of ['A', 'B']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${id}: ${e.message}`));
  await p.goto(url);
  await p.waitForFunction((w) => window.__wm?.me === w, id, { timeout: 10000 });
  pages[id] = p;
}
const { A } = pages;
await A.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest);
await sleep(800);
const g = srv.game;
const place = (id, [x, y, z]) => { const b = g.body(id); Object.assign(b, { pos: [x, y + b.half[1], z], vy: 0, ext: [0, 0], inVel: [0, 0] }); };
const give = (word) => { const t = g.makeToken({ id: `s${Math.random().toString(36).slice(2, 6)}`, word }, 'A'); g.tokens.push(t); return t.id; };
const holdWord = async (word) => {
  await A.waitForFunction((w) => window.__wm.hotbar.some((x) => x?.word === w), word, { timeout: 3000 }).catch(() => {});
  await A.evaluate((w) => { const i = window.__wm.hotbar.findIndex((x) => x?.word === w); if (i >= 0) window.__wm.selectSlot(i); }, word);
  await sleep(300);
};

// 1) 출발 구역: 커다란 바위(왼쪽)와 모닥불(오른쪽)
place('A', [0, 0, 3]); place('B', [1.5, 0, 3]);
await A.evaluate(() => { window.__wm.setCamera('third'); window.__wm.setView(0, -0.25); });
await sleep(700);
await A.screenshot({ path: `${OUT}/w1-start-boulder-campfire.png` });

// 2) <당기기>로 모닥불 조준 → 미리보기에 <불>이 나올 것이 보인다
g.token('w7').owner = 'A'; g.token('w7').pos = null;
await holdWord('PULL');
place('A', [3, 0, 8.6]);
await sleep(600);
await A.evaluate(() => { window.__wm.setCamera('first'); window.__wm.aimAt('campfire'); });
await sleep(700);
await A.screenshot({ path: `${OUT}/w2-pull-campfire-preview.png` });
await A.evaluate(() => window.__wm.cast());
await sleep(350);
await A.screenshot({ path: `${OUT}/w3-fire-word-born.png` });
await sleep(1500);

// 3) 바위 깎기: 밀치기로 몇 번 → 작아지고 <큰>
await holdWord('PUSH');
place('A', [-3, 0, 8.6]);
await sleep(600);
for (let i = 0; i < 3; i++) {
  await A.evaluate(() => window.__wm.aimAt('boulder'));
  await sleep(200);
  await A.evaluate(() => window.__wm.cast());
  await sleep(1150);
}
await A.evaluate(() => { window.__wm.setCamera('third'); window.__wm.aimAt('boulder'); });
await sleep(300);
await A.screenshot({ path: `${OUT}/w4-boulder-chipped.png` });

// 4) 눈밭과 얼음
const wid = give('WATER');
await holdWord('WATER');
place('A', [-5.5, 0, 23.2]);
await sleep(600);
await A.evaluate(() => { window.__wm.setCamera('first'); window.__wm.setView(0, -0.3); });
await sleep(400);
await A.evaluate(() => window.__wm.cast());
await sleep(1200);
await A.evaluate(() => { window.__wm.setCamera('third'); window.__wm.setView(0.4, -0.25); });
await sleep(500);
await A.screenshot({ path: `${OUT}/w5-snow-ice.png` });

// 5) 가방의 섞는 칸: <불> + <물> → <수증기>
give('WATER');
await sleep(400);
await A.keyboard.press('KeyE');
await sleep(400);
for (const w of ['FIRE', 'WATER']) {
  await A.locator(`#mc-main .mc-slot[data-word="${w}"], #mc-hot .mc-slot[data-word="${w}"]`).first().click();
  await A.locator('#mc-mixin .mc-slot:not([data-word])').first().click();
  await sleep(150);
}
await sleep(300);
await A.screenshot({ path: `${OUT}/w6-bag-mix.png` });
await A.locator('#mc-mixout').click({ force: true });
await sleep(500);
await A.screenshot({ path: `${OUT}/w7-bag-mixed.png` });
const made = g.tokens.filter((t) => t.owner === 'A' && t.word === 'STEAM').length;
console.log(JSON.stringify({ errors, made, ice: g.bodies.filter((b) => b.kind === 'ice').length, boulder: g.body('boulder')?.scale, wid }));
await browser.close();
await srv.close?.();
process.exit(0);
