// 서버 없이 링크로 바로 여는 "혼자 해보기" 페이지를 만든다 → dist/play.html
// three.js는 CDN(jsdelivr)에서, 게임 코드(client/ shared/ server/game.js·physics.js)는 페이지 옆의 파일로 불러온다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'client/style.css'), 'utf8');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/\s*<script type="module" src="\/client\/main.js"><\/script>\s*/, '\n');

const out = `<title>단어로 만드는 마법</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jua&display=swap" media="print" onload="this.media='all'">
<style>
${css}
</style>
<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@${pkg.dependencies.three}/build/three.module.js" } }</script>
<script>window.WM_MODE = 'solo';</script>
${body.trim()}
<script type="module" src="client/main.js"></script>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/play.html'), out);

// 페이지와 함께 올릴 파일 목록(게시 경로 = 저장소 경로)
export const PLAY_FILES = [
  ...fs.readdirSync(path.join(ROOT, 'client')).filter((f) => f.endsWith('.js')).map((f) => `client/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'shared')).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`),
  'server/game.js',
  'server/physics.js',
];
fs.writeFileSync(path.join(ROOT, 'dist/play-files.json'), JSON.stringify(PLAY_FILES, null, 2));
console.log(`dist/play.html (${out.length} bytes) + ${PLAY_FILES.length} files`);
