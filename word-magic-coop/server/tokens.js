// 단어 토큰: 줍기·던지기·내려놓기, 장착(손 + 수식 칸), 월드에 놓인 단어의 움직임과 자동 줍기.
// Game.prototype에 붙는 메서드 묶음이다(this = Game).

import { WORDS, KIND, MOD_IDS } from '../shared/words.js';
import { normalize, segmentBlocked } from '../shared/geom.js';
import { bottomOf } from './physics.js';
import { validVec } from './util.js';

export const TokenMethods = {
  // E 줍기(예전 방식, 테스트·보조용). 지금은 몸에 닿으면 자동으로 줍는다(stepAutoPickup).
  onPickup(pid) {
    const b = this.body(pid);
    let best = null;
    for (const t of this.tokens) {
      if (t.owner || !t.pos) continue;
      const dh = Math.hypot(t.pos[0] - b.pos[0], t.pos[2] - b.pos[2]);
      const dv = Math.abs(t.pos[1] - bottomOf(b));
      if (dh <= this.T.pickupRadius && dv <= 2.5 && (!best || dh < best.dh)) best = { t, dh };
    }
    if (!best) {
      this.emit({ k: 'pickupFail', to: pid, reason: '가까이에 주울 단어가 없어요' });
      return { ok: false };
    }
    this.collectToken(pid, best.t);
    return { ok: true, token: best.t.id };
  },

  // 월드의 단어를 갖는다. 다른 사람이 던진(내려놓은) 것이면 주고받기로 기록한다.
  collectToken(pid, t) {
    t.pos = null;
    t.vy = 0;
    t.vel = [0, 0];
    const from = t.lastOwner && t.lastOwner !== pid ? t.lastOwner : null;
    t.lastOwner = null;
    const equipped = this.receiveToken(pid, t);
    this.emit({ k: 'pickup', by: pid, token: t.id, word: t.word, equipped, from });
  },

  // 단어를 갖게 한다(마인크래프트처럼 가방으로). 손에 든 효과가 없을 때 효과 단어만 바로 손에 든다.
  // 수식은 자동으로 붙지 않는다: 가방 창(E)에서 수식 칸에 넣어야 주문에 붙는다.
  receiveToken(pid, t) {
    t.owner = pid;
    t.acquiredAt = this.time + this.tick * 1e-9;
    const p = this.players[pid];
    if (WORDS[t.word].kind === KIND.EFFECT && !this.effectWord(pid)) { p.slots.effect = t.id; return true; }
    return false;
  },

  // 장착 한꺼번에 정하기(가방 창): effect = 손에 든 효과 단어(선택한 핫바 칸), mods = 수식 칸의 단어들.
  // 모두 본인 소유여야 하고, 수식 칸은 modSlots개까지.
  onLoadout(pid, msg) {
    const own = (id) => {
      const t = this.token(id);
      return t && t.owner === pid ? t : null;
    };
    let effect = null;
    if (msg.effect != null) {
      const t = own(msg.effect);
      if (!t || WORDS[t.word].kind !== KIND.EFFECT) return { ok: false };
      effect = t.id;
    }
    const mods = [];
    for (const id of Array.isArray(msg.mods) ? msg.mods : []) {
      const t = own(id);
      if (!t || WORDS[t.word].kind !== KIND.MOD || mods.includes(id)) return { ok: false };
      mods.push(id);
    }
    if (mods.length > this.T.modSlots) return { ok: false };
    const p = this.players[pid];
    p.slots.effect = effect;
    p.slots.mods = mods;
    return { ok: true };
  },

  // 장착 칸에서 뺀다(던지거나 내려놓을 때)
  unequipToken(pid, tokenId) {
    const p = this.players[pid];
    if (p.slots.effect === tokenId) p.slots.effect = null;
    p.slots.mods = p.slots.mods.filter((id) => id !== tokenId);
  },

  // 손에서 단어를 놓아 월드로: 몸 앞에서 vel(수평)·vy(위)로 날아간다. 놓은 사람은 잠깐 다시 못 줍는다.
  releaseToken(pid, t, fwd, speed, up) {
    const T = this.T;
    const b = this.body(pid);
    this.unequipToken(pid, t.id);
    let pos = [b.pos[0] + fwd[0] * (b.half[0] + 0.15), b.pos[1] + 0.2, b.pos[2] + fwd[2] * (b.half[2] + 0.15)];
    if (segmentBlocked(b.pos, pos, this.statics)) pos = [b.pos[0], b.pos[1] + 0.2, b.pos[2]];
    t.owner = null;
    t.pos = pos;
    t.vel = [fwd[0] * speed, fwd[2] * speed];
    t.vy = up;
    t.lastOwner = pid;
    t.noPickupBy = pid;
    t.noPickupUntil = this.time + T.pickupDelayOwn;
    t.anyPickupAt = this.time + T.pickupDelayOther;
    // 떨어지면 놓은 사람이 마지막으로 서 있던 지면 기준으로 복구한다
    if (b.lastSafe) t.lastSafe = { ground: b.lastSafe.ground, pos: [...b.lastSafe.pos] };
  },

  // 던지기(Q, 마인크래프트식): 고른 단어 하나를 시선 방향으로 던진다. 친구가 걸어가 닿으면 주워진다.
  onThrow(pid, msg) {
    const t = this.token(msg.token);
    if (!t || t.owner !== pid) return { ok: false };
    const b = this.body(pid);
    let fwd = validVec(msg.dir) ? normalize([msg.dir[0], 0, msg.dir[2]]) : [0, 0, 0];
    if (!fwd[0] && !fwd[2]) fwd = [Math.sin(b.yaw), 0, Math.cos(b.yaw)];
    this.releaseToken(pid, t, fwd, this.T.throwSpeed, this.T.throwUp);
    this.emit({ k: 'throw', by: pid, token: t.id, word: t.word });
    return { ok: true };
  },

  // 내려놓기(편집창): 바로 앞에 살짝 떨군다
  onDrop(pid, msg) {
    const t = this.token(msg.token);
    if (!t || t.owner !== pid) return { ok: false };
    const b = this.body(pid);
    this.releaseToken(pid, t, [Math.sin(b.yaw), 0, Math.cos(b.yaw)], 2.5, 1); // 줍는 거리(0.9m)보다 조금 멀리
    this.emit({ k: 'drop', by: pid, token: t.id, word: t.word });
    return { ok: true };
  },

  // 효과 칸 장착·해제
  onEquip(pid, msg) {
    const p = this.players[pid];
    if (msg.slot !== 'effect') return { ok: false };
    if (msg.token == null) { p.slots.effect = null; return { ok: true }; }
    const t = this.token(msg.token);
    if (!t || t.owner !== pid || WORDS[t.word].kind !== KIND.EFFECT) return { ok: false };
    p.slots.effect = t.id;
    return { ok: true };
  },

  // 수식 개수 선택: 그 단어를 0개부터 가진 개수까지 붙인다. 가진 것보다 많이 붙일 수 없다.
  onMod(pid, msg) {
    const p = this.players[pid];
    if (!MOD_IDS.includes(msg.word)) return { ok: false };
    const owned = this.inventory(pid).filter((t) => t.word === msg.word).map((t) => t.id);
    const n = Math.max(0, Math.min(owned.length, Math.floor(Number(msg.count) || 0)));
    const others = p.slots.mods.filter((id) => this.token(id)?.word !== msg.word);
    const m = Math.min(n, this.T.modSlots - others.length);
    p.slots.mods = [...others, ...owned.slice(0, m)];
    return { ok: true, count: m };
  },

  // 월드의 단어: 던진 단어는 수평으로 날아가다 지형에 막히면 서고, 땅에서는 미끄러지다 멈춘다.
  stepTokens(dt) {
    for (const t of this.tokens) {
      if (t.owner || !t.pos) continue;
      if (t.vel[0] || t.vel[1]) {
        const np = [t.pos[0] + t.vel[0] * dt, t.pos[1], t.pos[2] + t.vel[1] * dt];
        const m = 0.08;
        const blocked = this.statics.some((s) => np[0] > s.min[0] - m && np[0] < s.max[0] + m && np[2] > s.min[2] - m && np[2] < s.max[2] + m
          && np[1] > s.min[1] && np[1] < s.max[1] - 1e-3);
        if (blocked) t.vel = [0, 0];
        else { t.pos[0] = np[0]; t.pos[2] = np[2]; }
      }
      const floorY = this.surfaceBelow(t.pos);
      if (floorY !== null && t.pos[1] <= floorY + 1e-4 && t.vy <= 0) {
        t.pos[1] = floorY;
        t.vy = 0;
        const sp = Math.hypot(t.vel[0], t.vel[1]);
        if (sp > 0) {
          const ns = Math.max(0, sp - this.T.tokenFriction * dt);
          t.vel = [t.vel[0] * (ns / sp), t.vel[1] * (ns / sp)];
        }
        const g = this.groundUnder(t.pos);
        if (g) t.lastSafe = { ground: g, pos: [...t.pos] };
        continue;
      }
      t.vy = Math.max(-this.T.terminalFall, t.vy - this.T.gravity * dt);
      const ny = t.pos[1] + t.vy * dt;
      if (floorY !== null && ny <= floorY) { t.pos[1] = floorY; t.vy = 0; }
      else t.pos[1] = ny;
      if (t.pos[1] < this.T.killY) {
        t.pos = this.safePoint(t.lastSafe, [0, 0.3, 0], null);
        t.vy = 0;
        t.vel = [0, 0];
        this.emit({ k: 'tokenRecover', token: t.id, word: t.word });
      }
    }
  },

  // 자동 줍기: 땅에 있는 단어에 몸이 닿으면 가장 가까운 사람이 줍는다(놓은 사람은 잠깐 뒤에).
  stepAutoPickup() {
    const T = this.T;
    for (const t of this.tokens) {
      if (t.owner || !t.pos || this.time < t.anyPickupAt) continue;
      let best = null;
      for (const pid of this.seats) {
        if (pid === t.noPickupBy && this.time < t.noPickupUntil) continue;
        const b = this.body(pid);
        const dh = Math.hypot(t.pos[0] - b.pos[0], t.pos[2] - b.pos[2]);
        const bot = bottomOf(b);
        if (dh > T.autoPickupRadius || t.pos[1] < bot - 0.3 || t.pos[1] > bot + b.half[1] * 2 + 0.3) continue;
        if (!best || dh < best.dh) best = { pid, dh };
      }
      if (best) this.collectToken(best.pid, t);
    }
  },
};
