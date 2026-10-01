// 효과음: 소리 파일 없이 WebAudio로 합성한다. 브라우저 정책상 첫 클릭·키 입력 뒤에 켜진다. M으로 끄고 켠다.
// 판정과는 무관한 표시용이다. 거리가 멀수록 작게 들린다.

const VOLUME = 0.45;

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.noiseBuf = null;
  }

  // 사용자 동작(클릭·키) 안에서 불러야 소리가 켜진다
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : VOLUME;
        this.master.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.6);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* 소리를 못 켜는 환경이면 조용히 넘어간다 */ }
  }

  toggle() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : VOLUME;
    return this.muted;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running' && !this.muted;
  }

  // 음 하나: 주파수가 freq → to로 미끄러지고, 짧게 올라갔다 사라진다
  tone({ freq, to = freq, dur = 0.15, type = 'sine', vol = 0.3, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  // 잡음: 필터 주파수가 freq → to로 바뀐다(바람·폭발)
  noise({ dur = 0.2, vol = 0.3, type = 'bandpass', freq = 1200, to = freq, q = 1, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // name: 소리 이름, k: 거리 감쇠(0~1)
  play(name, k = 1) {
    if (!this.ready) return;
    const v = (x) => x * k;
    switch (name) {
      case 'push': // 휙 — 바람이 밀려 나감
        this.noise({ dur: 0.22, vol: v(0.5), freq: 2400, to: 500, q: 0.8 });
        this.tone({ freq: 180, to: 90, dur: 0.12, type: 'triangle', vol: v(0.25) });
        break;
      case 'pull': // 쉬익 — 거꾸로 빨려 듦
        this.noise({ dur: 0.25, vol: v(0.45), freq: 400, to: 2600, q: 0.8 });
        this.tone({ freq: 220, to: 520, dur: 0.2, type: 'sine', vol: v(0.2) });
        break;
      case 'liftStart': // 뿅 — 위로
        this.tone({ freq: 280, to: 640, dur: 0.18, type: 'sine', vol: v(0.3) });
        this.tone({ freq: 560, to: 1280, dur: 0.12, type: 'sine', vol: v(0.08), delay: 0.03 });
        break;
      case 'liftEnd': // 툭 — 아래로
        this.tone({ freq: 520, to: 200, dur: 0.16, type: 'sine', vol: v(0.25) });
        break;
      case 'strain': // 끙 — 무거워서 안 올라감
        this.tone({ freq: 110, to: 95, dur: 0.35, type: 'sawtooth', vol: v(0.12) });
        break;
      case 'fire': // 화르륵 — 발사
        this.noise({ dur: 0.3, vol: v(0.4), type: 'lowpass', freq: 3000, to: 600, q: 0.5 });
        this.tone({ freq: 240, to: 120, dur: 0.18, type: 'sawtooth', vol: v(0.12) });
        break;
      case 'boom': // 펑
        this.noise({ dur: 0.55, vol: v(0.7), type: 'lowpass', freq: 1800, to: 120, q: 0.7 });
        this.tone({ freq: 90, to: 38, dur: 0.45, type: 'sine', vol: v(0.5) });
        break;
      case 'hit': // 뾰잉 — 맞고 납작
        this.tone({ freq: 460, to: 190, dur: 0.16, type: 'triangle', vol: v(0.25) });
        break;
      case 'throw': // 휙 — 단어를 던짐
        this.noise({ dur: 0.16, vol: v(0.3), freq: 1800, to: 700, q: 1.2 });
        this.tone({ freq: 520, to: 760, dur: 0.1, type: 'triangle', vol: v(0.12) });
        break;
      case 'pickup': // 딩동
        this.tone({ freq: 660, dur: 0.12, type: 'sine', vol: v(0.25) });
        this.tone({ freq: 990, dur: 0.18, type: 'sine', vol: v(0.22), delay: 0.08 });
        break;
      case 'give': // 도미솔 — 친구가 던져 준 단어를 받음
        [523, 659, 784].forEach((f, i) => this.tone({ freq: f, dur: 0.14, type: 'triangle', vol: v(0.22), delay: i * 0.07 }));
        break;
      case 'release': // 보호막
        this.tone({ freq: 880, to: 440, dur: 0.3, type: 'sine', vol: v(0.15) });
        break;
      case 'fail': // 부-
        this.tone({ freq: 180, to: 140, dur: 0.16, type: 'square', vol: 0.08 });
        break;
      case 'clear': // 빰빠밤
        [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: i === 3 ? 0.5 : 0.16, type: 'triangle', vol: 0.25, delay: i * 0.12 }));
        break;
      default:
        break;
    }
  }
}
