// 혼자 해보기: 호스트 판정 코드(server/game.js)를 이 브라우저 안에서 그대로 돌린다.
// 네트워크 연결과 같은 모양(send/close + 메시지 콜백)이라 나머지 클라이언트 코드는 그대로 쓴다.
// 한 사람이 A와 B를 번갈아 조작한다(switchTo).
import { Game } from '../server/game.js';
import { TUNING } from '../shared/tuning.js';

export class LocalHost {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.game = new Game();
    this.active = 'A';
    const dt = 1 / TUNING.tickRate;
    const snapEvery = Math.max(1, Math.round(TUNING.tickRate / TUNING.snapshotRate));
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000); // 탭이 잠시 멈췄다 돌아와도 한꺼번에 몰아서 돌리지 않는다
      last = now;
      while (acc >= dt) {
        acc -= dt;
        this.game.step(dt);
        for (const ev of this.game.drainEvents()) {
          const { to, ...rest } = ev;
          this.onMessage({ t: 'ev', ...rest });
        }
        if (this.game.tick % snapEvery === 0) this.onMessage(this.game.snapshot());
      }
    }, 1000 / TUNING.tickRate / 2);
    setTimeout(() => {
      this.onMessage({ t: 'welcome', you: 'A', solo: true });
      this.onMessage({ t: 'lobby', state: 'playing', seats: { A: true, B: true } });
      this.onMessage({ t: 'start', round: this.game.round });
    }, 0);
  }

  send(msg) {
    this.game.handle(this.active, msg);
  }

  // 조작 캐릭터를 바꾼다. 이전 캐릭터는 그 자리에 멈춘다.
  switchTo(pid) {
    this.game.handle(this.active, { t: 'input', wish: [0, 0] });
    this.active = pid;
  }

  close() {
    clearInterval(this.timer);
  }
}
