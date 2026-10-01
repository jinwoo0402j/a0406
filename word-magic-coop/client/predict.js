// 내 캐릭터 예측(표시 전용). 판정은 여전히 호스트가 한다.
// 서버의 최신 상태(내 몸)에서 시작해, 아직 서버에 반영되지 않았을 내 입력(왕복 지연 동안)과
// 스냅숏이 도착한 뒤 흐른 시간만큼을 서버와 같은 이동 규칙(server/physics.js)으로 미리 움직여 그린다.
// → 키를 누르면 바로 움직이고, 1인칭 화면이 늦게 따라오지 않는다.
// 새 스냅숏이 와서 예측이 바뀌면 그 차이는 잠깐에 걸쳐 부드럽게 흡수한다(순간이동처럼 튀지 않게).

import { Physics } from '../server/physics.js';
import { TUNING } from '../shared/tuning.js';

const STEP = 1 / 60;
const MAX_SPAN = 0.3; // 이보다 길게는 내다보지 않는다(오래 끊기면 서버 상태를 그대로)
const SMOOTH = 10; // 보정 흡수 속도(1/초)
const SNAP = 1.5; // 이보다 크게 어긋나면(낙하 복구 등) 바로 맞춘다

function approach2(v, target, maxDelta) {
  const dx = target[0] - v[0];
  const dz = target[1] - v[1];
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) return [target[0], target[1]];
  return [v[0] + (dx / d) * maxDelta, v[1] + (dz / d) * maxDelta];
}

export class SelfPredictor {
  constructor(statics, tuning = TUNING) {
    this.T = tuning;
    this.phys = new Physics(statics, tuning);
    this.rtt = 0; // 왕복 지연(초). 같은 탭의 호스트면 거의 0
    this.reset();
  }

  reset() {
    this.base = null; // 서버가 알려 준 내 몸 { p, v, g, slow, time(호스트), at(이 컴퓨터) }
    this.inputs = []; // 내가 보낸 입력 기록 { t, wish, jump }
    this.offset = [0, 0, 0];
    this.lastBase = null;
    this.lastSource = null;
  }

  // 스냅숏 도착: me = 스냅숏의 내 몸 { p, g, d }, hostTime = 스냅숏 시각, at = 도착 시각(이 컴퓨터)
  onSnapshot(me, hostTime, at) {
    const prev = this.base;
    let v = [0, 0, 0];
    const dtH = prev ? hostTime - prev.time : 0;
    // 낙하 복구·재시작처럼 순간이동한 경우는 속도로 보지 않는다(보간과 같은 2.5m 기준)
    const jump = prev && Math.hypot(...me.p.map((x, i) => x - prev.p[i])) > 2.5;
    if (prev && !jump && dtH > 1e-4 && dtH < 0.25) v = me.p.map((x, i) => (x - prev.p[i]) / dtH);
    // 그래도 말이 안 되게 빠르면 줄인다(수평: 밀림 상한 + 걷기, 수직: 최대 낙하·들기 속도)
    const hMax = this.T.pushMaxSpeed + this.T.walkSpeed;
    const h = Math.hypot(v[0], v[2]);
    if (h > hMax) { v[0] *= hMax / h; v[2] *= hMax / h; }
    v[1] = Math.max(-this.T.terminalFall, Math.min(this.T.terminalFall, v[1]));
    this.base = { p: [...me.p], v, g: !!me.g, slow: me.d > 0, time: hostTime, at };
  }

  // 입력을 보낼 때 기록(같은 시계: performance.now()/1000)
  input(t, wish, jump = false) {
    this.inputs.push({ t, wish: [...wish], jump });
    while (this.inputs.length > 2 && this.inputs[1].t < t - 2) this.inputs.shift();
  }

  wishAt(t) {
    let w = [0, 0];
    for (const e of this.inputs) {
      if (e.t > t) break;
      w = e.wish;
    }
    return w;
  }

