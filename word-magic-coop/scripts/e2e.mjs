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
  // 안내는 글 대신 그림 순서(단계 점 + 좌클릭 그림 + 손에 든 단어)
  const guide0 = await A.evaluate(() => ({ step: window.__wm.guideStep, word: !!document.querySelector('#guide .wt'), text: document.getElementById('guide').textContent }));
  check("'처음 해보기' 안내가 첫 할 일을 보여 줌(그림)", guide0.step === 1 && guide0.word, JSON.stringify(guide0));
  await A.screenshot({ path: `${OUT}/01-A-start.png` });
  // 시점: 기본 1인칭(손만 보임), V로 3인칭
  const cam0 = await A.evaluate(() => window.__wm.view.mode);
  await A.keyboard.press('KeyV');
  await sleep(150);
  const cam1 = await A.evaluate(() => window.__wm.view.mode);
  await A.screenshot({ path: `${OUT}/01-A-third.png` });
  await A.keyboard.press('KeyV');
  await sleep(150);
  check('기본은 1인칭(손만), V로 3인칭 전환', cam0 === 'first' && cam1 === 'third', `${cam0}→${cam1}`);
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
  check('<밀치기>로 B가 밀림', moved > 0.8, `${moved.toFixed(2)}m`);
  const guide1 = await A.evaluate(() => ({ step: window.__wm.guideStep, text: document.getElementById('guide').textContent }));
  check('써 보고 나면 안내가 다음 단계(F 모드)로', guide1.step === 2 && /F/.test(guide1.text), JSON.stringify(guide1));
  check('두 화면이 같은 B 위치를 봄', Math.hypot(b1.p[0] - b1a.p[0], b1.p[2] - b1a.p[2]) < 0.6);

  // 2) B가 <들기>로 돌을 든다: 시전 종료 전까지 유지, 시점을 올리면 따라 올라간다
  //    실제 마우스로: 좌클릭을 눌렀다 떼도 유지되고, 우클릭(시전 종료)으로 놓는다
  await sleep(300);
  await B.bringToFront();
  const vp = B.viewportSize();
  await B.mouse.click(vp.width / 2, vp.height / 2); // 첫 클릭은 마우스 잠금
  await B.waitForFunction(() => window.__wm.locked, null, { timeout: 3000 }).catch(() => {});
  const locked = await B.evaluate(() => window.__wm.locked);
  if (locked) { // 잠금 직후 첫 이벤트의 이동량을 비워 낸 뒤 조준(헤드리스 브라우저 특성)
    await B.mouse.move(vp.width / 2 + 1, vp.height / 2);
    await B.mouse.move(vp.width / 2, vp.height / 2);
    await sleep(100);
  }
  const yaw0 = await B.evaluate(() => { window.__wm.setView(0, 0); window.__wm.aimAt('rock'); return window.__wm.view.yaw; });
  if (locked) {
    await B.mouse.down({ button: 'left' });
    await sleep(150);
    await B.mouse.up({ button: 'left' });
  } else {
    await B.evaluate(() => window.__wm.cast()); // 마우스 잠금을 못 얻는 환경
  }
  await sleep(300);
  await B.evaluate((y) => window.__wm.setView(y, 0.55), yaw0); // 헤드리스의 잠금 중 가짜 이동량이 시점을 돌리지 않게 복원
  await sleep(1200);
  const rockA = await bodyOf(A, 'rock');
  check(`좌클릭을 뗀 뒤에도 B가 든 돌이 A 화면에서 들려 있음${locked ? '' : ' (마우스 잠금 없음: 함수로 시전)'}`, rockA.h?.includes('B') && rockA.p[1] > 1.2, `h=${rockA.h} y=${rockA.p[1]}`);
  await B.screenshot({ path: `${OUT}/03-B-lift-rock.png` });
  await A.screenshot({ path: `${OUT}/03-A-sees-rock.png` });
  const blocked = await B.evaluate(() => { window.__wm.cast(); return !!document.querySelector('#toast [data-r="SUSTAINING"]'); });
  check('들고 있는 중 재시전은 시전 종료 안내(우클릭 그림)', blocked);
  if (locked) await B.mouse.click(vp.width / 2, vp.height / 2, { button: 'right' });
  else await B.evaluate(() => window.__wm.endCast());
  await sleep(1300);
  const rockDown = await bodyOf(A, 'rock');
  check('시전 종료(우클릭)로 놓아서 떨어진다', !rockDown.h && rockDown.p[1] < 0.6, `y=${rockDown.p[1]}`);
  await B.evaluate(() => document.exitPointerLock());
  await A.bringToFront();

  // 3) 같은 <들기>를 친구에게
  await B.evaluate(() => { window.__wm.setView(window.__wm.view.yaw, -0.1); window.__wm.aimAt('A'); window.__wm.cast(); });
  await sleep(900);
  const aA = await bodyOf(A, 'A');
  check('같은 주문으로 친구(A)도 든다', aA.h?.includes('B'), `h=${aA.h}`);
  await A.screenshot({ path: `${OUT}/04-A-lifted.png` });

  // 4) A가 R로 풀기 → 양쪽 화면에 보호 상태, 보호 중에는 B의 마법이 거절된다
  await A.keyboard.press('KeyR');
  await sleep(300);
  const aShieldOnB = await bodyOf(B, 'A');
  check('R로 풀면 B 화면에서도 A가 풀리고 보호 상태', aShieldOnB.i > 0 && !aShieldOnB.h?.length, `i=${aShieldOnB.i} h=${aShieldOnB.h}`);
  await sleep(1100);
  const n0 = await B.evaluate(() => window.__wm.recent.length);
  const aimInfo = await B.evaluate(() => { window.__wm.aimAt('A'); const p = window.__wm.previewNow(); window.__wm.cast(); return p; });
  await B.waitForFunction((n) => window.__wm.recent.slice(n).some((e) => (e.k === 'liftStart' || e.k === 'castFail') && e.by === 'B'), n0, { timeout: 3000 }).catch(() => {});
  const reply = await B.evaluate((n) => window.__wm.recent.slice(n).find((e) => (e.k === 'liftStart' || e.k === 'castFail') && e.by === 'B'), n0);
  const toast = await B.evaluate(() => !!document.querySelector('#toast.bad [data-r="PROTECTED"]'));
  check('보호 중인 A에게 시전하면 거절되고 이유를 기호로 표시(방패)', reply?.k === 'castFail' && /보호/.test(reply.reason) && toast, `${JSON.stringify(reply)} / 미리보기 ${JSON.stringify(aimInfo)}`);
  await B.screenshot({ path: `${OUT}/05-B-sees-A-shield.png` });
  await B.evaluate(() => window.__wm.endCast());

  // 5) 키보드 이동: A가 W를 1초간
  const a0 = await bodyOf(A, 'A');
  await A.evaluate(() => window.__wm.setView(0, -0.08));
  await A.keyboard.down('KeyW');
  await sleep(1000);
  await A.keyboard.up('KeyW');
  await sleep(300);
  const a1 = await bodyOf(B, 'A');
  check('WASD 이동이 상대 화면에 반영', a1.p[2] - a0.p[2] > 2, `${(a1.p[2] - a0.p[2]).toFixed(2)}m`);

  // 6) B가 E로 가방을 열고, 핫바 칸의 <들기> 위에서 Q → 던져져 손이 비고, A 화면에 단어가 보인다
  await B.bringToFront();
  await B.keyboard.press('KeyE');
  await sleep(300);
  await B.screenshot({ path: `${OUT}/06-B-editor.png` });
  check('E로 마인크래프트식 가방이 열림(27칸 + 핫바 9칸 + 수식 칸 5칸)', await B.evaluate(() => document.querySelectorAll('#mc-main .mc-slot').length === 27 && document.querySelectorAll('#mc-hot .mc-slot').length === 9 && document.querySelectorAll('#mc-mods .mc-slot').length === 5));
  await B.locator('#mc-hot .mc-slot[data-word="LIFT"]').hover();
  await B.keyboard.press('KeyQ');
  await sleep(500);
  const bEffect = await B.evaluate(() => window.__wm.latest.p.B.e);
  check('가방에서 손에 든 <들기> 위에 Q → 던져서 손이 빔', bEffect === null, String(bEffect));
  await B.keyboard.press('KeyE');
  await A.bringToFront();
  const t2OnA = await A.evaluate(() => window.__wm.latest.k.find((k) => k.id === 't2'));
  check('내려놓은 단어가 A 화면의 월드에 있음', !t2OnA.o && !!t2OnA.p);
  await sleep(300);
  await B.screenshot({ path: `${OUT}/08-B-hud-incomplete.png` });

  // 7) F로 대상 모드 전환: A의 같은 <밀치기>가 주변 모드로 친구·상자를 함께 민다
  await A.keyboard.press('KeyF');
  await A.keyboard.press('KeyF');
  const modeA = await A.evaluate(() => window.__wm.mode);
  check('F를 두 번 누르면 주변 모드', modeA === 'NEAR', modeA);

  // 시각 확인용: 호스트 상태를 직접 배치한다(규칙 검증이 아니라 화면 표시 확인). 결과는 [시각]으로 구분한다.
  const place = (id, [x, y, z]) => {
    const b = srv.game.body(id);
    Object.assign(b, { pos: [x, y + b.half[1], z], vy: 0, ext: [0, 0], inVel: [0, 0] });
  };
  place('rock', [-5, 0, 3]); // 앞 단계에서 던진 돌이 떨어진 자리와 겹치지 않게
  place('A', [3, 0, 8]);
  place('B', [4.4, 0, 8.6]);
  place('box1', [1.8, 0, 9]);
  await A.evaluate(() => window.__wm.setView(0.3, -0.35));
  await A.waitForFunction(() => { const ok = window.__wm.preview?.ok; return ok?.has('B') && ok?.has('box1'); }, null, { timeout: 3000 }).catch(() => {});
  const nb = await A.evaluate(() => ({ kind: window.__wm.preview?.kind, ok: [...(window.__wm.preview?.ok || [])], at: window.__wm.previewNow().bodies }));
  check('[시각] 주변 모드 범위 표시와 친구·상자 강조', nb.kind === 'push' && nb.ok.includes('B') && nb.ok.includes('box1'), JSON.stringify(nb));
  await A.screenshot({ path: `${OUT}/10-A-near-preview.png` });
  await A.evaluate(() => window.__wm.cast());
  await sleep(500);
  await A.screenshot({ path: `${OUT}/11-A-near-push.png` });

  // [시각] <큰> × 3 + <파이어볼>: 날아가는 크기와 명중 폭발
  const g = srv.game;
  // 손에 들기: 핫바에서 그 단어 칸을 고른다(가방 배치는 각 화면의 것이라 서버만 바꾸면 화면이 되돌린다)
  const holdWord = async (page, word) => {
    await page.waitForFunction((w) => window.__wm.hotbar.some((x) => x?.word === w), word, { timeout: 3000 }).catch(() => {});
    await page.evaluate((w) => { const i = window.__wm.hotbar.findIndex((x) => x?.word === w); if (i >= 0) window.__wm.selectSlot(i); }, word);
    await sleep(300);
  };
  g.token('w1').owner = 'A'; g.token('w1').pos = null;
  // 바닥의 <큰>은 1개뿐(나머지는 바위에서 얻는다) → 시험용으로 2개를 더 쥐여 준다
  for (const id of ['w3', 'w4']) if (!g.token(id)) g.tokens.push(g.makeToken({ id, word: 'BIG' }, 'A'));
  for (const id of ['w2', 'w3', 'w4']) { g.token(id).owner = 'A'; g.token(id).pos = null; }
  await holdWord(A, 'FIREBALL');
  // [브라우저] 가방 창: 수식 묶음(큰×3)을 Shift+클릭하면 수식 칸으로, 결과에 주문이 보인다. 수식 칸을 Shift+클릭하면 가방으로
  await A.keyboard.press('KeyE');
  await sleep(300);
  // [브라우저] 끌어서 나눠 놓기(마크): <큰>×3을 집어 빈칸 3개 위로 끌면 1개씩, 두 번 클릭하면 다시 한 묶음
  const centerOf = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  await A.locator('.mc-grid .mc-slot[data-word="BIG"]').first().click();
  const empties = A.locator('#mc-main .mc-slot:not([data-word])');
  const pts = [];
  for (let i = 0; i < 3; i++) pts.push(await centerOf(empties.nth(i)));
  await A.mouse.move(...pts[0]);
  await A.mouse.down();
  await A.mouse.move(...pts[1], { steps: 4 });
  await A.mouse.move(...pts[2], { steps: 4 });
  await A.screenshot({ path: `${OUT}/19-A-bag-drag.png` });
  await A.mouse.up();
  await sleep(200);
  const spread = await A.evaluate(() => window.__wm.bag);
  const ones = spread.slots.filter((x) => x?.word === 'BIG').map((x) => x.n);
  check('[브라우저] 단어를 든 채 빈칸 3개 위로 끌면 1개씩 나눠 놓임(마크)', ones.join() === '1,1,1' && !spread.cursor, JSON.stringify(ones));
  await A.mouse.dblclick(...pts[1]);
  await sleep(200);
  const col = await A.evaluate(() => window.__wm.bag);
  check('[브라우저] 두 번 클릭하면 같은 수식이 다시 한 묶음으로 모임', col.cursor?.word === 'BIG' && col.cursor.n === 3 && !col.slots.some((x) => x?.word === 'BIG'), JSON.stringify(col.cursor));
  await A.mouse.click(...pts[0]);
  await sleep(200);
  await A.locator('.mc-grid .mc-slot[data-word="BIG"]').first().click({ modifiers: ['Shift'] });
  for (let i = 0; i < 20 && g.modCounts('A').BIG !== 3; i++) await sleep(100);
  await sleep(150);
  const r3 = await A.evaluate(() => document.getElementById('mc-result').textContent);
  check('[브라우저] Shift+클릭으로 <큰>×3이 수식 칸에, 결과에 주문 표시', /큰×3.*파이어볼/.test(r3) && g.modCounts('A').BIG === 3, `${r3} / 서버 ${g.modCounts('A').BIG}`);
  await A.screenshot({ path: `${OUT}/18-A-bag.png` });
  await A.locator('#mc-mods .mc-slot[data-word="BIG"]').first().click({ modifiers: ['Shift'] });
  for (let i = 0; i < 20 && g.modCounts('A').BIG !== 2; i++) await sleep(100);
  await sleep(150);
  const r2 = await A.evaluate(() => document.getElementById('mc-result').textContent);
  check('[브라우저] 수식 칸을 Shift+클릭하면 가방으로(×2)', /큰×2/.test(r2) && g.modCounts('A').BIG === 2, `${r2} / 서버 ${g.modCounts('A').BIG}`);
  // 좌클릭으로 집어서 빈 수식 칸에 놓기(한 칸에 하나)
  await A.locator('.mc-grid .mc-slot[data-word="BIG"]').first().click();
  await A.locator('#mc-mods .mc-slot:not([data-word])').first().click();
  for (let i = 0; i < 20 && g.modCounts('A').BIG !== 3; i++) await sleep(100); // 서버 반영 대기
  check('[브라우저] 집어서 수식 칸에 놓기', g.modCounts('A').BIG === 3 && !(await A.evaluate(() => window.__wm.bag.cursor)), `서버 ${g.modCounts('A').BIG}`);
  // 수식 칸에 효과 단어는 안 들어간다
  await A.locator('#mc-hot .mc-slot[data-word="PUSH"]').click();
  await A.locator('#mc-mods .mc-slot:not([data-word])').first().click();
  const rejectToast = await A.evaluate(() => !!document.querySelector('#toast [data-r="MOD_ONLY"]'));
  check('[브라우저] 수식 칸에 효과 단어를 넣으면 거절 안내(기호)', rejectToast);
  await A.keyboard.press('KeyE'); // 닫으면 들고 있던 단어는 가방으로 돌아간다
  await sleep(300);
  check('[브라우저] 가방을 닫으면 커서에 든 단어는 가방으로', await A.evaluate(() => !window.__wm.bag.cursor && window.__wm.bag.slots.some((x) => x?.word === 'PUSH')));
  place('A', [-2.6, 0, 13]);
  await A.evaluate(() => window.__wm.setMode('AIM'));
  await sleep(600);
  const hp0 = g.body('dummy').hp;
  await A.evaluate(() => { window.__wm.aimAt('dummy'); window.__wm.cast(); });
  await sleep(250);
  await A.screenshot({ path: `${OUT}/12-A-fireball-flight.png` });
  await sleep(900);
  await A.screenshot({ path: `${OUT}/13-A-fireball-hit.png` });
  check('[시각] <큰>×3 파이어볼이 날아가 허수아비에 명중', g.body('dummy').hp < hp0, `hp ${hp0} → ${g.body('dummy').hp}`);

  // [브라우저] 같이 들기: A가 혼자 붙잡으면 안 올라가고, B가 합류하면 같이 들어 올린다(두 화면 확인)
  g.token('w8').owner = 'A'; g.token('w8').pos = null;
  g.token('t2').owner = 'B'; g.token('t2').pos = null;
  place('box2', [0, 0, 18]); place('A', [-1.6, 0, 15.4]); place('B', [1.6, 0, 15.4]); place('dummy', [-5, 0, 22]);
  await holdWord(A, 'LIFT');
  await holdWord(B, 'LIFT');
  await A.evaluate(() => { window.__wm.toggleEditor(true); });
  await A.locator('#mc-mods .mc-slot[data-word="BIG"]').first().click({ modifiers: ['Shift'] }).catch(() => {});
  await A.evaluate(() => { window.__wm.toggleEditor(false); });
  await sleep(1100);
  await A.evaluate(() => { window.__wm.setMode('AIM'); window.__wm.setView(0, 0); window.__wm.aimAt('box2'); window.__wm.cast(); });
  await A.evaluate(() => window.__wm.setView(window.__wm.view.yaw, 0.5));
  await sleep(900);
  const solo = await bodyOf(B, 'box2');
  check('[브라우저] 혼자 붙잡은 무거운 상자는 안 올라감(B 화면)', solo.h?.includes('A') && solo.hv === 1 && solo.p[1] < 0.6, JSON.stringify(solo));
  const soloNote = await A.evaluate(() => window.__wm.previewKind);
  check('혼자서는 무겁다는 안내(무게 그림)', soloNote === 'heavy', soloNote);
  await B.evaluate(() => { window.__wm.setMode('AIM'); window.__wm.setView(0, 0); window.__wm.aimAt('box2'); window.__wm.cast(); });
  await B.evaluate(() => window.__wm.setView(window.__wm.view.yaw, 0.5));
  await sleep(2000);
  const both = await bodyOf(A, 'box2');
  check('[브라우저] B가 합류하면 같이 들어 올림(A 화면)', both.h?.length === 2 && !both.hv && both.p[1] > 1.2, JSON.stringify(both));
  await A.screenshot({ path: `${OUT}/15-A-colift.png` });
  await A.evaluate(() => window.__wm.endCast());
  await B.evaluate(() => window.__wm.endCast());
  await sleep(600);

  // [시각] 주변 모드 미리보기: 들기(가벼운 것부터) / 본인 모드 파이어볼(발밑 폭발 범위)
  place('rock', [-2.4, 0, 16]); place('box1', [-0.6, 0, 17]); place('A', [-1.5, 0, 15.6]); place('B', [4, 0, 12.8]); place('box2', [2.4, 0, 18.4]);
  await A.evaluate(() => { window.__wm.setMode('NEAR'); window.__wm.setView(0.4, -0.3); });
  await sleep(1300);
  const nl = await A.evaluate(() => ({ kind: window.__wm.preview?.kind, ok: [...(window.__wm.preview?.ok || [])] }));
  check('[시각] 주변 들기 미리보기에 돌·상자 강조', nl.kind === 'lift' && nl.ok.includes('rock') && nl.ok.includes('box1'), JSON.stringify(nl));
  await A.evaluate(() => window.__wm.cast());
  await sleep(1500);
  const nearHeld = await bodyOf(B, 'rock');
  check('[브라우저] 주변 들기로 돌·상자가 함께 떠오름(B 화면)', nearHeld.h?.includes('A') && nearHeld.p[1] > 1.2, JSON.stringify(nearHeld));
  await A.screenshot({ path: `${OUT}/16-A-near-lift.png` });
  await A.evaluate(() => window.__wm.endCast());
  await sleep(1300);

  // [브라우저] 마인크래프트식 주고받기: A가 핫바에서 <들기>를 고르고 Q로 B 쪽에 던지면, B 몸에 닿아 자동으로 주워진다
  place('A', [0, 0, 8]); place('B', [0, 0, 11]); place('rock', [-3, 0, 6]); place('box1', [3, 0, 6]);
  await sleep(700);
  const bar = await A.evaluate(() => window.__wm.hotbar);
  const liftSlot = bar.findIndex((x) => x?.word === 'LIFT');
  check('핫바 9칸에 가진 단어가 보임', liftSlot >= 0 && bar.length === 9 && bar.filter(Boolean).length >= 2, JSON.stringify(bar));
  await A.keyboard.press(`Digit${liftSlot + 1}`);
  await A.evaluate(() => { window.__wm.setView(0, 0); window.__wm.aimAt('B'); });
  await sleep(200);
  await A.screenshot({ path: `${OUT}/17-A-hotbar.png` });
  await A.keyboard.press('KeyQ');
  await sleep(1300);
  const bInv = await B.evaluate(() => window.__wm.latest.p.B.inv);
  const bToast = await B.evaluate(() => [...document.querySelectorAll('#toast .pc, #toast .wt')].map((x) => x.dataset.w || x.textContent).join(','));
  check('[브라우저] Q로 던진 단어가 B에게 닿아 주워지고 안내가 뜸(A → 들기)', bInv.includes('w8') && bToast === 'A,LIFT', `${bInv} / ${bToast}`);
  await sleep(300);

  place('cargo', [0, 1.6, 34]);
  place('A', [-1.5, 1.6, 34]);
  place('B', [1.5, 1.6, 33.6]);
  await A.evaluate(() => window.__wm.setView(Math.PI, -0.2));
  await sleep(2200);
  await Promise.all([A, B].map((p) => p.waitForFunction(() => !document.getElementById('clear-banner').hidden, null, { timeout: 5000 }).catch(() => {})));
  const cleared = await Promise.all([A, B].map((p) => p.evaluate(() => !document.getElementById('clear-banner').hidden)));
  check('[시각] 도착 성공 표시가 양쪽 화면에 보임', cleared.every(Boolean), JSON.stringify(cleared));
  const summary = await A.evaluate(() => window.__wm.summaryText());
  const rows = await A.evaluate(() => document.querySelectorAll('#clear-stats .cs-row').length);
  check('도착하면 판 요약이 기호·숫자로 보이고, 복사용 글 요약도 맞음', rows >= 3 && /A: 주문 \d+번/.test(summary) && /같이 들기 [1-9]/.test(summary) && /건네준 단어 1/.test(summary), `${rows}줄 | ${summary.replace(/\n/g, ' | ')}`);
  await A.screenshot({ path: `${OUT}/14-A-clear.png` });

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
