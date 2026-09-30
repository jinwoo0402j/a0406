// 브라우저 안의 호스트: 판정 코드(server/game.js)를 이 탭에서 돌린다.
// - 혼자 해보기: 한 사람이 A·B를 번갈아 조작한다(switchTo).
// - 방 만들기(P2P): 이 탭의 사람이 A, 원격 참가자는 B~F(최대 6명). 원격도 같은 handle() 검증을 거친다.
//   2명이 되면 시작하고, 이후 들어온 사람은 진행 중인 판에 참가한다. 혼자 남으면 로비로 돌아간다.
// 로컬 쪽은 WebSocket 연결과 같은 모양(send/close + 메시지 콜백)이라 나머지 클라이언트 코드는 그대로 쓴다.
import { Game } from '../server/game.js';
import { TUNING } from '../shared/tuning.js';
import { SEAT_IDS } from '../shared/level.js';

const REMOTE_TIMEOUT_MS = 8000; // 원격에서 이만큼 아무 메시지도 없으면 끊긴 것으로 본다
const LOCAL = 'A';

export class HostSession {
  // onMessage: 로컬 화면으로 보낼 메시지 콜백. solo: 혼자 해보기 여부.
  constructor(onMessage, { solo = false } = {}) {
    this.onMessage = onMessage;
    this.solo = solo;
    this.game = new Game({ seats: [] });
    this.active = LOCAL; // 로컬 사람이 조작하는 자리
    this.remotes = new Map(); // seat → { send(obj), close(), lastSeen }
    this.playing = false;
    const dt = 1 / TUNING.tickRate;
    const snapEvery = Math.max(1, Math.round(TUNING.tickRate / TUNING.snapshotRate));
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000); // 탭이 잠시 멈췄다 돌아와도 한꺼번에 몰아서 돌리지 않는다
      last = now;
      for (const [seat, r] of this.remotes) if (now - r.lastSeen > REMOTE_TIMEOUT_MS) this.dropRemote(seat);
      while (acc >= dt) {
        acc -= dt;
        if (!this.playing) continue;
        this.game.step(dt);
        for (const ev of this.game.drainEvents()) {
          const { to, ...rest } = ev;
          const msg = { t: 'ev', ...rest };
          if (!to || to === this.active || this.solo) this.onMessage(msg);
          for (const [seat, r] of this.remotes) if (!to || to === seat) r.send(msg);
        }
        if (this.game.tick % snapEvery === 0) this.broadcast(this.game.snapshot());
      }
    }, 1000 / TUNING.tickRate / 2);
    setTimeout(() => {
      this.onMessage({ t: 'welcome', you: LOCAL, solo, p2p: !solo });
      if (solo) this.start();
      else this.broadcastLobby();
    }, 0);
  }

  broadcast(msg) {
    this.onMessage(msg);
    for (const r of this.remotes.values()) r.send(msg);
  }

  seatsTaken() {
    if (this.solo) return ['A', 'B'];
    return SEAT_IDS.filter((id) => id === LOCAL || this.remotes.has(id));
  }

  broadcastLobby() {
    const taken = this.seatsTaken();
    this.broadcast({
      t: 'lobby',
      state: this.playing ? 'playing' : 'lobby',
      seats: Object.fromEntries(SEAT_IDS.map((id) => [id, taken.includes(id)])),
    });
  }

  start() {
    this.game.reset(this.seatsTaken());
    this.playing = true;
    // 시작 메시지에도 자리를 담아, 안내(welcome) 하나가 빠져도 자기 자리를 알 수 있게 한다.
    this.onMessage({ t: 'start', round: this.game.round, you: this.active });
    for (const [seat, r] of this.remotes) r.send({ t: 'start', round: this.game.round, you: seat });
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
    // 이미 자리가 있는 사람이 다시 연결해 오면 새 자리를 주지 않고 연결만 바꾼다(유령 자리 방지).
    const again = conn.key && [...this.remotes].find(([, r]) => r.key === conn.key);
    if (again) {
      const [seat, old] = again;
      try { old.close(); } catch { /* 이미 닫힘 */ }
      return this.bindRemote(seat, conn, { rejoin: true });
    }
    const seat = this.solo ? null : SEAT_IDS.find((id) => id !== LOCAL && !this.remotes.has(id));
    if (!seat) {
      conn.send({ t: 'full' });
      setTimeout(() => conn.close(), 2500); // 상대가 안내를 받을 시간을 둔 뒤 닫는다
      return { receive() {}, closed() {}, hello: () => conn.send({ t: 'full' }) };
    }
    return this.bindRemote(seat, conn, { rejoin: false });
  }

  bindRemote(seat, conn, { rejoin }) {
    const remote = { ...conn, lastSeen: performance.now() };
    this.remotes.set(seat, remote);
    remote.send({ t: 'welcome', you: seat, p2p: true });
    if (rejoin && this.playing) {
      remote.send({ t: 'start', round: this.game.round, you: seat }); // 캐릭터와 단어는 그대로 이어서
      this.broadcastLobby();
    } else if (!this.playing) {
      this.start(); // 두 번째 사람이 들어오면 시작
    } else {
      this.game.addPlayer(seat); // 진행 중인 판에 참가
      remote.send({ t: 'start', round: this.game.round, you: seat });
      this.broadcastLobby();
    }
    return {
      // 참가자가 안내를 못 받았다고 다시 hello를 보내면 안내와 시작 메시지를 다시 보낸다.
      hello: () => {
        if (this.remotes.get(seat) !== remote) return;
        remote.lastSeen = performance.now();
        remote.send({ t: 'welcome', you: seat, p2p: true });
        if (this.playing) remote.send({ t: 'start', round: this.game.round, you: seat });
      },
      receive: (msg) => {
        if (this.remotes.get(seat) !== remote) return;
        remote.lastSeen = performance.now();
        if (msg && msg.t === 'ping') return;
        if (this.playing) this.game.handle(seat, msg);
      },
      closed: () => { if (this.remotes.get(seat) === remote) this.dropRemote(seat); },
    };
  }

  // 원격이 끊기면 그 사람만 빠지고(단어는 그 자리에 떨어짐) 게임은 계속된다.
  // 방장만 남으면 로비로 돌아가 같은 방에서 새 참가자를 기다린다. 호스트 이전은 없다.
  dropRemote(seat) {
    const r = this.remotes.get(seat);
    if (!r) return;
    this.remotes.delete(seat);
    try { r.close(); } catch { /* 이미 닫힘 */ }
    if (!this.playing) return;
    if (this.remotes.size === 0) {
      this.playing = false;
      this.game.reset([]);
      this.onMessage({ t: 'peerLeft', who: seat });
    } else {
      this.game.removePlayer(seat);
    }
    this.broadcastLobby();
  }

  close() {
    clearInterval(this.timer);
    for (const r of this.remotes.values()) { try { r.close(); } catch { /* 이미 닫힘 */ } }
    this.remotes.clear();
  }
}