  // base에서 now까지 미리 움직여 본다. colliders: 부딪칠 다른 몸들 [{ pos, half }]
  simulate(base, now, colliders, half) {
    const T = this.T;
    const span = Math.min(MAX_SPAN, Math.max(0, now - base.at) + this.rtt);
    const body = { id: '__self', pos: [...base.p], half };
    let [vx, vy, vz] = base.v;
    let g = base.g;
    if (g && vy < 0) vy = 0;
    const speed = T.walkSpeed * (base.slow ? T.allyDebuffSpeed : 1);
    let jumpBuf = 0;
    let t = now - span;
    while (t < now - 1e-6) {
      const dt = Math.min(STEP, now - t);
      for (const e of this.inputs) if (e.jump && e.t >= t && e.t < t + dt) jumpBuf = 0.12;
      const hs = Math.hypot(vx, vz);
      if (hs > speed + 0.5) {
        // 마법으로 밀리는 중: 서버처럼 마찰로 줄어든다(입력은 그 위에 더해지지만 짧은 동안이라 무시)
        const ns = Math.max(0, hs - (g ? T.extGroundFriction : T.extAirDrag) * dt);
        vx *= ns / hs;
        vz *= ns / hs;
      } else {
        const wish = this.wishAt(t);
        [vx, vz] = approach2([vx, vz], [wish[0] * speed, wish[1] * speed], (g ? T.groundAccel : T.airAccel) * dt);
      }
      if (jumpBuf > 0) {
        if (g) { vy = T.jumpSpeed; g = false; jumpBuf = 0; } else jumpBuf -= dt;
      }
      vy = Math.max(-T.terminalFall, vy - T.gravity * dt);
      if (this.phys.moveAxis(body, colliders, 0, vx * dt).hit) vx = 0;
      if (this.phys.moveAxis(body, colliders, 2, vz * dt).hit) vz = 0;
      const dy = vy * dt;
      const r = this.phys.moveAxis(body, colliders, 1, dy);
      if (dy > 0) {
        if (r.moved < dy - 1e-6) vy = 0;
        g = false;
      } else if (r.hit) {
        g = true;
        vy = 0;
      } else {
        g = false;
      }
      t += dt;
    }
    return { p: body.pos, v: [vx, vy, vz], g };
  }

  // 이번 프레임에 그릴 내 위치.
  // fallback: 예측하지 않을 때(친구에게 들려 있는 등) 쓸 보간 위치. 출처가 바뀌어도 튀지 않게 이어 준다.
  present(now, dt, { colliders, half, fallback, enabled }) {
    let raw;
    let v = null;
    let g = null;
    const source = enabled && this.base ? 'predict' : 'fallback';
    if (source === 'predict') {
      const r = this.simulate(this.base, now, colliders, half);
      if (this.lastSource === 'predict' && this.lastBase && this.lastBase !== this.base) {
        // 새 스냅숏으로 기준이 바뀜: 이전 기준으로 본 지금 위치와의 차이를 보정값으로 옮긴다
        const old = this.simulate(this.lastBase, now, colliders, half);
        for (let i = 0; i < 3; i++) this.offset[i] += old.p[i] - r.p[i];
      }
      raw = r.p;
      v = r.v;
      g = r.g;
      this.lastBase = this.base;
    } else {
      raw = fallback;
    }
    if (this.lastSource && this.lastSource !== source && this.lastShown) {
      for (let i = 0; i < 3; i++) this.offset[i] = this.lastShown[i] - raw[i];
    }
    this.lastSource = source;
    const k = Math.exp(-dt * SMOOTH);
    for (let i = 0; i < 3; i++) this.offset[i] *= k;
    if (Math.hypot(...this.offset) > SNAP) this.offset = [0, 0, 0];
    const shown = raw.map((x, i) => x + this.offset[i]);
    this.lastShown = shown;
    return { p: shown, v, g, predicted: source === 'predict' };
  }
}
