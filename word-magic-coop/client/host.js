// 브라우저 안의 호스트: 판정 코드(server/game.js)를 이 탭에서 돌린다.
// - 혼자 해보기: 한 사람이 A·B를 번갈아 조작한다(switchTo).
// - 방 만들기(P2P): 이 탭의 사람이 A, 원격 연결(attachRemote)이 B. 원격도 같은 handle() 검증을 거친다.
// 로컬 쪽은 WebSocket 연결과 같은 모양(send/close + 메시지 콜백)이라 나머지 클라이언트 코드는 그대로 쓴다.
import { Game } from '../server/game.js';
import { TUNING } from '../shared/tuning.js';

const REMOTE_TIMEOUT_MS = 8000; // 원격에서 이만큼 아무 메시지도 없으면 끊긴 것으로 본다

export class HostSession {
  // onMessage: 로컬 화면으로 보낼 메시지 콜백. solo: 혼자 해보기 여부.
  constructor(onMessage, { solo = false } = {}) {
    this.onMessage = onMessage;
    this.solo = solo;
    this.game = new Game();
    this.active = 'A'; // 로컬 사람이 조작하는 자리
    this.remote = null; // { send(obj), close(), lastSeen }
    this.playing = false;
    const dt = 1 / TUNING.tickRate;
    const snapEvery = Math.max(1, Math.round(TUNING.tickRate / TUNING.snapshotRate));
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000); // 탭이 잠시 멈췄다 돌아와도 한꺼번에 몰아서 돌리지 않는다
      last = now;
      if (this.remote && now - this.remote.lastSeen > REMOTE_TIMEOUT_MS) this.dropRemote();
      while (acc >= dt) {
        acc -= dt;
        if (!this.playing) continue;
        this.game.step(dt);
        for (const ev of this.game.drainEvents()) {
          const { to, ...rest } = ev;
          const msg = { t: 'ev', ...rest };
          if (!to || to === this.active || this.solo) this.onMessage(msg);
          if (this.remote && (!to || to === 'B')) this.remote.send(msg);
        }
        if (this.game.tick % snapEvery === 0) {
          const snap = this.game.snapshot();
          this.onMessage(snap);
          this.remote?.send(snap);
        }
      }
    }, 1000 / TUNING.tickRate / 2);
    setTimeout(() => {
      this.onMessage({ t: 'welcome', you: 'A', solo, p2p: !solo });
      if (solo) this.start();
      else this.broadcastLobby();
    }, 0);
  }

  seats() {
    return { A: true, B: this.solo || !!this.remote };
  }

  broadcastLobby() {
    const msg = { t: 'lobby', state: this.playing ? 'playing' : 'lobby', seats: this.seats() };
    this.onMessage(msg);
    this.remote?.send(msg);
  }

  start() {
    this.game.reset();
    this.playing = true;
    const msg = { t: 'start', round: this.game.round };
    this.onMessage(msg);
    this.remote?.send(msg);
    this.broadcastLobby();
  }

  // 로컬 사람의 요청
  send(msg) {
    if (this.playing) this.game.handle(this.active, msg);
  }

  // 혼자 해보기: 조작 캐릭터를 바꾼다. 이전 캐릭터는 그 자리에 멈춘다.
  switchTo(pid) {
    if (!this.solo) return;
    this.game.handle(this.active, { t: 'input', wish: [0, 0] });
    this.active = pid;
  }

  // 원격 참가자 연결. conn: { send(obj), close() }. 반환값의 receive(msg)/closed()를 연결 이벤트에 이어 준다.
  attachRemote(conn) {
    if (this.solo || this.remote) {
      conn.send({ t: 'full' });
      setTimeout(() => conn.close(), 2500); // 상대가 안내를 받을 시간을 둔 뒤 닫는다
      return { receive() {}, closed() {} };
    }
    const remote = { ...conn, lastSeen: performance.now() };
    this.remote = remote;
    remote.send({ t: 'welcome', you: 'B', p2p: true });
    this.start();
    return {
      receive: (msg) => {
        if (this.remote !== remote) return;
        remote.lastSeen = performance.now();
        if (msg && msg.t === 'ping') return;
        if (this.playing) this.game.handle('B', msg);
      },
      closed: () => { if (this.remote === remote) this.dropRemote(); },
    };
  }

  // 원격이 끊기면 호스트 이전 없이 로비로 돌아가고, 같은 방에서 새 참가자를 기다린다.
  dropRemote() {
    const r = this.remote;
    if (!r) return;
    this.remote = null;
    try { r.close(); } catch { /* 이미 닫힘 */ }
    this.playing = false;
    this.game.reset();
    this.onMessage({ t: 'peerLeft', who: 'B' });
    this.broadcastLobby();
  }

  close() {
    clearInterval(this.timer);
    try { this.remote?.close(); } catch { /* 이미 닫힘 */ }
    this.remote = null;
  }
}
