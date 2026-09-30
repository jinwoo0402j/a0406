// 호스트 프로세스: 정적 파일(클라이언트) 제공 + WebSocket 방(정확히 2명) + 권한 시뮬레이션 루프.
// 호스트 PC에서 실행하고, 두 플레이어는 브라우저로 접속한다(같은 PC의 두 창 또는 같은 로컬 네트워크).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, PLAYER_IDS } from './game.js';
import { TUNING } from '../shared/tuning.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const ROUTES = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/build')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/client/', path.join(ROOT, 'client')],
];

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = null;
  if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(ROOT, 'client/index.html');
  for (const [prefix, dir] of ROUTES) {
    if (url.pathname.startsWith(prefix)) {
      const f = path.normalize(path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (f.startsWith(dir + path.sep)) file = f;
    }
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function startServer({ port = 8080, host = '0.0.0.0', log = console.log } = {}) {
  const game = new Game();
  const seats = Object.fromEntries(PLAYER_IDS.map((id) => [id, null]));
  let state = 'lobby';

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg) => { for (const ws of Object.values(seats)) send(ws, msg); };
  const lobbyInfo = () => ({
    t: 'lobby',
    state,
    seats: Object.fromEntries(PLAYER_IDS.map((id) => [id, !!seats[id]])),
  });

  wss.on('connection', (ws) => {
    const seat = PLAYER_IDS.find((id) => !seats[id]);
    if (!seat) {
      send(ws, { t: 'full' });
      ws.close(4000, 'full');
      return;
    }
    seats[seat] = ws;
    ws.missed = 0;
    ws.on('pong', () => { ws.missed = 0; });
    log(`[host] 플레이어 ${seat} 접속`);
    send(ws, { t: 'welcome', you: seat, addresses: lanAddresses(), port: server.address().port });
    broadcast(lobbyInfo());

    if (PLAYER_IDS.every((id) => seats[id])) {
      game.reset();
      state = 'playing';
      broadcast({ t: 'start', round: game.round });
      broadcast(lobbyInfo());
      log('[host] 2명 접속 — 게임 시작');
    }

    ws.on('message', (data) => {
      ws.missed = 0;
      if (state !== 'playing') return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      game.handle(seat, msg);
    });

    ws.on('close', () => {
      if (seats[seat] !== ws) return;
      seats[seat] = null;
      log(`[host] 플레이어 ${seat} 연결 끊김`);
      if (state === 'playing') {
        // 호스트 이전은 하지 않는다. 남은 사람은 안내 후 로비로 돌아간다.
        state = 'lobby';
        game.reset();
        broadcast({ t: 'peerLeft', who: seat });
      }
      broadcast(lobbyInfo());
    });
  });

  // 연결 확인: 응답이 연속으로 없을 때만 정리한다(브라우저가 잠시 멈춰도 끊지 않도록 여유를 둔다).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missed === undefined) continue;
      if (ws.missed >= 4) { log('[host] 응답 없는 연결 정리'); ws.terminate(); continue; }
      ws.missed += 1;
      ws.ping();
    }
  }, 5000);

  // 고정 시간 간격 시뮬레이션
  const dt = 1 / TUNING.tickRate;
  const snapEvery = Math.max(1, Math.round(TUNING.tickRate / TUNING.snapshotRate));
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    let steps = 0;
    while (acc >= dt && steps < 5) {
      acc -= dt;
      steps += 1;
      if (state !== 'playing') continue;
      game.step(dt);
      for (const ev of game.drainEvents()) {
        const { to, ...rest } = ev;
        const msg = { t: 'ev', ...rest };
        if (to) send(seats[to], msg);
        else broadcast(msg);
      }
      if (game.tick % snapEvery === 0) broadcast(game.snapshot());
    }
    if (steps === 5) acc = 0;
  }, 1000 / TUNING.tickRate / 2);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        game,
        close: () => new Promise((r) => {
          clearInterval(loop);
          clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const { port: p } = await startServer({ port });
  console.log('');
  console.log('  단어로 만드는 마법 — 호스트 실행 중');
  console.log(`  이 PC에서:          http://localhost:${p}`);
  for (const a of lanAddresses()) console.log(`  같은 네트워크에서:  http://${a}:${p}`);
  console.log('  두 사람이 접속하면 게임이 시작됩니다. 종료: Ctrl+C');
  console.log('');
}
