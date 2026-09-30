// 브라우저 두 개(같은 PC의 두 클라이언트)로 실제 화면을 띄워 확인하는 스크립트.
// 필요: `npm i -D playwright` 후 `npx playwright install chromium` (또는 이미 설치된 Playwright)
// 실행: npm run e2e  → e2e-output/ 에 스크린숏 저장
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { startServer } from '../server/index.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* 전역 설치 확인 */ }
  for (const base of [process.env.PLAYWRIGHT_GLOBAL, '/opt/node22/lib/node_modules/', '/usr/local/lib/node_modules/', '/usr/lib/node_modules/']) {
    if (!base) continue;
    try { return createRequire(base.endsWith('/') ? base : `${base}/`)('playwright'); } catch { /* 다음 */ }
  }
  console.error('playwright를 찾을 수 없어요. `npm i -D playwright && npx playwright install chromium` 후 다시 실행하세요.');
  process.exit(2);
}

const { chromium } = await loadPlaywright();
const OUT = 'e2e-output';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const srv = await startServer({ port: 0, log: process.env.E2E_VERBOSE ? console.log : () => {} });
const url = `http://localhost:${srv.port}/?autojoin=1`;
if (process.env.E2E_VERBOSE) {
  const g = srv.game;
  const orig = g.handle.bind(g);
  g.handle = (pid, msg) => {
    const r = orig(pid, msg);
    if (msg.t === 'cast') {
      const v = g.viewAt(Number(msg.vt));
      console.log(`[host cast] ${pid} time=${g.time.toFixed(3)} vt=${msg.vt} hist=[${g.history[0].time.toFixed(3)}..${g.history.at(-1).time.toFixed(3)}] A.now=${g.body('A').pos.map((x) => x.toFixed(2))} A.view=${v?.get('A')?.map((x) => x.toFixed(2))} → ${r.ok ? 'ok' : r.reason}`);
    }
    return r;
  };
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const pages = {};
try {
  for (const id of ['A', 'B']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${id}: ${e.message}`));
    p.on('console', (m) => { if (process.env.E2E_VERBOSE) console.log(`[${id}] ${m.text()}`); });
    await p.goto(url);
    await p.waitForFunction((want) => window.__wm?.me === want, id, { timeout: 10000 }).catch(async (e) => { console.log(id, await p.evaluate(() => [window.__wm?.me, window.__wm?.phase, document.getElementById("lobby-status").textContent])); throw e; });
    pages[id] = p;
  }
  const { A, B } = pages;
  await A.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest);
  await B.waitForFunction(() => window.__wm.phase === 'playing' && window.__wm.latest);
  await sleep(800);
  check('두 클라이언트가 접속해 게임 시작', true);
  await A.screenshot({ path: `${OUT}/01-A-start.png` });
  await B.screenshot({ path: `${OUT}/01-B-start.png` });

  const bodyOf = (page, id) => page.evaluate((i) => window.__wm.latest.b.find((x) => x.id === i), id);

  // 1) A가 B를 조준 → 미리보기에 B가 강조 → 시전
  await A.evaluate(() => window.__wm.aimAt('B'));
  await A.waitForFunction(() => window.__wm.preview?.ok?.has('B'), null, { timeout: 3000 }).catch(() => {});
  const pv = await A.evaluate(() => [...(window.__wm.preview?.ok || [])]);
  check('A의 조준 미리보기에 B가 적용 대상으로 표시', pv.includes('B'), pv.join(','));
  await A.screenshot({ path: `${OUT}/02-A-aim-B.png` });
  const b0 = await bodyOf(B, 'B');
  await A.evaluate(() => { window.__wm.aimAt('B'); window.__wm.cast(); });
  await sleep(900);
  const b1 = await bodyOf(B, 'B');
  const b1a = await bodyOf(A, 'B');
  const moved = Math.hypot(b1.p[0] - b0.p[0], b1.p[2] - b0.p[2]);
  check('「대상을 민다」로 B가 밀림', moved > 0.8, `${moved.toFixed(2)}m`);
  check('두 화면이 같은 B 위치를 봄', Math.hypot(b1.p[0] - b1a.p[0], b1.p[2] - b1a.p[2]) < 0.6);

  // 2) B가 돌을 띄운다 (같은 문장, 다른 대상)
  await sleep(300);
  await B.evaluate(() => { window.__wm.aimAt('rock'); window.__wm.cast(); });
  await sleep(800);
  const rockA = await bodyOf(A, 'rock');
  check('B가 띄운 돌이 A 화면에서도 떠 있음', rockA.f > 0 && rockA.p[1] > 1.5, `y=${rockA.p[1]}`);
  await B.screenshot({ path: `${OUT}/03-B-lift-rock.png` });
  await A.screenshot({ path: `${OUT}/03-A-sees-rock.png` });

  // 3) 같은 「대상을 띄운다」를 친구에게
  await sleep(400);
  await B.evaluate(() => { window.__wm.aimAt('A'); window.__wm.cast(); });
  await sleep(700);
  const aA = await bodyOf(A, 'A');
  check('같은 문장으로 친구(A)도 띄움', aA.f > 0, `f=${aA.f}`);
  await A.screenshot({ path: `${OUT}/04-A-lifted.png` });

  // 4) A가 R로 해제 → 양쪽 화면에 보호 상태
  await A.keyboard.press('KeyR');
  await sleep(250);
  const aShieldOnB = await bodyOf(B, 'A');
  check('R 해제 후 B 화면에서도 A 보호 상태', aShieldOnB.i > 0 && aShieldOnB.f === 0, `i=${aShieldOnB.i}`);
  const n0 = await B.evaluate(() => window.__wm.recent.length);
  const aimInfo = await B.evaluate(() => { window.__wm.aimAt('A'); const p = window.__wm.previewNow(); window.__wm.cast(); return p; });
  await B.waitForFunction((n) => window.__wm.recent.slice(n).some((e) => (e.k === 'cast' || e.k === 'castFail') && e.by === 'B'), n0, { timeout: 3000 }).catch(() => {});
  const reply = await B.evaluate((n) => window.__wm.recent.slice(n).find((e) => (e.k === 'cast' || e.k === 'castFail') && e.by === 'B'), n0);
  const toast = await B.evaluate(() => document.getElementById('toast').textContent);
  check('보호 중인 A에게 시전하면 거절되고 이유 표시', reply?.k === 'castFail' && /보호/.test(reply.reason) && /보호/.test(toast), `${JSON.stringify(reply)} / 미리보기 ${JSON.stringify(aimInfo)}`);
  await B.screenshot({ path: `${OUT}/05-B-sees-A-shield.png` });

  // 5) 키보드 이동: A가 W를 1초간
  const a0 = await bodyOf(A, 'A');
  await A.evaluate(() => window.__wm.setView(0, -0.08));
  await A.keyboard.down('KeyW');
  await sleep(1000);
  await A.keyboard.up('KeyW');
  await sleep(300);
  const a1 = await bodyOf(B, 'A');
  check('WASD 이동이 상대 화면에 반영', a1.p[2] - a0.p[2] > 2, `${(a1.p[2] - a0.p[2]).toFixed(2)}m`);

  // 6) B가 Tab 편집창에서 「대상을」을 내려놓는다 → 슬롯이 비고, A 화면에 단어가 보인다
  await B.keyboard.press('Tab');
  await sleep(300);
  await B.screenshot({ path: `${OUT}/06-B-editor.png` });
  await B.locator('.inv-card', { hasText: '대상을' }).getByRole('button', { name: '내려놓기' }).click();
  await sleep(400);
  const bSlots = await B.evaluate(() => window.__wm.latest.p.B.s);
  check('장착 단어를 내려놓으면 슬롯이 빔', bSlots.target === null, JSON.stringify(bSlots));
  await B.screenshot({ path: `${OUT}/07-B-editor-after-drop.png` });
  await B.keyboard.press('Tab');
  const t3OnA = await A.evaluate(() => window.__wm.latest.k.find((k) => k.id === 't3'));
  check('내려놓은 단어가 A 화면의 월드에 있음', !t3OnA.o && !!t3OnA.p);
  await sleep(300);
  await B.screenshot({ path: `${OUT}/08-B-hud-incomplete.png` });

  // 시각 확인용: 호스트 상태를 직접 배치한다(규칙 검증이 아니라 화면 표시 확인). 결과는 [시각]으로 구분한다.
  const place = (id, [x, y, z]) => {
    const b = srv.game.body(id);
    Object.assign(b, { pos: [x, y + b.half[1], z], vy: 0, ext: [0, 0], inVel: [0, 0], float: null });
  };
  place('B', [3.8, 0, 17]);
  place('A', [5.5, 0, 17.6]);
  await sleep(300);
  srv.game.handle('B', { t: 'pickup' }); // 「주변의 대상들을」 (빈 대상 슬롯에 자동 장착)
  await B.evaluate(() => window.__wm.setView(-0.4, -0.25));
  await sleep(700);
  const nb = await B.evaluate(() => ({ rule: window.__wm.preview?.rule, ok: [...(window.__wm.preview?.ok || [])] }));
  check('[시각] 「주변의 대상들을」 범위 표시와 친구·상자 강조', nb.rule === 'NEARBY' && nb.ok.includes('A') && nb.ok.includes('box2'), JSON.stringify(nb));
  await B.screenshot({ path: `${OUT}/10-B-nearby-preview.png` });
  await B.evaluate(() => window.__wm.cast());
  await sleep(900);
  await B.screenshot({ path: `${OUT}/11-B-nearby-lift.png` });

  place('cargo', [0, 1.6, 34]);
  place('A', [-1.5, 1.6, 34]);
  place('B', [1.5, 1.6, 33.6]);
  await A.evaluate(() => window.__wm.setView(Math.PI, -0.2));
  await sleep(2200);
  await Promise.all([A, B].map((p) => p.waitForFunction(() => !document.getElementById('clear-banner').hidden, null, { timeout: 5000 }).catch(() => {})));
  const cleared = await Promise.all([A, B].map((p) => p.evaluate(() => !document.getElementById('clear-banner').hidden)));
  check('[시각] 도착 성공 표시가 양쪽 화면에 보임', cleared.every(Boolean), JSON.stringify(cleared));
  await A.screenshot({ path: `${OUT}/12-A-clear.png` });

  // 7) B의 연결이 끊기면 A는 안내 후 로비로
  await B.close();
  await A.waitForFunction(() => !document.getElementById('lobby').hidden, null, { timeout: 5000 });
  const note = await A.evaluate(() => document.getElementById('lobby-note').textContent);
  check('상대 연결이 끊기면 로비로 돌아감', /연결이 끊겨/.test(note), note);
  await A.screenshot({ path: `${OUT}/09-A-lobby-after-peer-left.png` });

  check('페이지 스크립트 오류 없음', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('E2E 실행', false, e.message);
} finally {
  await browser.close();
  await srv.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과 · 스크린숏: ${OUT}/`);
process.exit(failed ? 1 : 0);
