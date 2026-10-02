// 정적 호스팅(Vercel 등)용 웹 버전을 만든다 → dist/web/
// 방장 브라우저가 호스트가 되고 친구와 P2P(WebRTC)로 연결한다. 서버 프로그램이 필요 없다.
// three.js와 PeerJS는 CDN(jsdelivr)에서 불러온다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist/web');
const PEERJS_VERSION = '1.5.5';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');

const page = html
  .replace('<link rel="stylesheet" href="/client/style.css">', '<link rel="stylesheet" href="client/style.css">')
  .replace(
    /<script type="importmap">[\s\S]*?<\/script>/,
    `<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@${pkg.dependencies.three}/build/three.module.js" } }</script>
  <script src="https://cdn.jsdelivr.net/npm/peerjs@${PEERJS_VERSION}/dist/peerjs.min.js"></script>
  <script>window.WM_MODE = 'web';</script>`,
  )
  .replace('<script type="module" src="/client/main.js"></script>', '<script type="module" src="client/main.js"></script>');

if (page.includes('/client/') || page.includes('/vendor/')) throw new Error('절대 경로가 남아 있어요');

fs.rmSync(OUT, { recursive: true, force: true });
const copy = (rel) => {
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), path.join(OUT, rel));
};
for (const dir of ['client', 'shared']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) if (/\.(js|css)$/.test(f)) copy(`${dir}/${f}`);
}
for (const f of fs.readdirSync(path.join(ROOT, 'server'))) if (f.endsWith('.js') && f !== 'index.js') copy(`server/${f}`); // 판정 코드(서버 프로그램 빼고)
fs.writeFileSync(path.join(OUT, 'index.html'), page);
console.log(`dist/web/ 생성 (three ${pkg.dependencies.three}, peerjs ${PEERJS_VERSION})`);
