// 세계의 성질을 단어로(v0.5): 부서지는 사물(바위 → <큰>), <당기기>로 성질 뽑기(모닥불·샘·얼음·김),
// 마법으로 생겼다 사라지는 것(얼음·김), 환경 구역(눈밭), 단어끼리의 반응(섞기).
// Game.prototype에 붙는 메서드 묶음이다(this = Game).

import { inZone } from '../shared/level.js';
import { TRAIT, reactionFor } from '../shared/words.js';
import { REASON } from '../shared/targeting.js';
import { bottomOf } from './physics.js';
import { r3 } from './util.js';

export const WorldMethods = {
  // ---------------------------------------------------------------- 세계의 성질을 단어로
  // 세계에서 새 단어가 생긴다. from 자리에서 toward(시전자) 쪽으로 살짝 튀어 나와 땅에 떨어진다.
  spawnWord(word, from, toward = null, why = '') {
    const T = this.T;
    let dir = toward ? [toward[0] - from[0], toward[2] - from[2]] : [0, 0];
    const l = Math.hypot(dir[0], dir[1]);
    dir = l > 1e-3 ? [dir[0] / l, dir[1] / l] : [0, 0];
    const t = this.makeToken({ id: `n${this.nextTokenId++}`, word, pos: [...from] }, null);
    t.vel = [dir[0] * T.dropToss, dir[1] * T.dropToss];
    t.vy = T.dropToss;
    if (!t.lastSafe?.ground) t.lastSafe = { ground: this.groundUnder([from[0], 0, from[2]]) || 'floor', pos: [from[0], 0, from[2]] };
    this.tokens.push(t);
    this.emit({ k: 'wordBorn', token: t.id, word, why, pos: from.map(r3) });
    return t;
  },

  // 커다란 바위 깎기: 맞을 때마다 단단함이 줄고, 단계가 내려갈 때마다 작아지며 <큰>이 떨어진다. 다 부서지면 사라진다.
  chip(b, amount, by) {
    const T = this.T;
    if (!(amount > 0) || b.hp <= 0) return;
    const per = T.boulderHp / T.boulderStages;
    const before = Math.ceil(b.hp / per - 1e-9);
    b.hp = Math.max(0, b.hp - amount);
    const after = Math.ceil(b.hp / per - 1e-9);
    const caster = this.body(by);
    const words = [];
    for (let s = before; s > after; s--) {
      const top = [b.pos[0], b.pos[1] + b.half[1] + 0.2, b.pos[2]];
      words.push(this.spawnWord('BIG', top, caster?.pos, 'chip').id); // 바위의 "큼"이 떨어져 나온다
    }
    this.emit({ k: 'chip', id: b.id, by, hp: r3(b.hp), stage: after, words });
    if (after <= 0) {
      this.emit({ k: 'shatter', id: b.id, by, pos: b.pos.map(r3) });
      this.deactivate(b);
      return;
    }
    if (after < before) {
      // 작아진다(바닥은 그대로)
      const bottom = bottomOf(b);
      b.scale = 0.4 + 0.6 * (after / T.boulderStages);
      b.half = b.baseHalf.map((h) => h * b.scale);
      b.pos[1] = bottom + b.half[1];
    }
  },

  // 모닥불·샘이 다 쓰였나(비었거나 이번 판에 내줄 만큼 다 내줌)
  // 생겼다 사라지는 것(얼음·김)은 하나하나가 아니라 종류별로 센다
  sourceSpent(b) {
    if (!b.traits?.[TRAIT.SOURCE]) return false;
    if (this.isReserve(b)) return (this.kindYields[b.kind] || 0) >= this.T.sourceYields;
    return b.empty || b.yields >= this.T.sourceYields;
  },

  isReserve(b) {
    return (this.level.reserve || []).some((d) => d.id === b.id);
  },

  // <당기기>로 성질을 뽑아낸다: 모닥불 → <불>(불이 꺼짐), 샘 → <물>(샘이 빔). 조금 지나면 다시 찬다.
  extract(b, by) {
    if (this.sourceSpent(b)) return false;
    const word = b.traits[TRAIT.SOURCE];
    const top = [b.pos[0], b.pos[1] + b.half[1] + 0.3, b.pos[2]];
    const t = this.spawnWord(word, top, this.body(by)?.pos, 'extract');
    this.emit({ k: 'extract', id: b.id, by, word, token: t.id });
    if (this.isReserve(b)) {
      // 얼음은 차가움을 빼앗겨 녹고, 김은 거둬져 사라진다
      this.kindYields[b.kind] = (this.kindYields[b.kind] || 0) + 1;
      if (b.kind === 'ice') this.melt(b, by);
      else this.vanish(b);
      return true;
    }
    b.empty = true;
    b.yields += 1;
    b.refillAt = this.time + this.T.sourceRefill;
    return true;
  },

  // 마법으로 생기는 사물 꺼내기(얼음). 다 쓰고 있으면 가장 오래된 것을 녹여 다시 쓴다.
  // free: 겹침·바닥을 따지지 않고 그 자리에 띄운다(김)
  activate(kind, base, by, free = false) {
    const defs = (this.level.reserve || []).filter((d) => d.kind === kind);
    if (!defs.length) return null;
    let def = defs.find((d) => !this.body(d.id));
    if (!def) {
      const oldest = this.bodies.filter((b) => b.kind === kind).sort((a, c) => a.bornAt - c.bornAt)[0];
      if (kind === 'ice') this.melt(oldest, by);
      else this.vanish(oldest);
      def = defs.find((d) => d.id === oldest.id);
    }
    const b = this.makeBody({ ...def, pos: base });
    b.bornAt = this.time + this.tick * 1e-9;
    this.bodies.push(b);
    if (free) { b.pos = [base[0], base[1] + b.half[1], base[2]]; return b; }
    if (!this.placeNear(b, base)) { this.bodies = this.bodies.filter((x) => x !== b); return null; }
    b.lastSafe = { ground: this.groundUnder([b.pos[0], bottomOf(b) + 0.01, b.pos[2]]) || b.lastSafe.ground, pos: [b.pos[0], bottomOf(b), b.pos[2]] };
    return b;
  },

  // 추운 곳에 닿은 물이 언다: 닿은 곳 아래 땅에 얼음 덩이가 생긴다
  freezeAt(point, by) {
    const floor = this.surfaceBelow([point[0], point[1] + 0.01, point[2]]);
    if (floor === null) return null;
    const b = this.activate('ice', [point[0], floor, point[2]], by);
    if (b) this.emit({ k: 'freeze', id: b.id, by, pos: b.pos.map(r3) });
    return b;
  },

  // 얼음이 녹는다. 열(<불>·파이어볼)에 녹으면 그 자리에 김이 피어오른다
  melt(b, by = null, steam = false) {
    const pos = [...b.pos];
    this.emit({ k: 'melt', id: b.id, by, pos: pos.map(r3), steam });
    this.deactivate(b);
    if (steam) this.puffSteam([pos[0], pos[1] - b.half[1] + 0.2, pos[2]], by);
  },

  // 김이 피어오른다(잠깐 떠 있다가 흩어진다). 그 안에 <당기기>로 거두면 <수증기>
  puffSteam(base, by = null) {
    const c = this.activate('steamcloud', base, by, true);
    if (!c) return null;
    c.expireAt = this.time + this.T.steamLife;
    this.emit({ k: 'steam', id: c.id, by, pos: c.pos.map(r3) });
    return c;
  },

  vanish(b) {
    this.emit({ k: 'vanish', id: b.id, pos: b.pos.map(r3) });
    this.deactivate(b);
  },

  // 사물을 세계에서 뺀다(녹은 얼음, 다 부서진 바위). 들고 있던 것·위에 서 있던 것을 정리한다.
  deactivate(b) {
    for (const h of [...b.heldBy]) this.releaseItem(h, b.id, 'gone');
    this.bodies = this.bodies.filter((x) => x !== b);
    for (const o of this.bodies) if (o.groundId === b.id) { o.groundId = null; o.grounded = false; }
  },

  // 섞기(가방의 섞는 칸): 가진 단어들의 종류·개수가 반응과 맞으면 그 단어들이 새 단어 하나가 된다.
  onReact(pid, msg) {
    const ids = Array.isArray(msg.tokens) ? msg.tokens : [];
    const fail = () => {
      this.emit({ k: 'reactFail', to: pid, reason: REASON.BAD_MIX });
      return { ok: false, reason: REASON.BAD_MIX };
    };
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length) return fail();
    const toks = ids.map((id) => this.token(id));
    if (toks.some((t) => !t || t.owner !== pid)) return fail();
    const r = reactionFor(toks.map((t) => t.word));
    if (!r) return fail();
    for (const t of toks) this.unequipToken(pid, t.id);
    this.tokens = this.tokens.filter((t) => !ids.includes(t.id));
    const made = this.makeToken({ id: `n${this.nextTokenId++}`, word: r.makes }, pid);
    this.tokens.push(made);
    const equipped = this.receiveToken(pid, made);
    this.emit({ k: 'react', by: pid, used: toks.map((t) => t.word), word: r.makes, token: made.id, equipped });
    return { ok: true, token: made.id, word: r.makes };
  },

  // 모닥불·샘이 다시 차고, 추운 곳 밖의 얼음은 녹는다
  stepWorld(dt) {
    for (const b of [...this.bodies]) {
      if (b.traits[TRAIT.SOURCE] && b.empty && b.refillAt && this.time >= b.refillAt) {
        b.empty = false;
        b.refillAt = 0;
        this.emit({ k: 'refill', id: b.id });
      }
      if (b.kind === 'steamcloud' && this.time >= b.expireAt) { this.vanish(b); continue; }
      if (b.kind === 'ice') {
        b.warm = inZone(b.pos, 'cold', this.level) ? 0 : b.warm + dt;
        if (b.warm >= this.T.iceMelt) this.melt(b);
      }
    }
  },
};
