// 호스트 권한 게임 상태. 토큰 소유권, 줍기·내려놓기, 주문 유효성, 효과, 투사체, 사물 위치, 클리어를 확정한다.
// 자기 시전과 게스트 시전은 같은 handle() 경로로 같은 검증을 받는다. 네트워크와 분리되어 테스트에서 직접 구동한다.
//
// 주문 = 효과 단어 1개 + 수식 단어(보유·장착한 개수만큼 중첩). 대상은 시전 요청의 대상 모드(AIM/SELF/NEAR).
// 효과마다 시전 방식이 다르다: 밀치기·당기기(즉시·한 번) / 들기(시전 종료까지 지속 제어) / 파이어볼(투사체, 실제 명중 시 적용).
// 들기는 여러 명이 한 물체를 같이 들 수 있고(무게를 나눠 든다), 주변 모드로 여러 물체를 한꺼번에 들 수 있다.
//
// 세계의 성질을 단어로(v0.5): 커다란 바위를 마법으로 부수면 <큰>이, 모닥불·샘에서 <당기기>로 뽑아내면 <불>·<물>이 나온다.
// <물>은 추운 곳에서 얼음이 되고, <불>은 얼음을 녹이고 모닥불을 붙인다. 섞는 칸에서 <물> + <불> → <수증기>.
// 생긴 현상도 거둔다: 얼음을 당기면 <차가운>(얼음은 녹는다), 불에 녹은 얼음·물에 꺼진 모닥불에서 피어오른 김을 당기면 <수증기>.
//
// 파일 나눔(모두 Game.prototype에 붙는다):
//   game.js   — 상태·자리·토큰 장부, 입력 분배(handle), 틱(step), 낙하 복구, 목표, 스냅숏
//   spells.js — 효과 단어별 시전(CAST 표)·투사체·폭발·물 튀김·데우기
//   lift.js   — <들기>(지속형·같이 들기)
//   world.js  — 세계의 성질을 단어로(부수기·뽑기·얼음·김·눈밭·섞기)
//   tokens.js — 단어 줍기·던지기·장착

import { LEVEL, SEAT_IDS } from '../shared/level.js';
import { TUNING, modFactor } from '../shared/tuning.js';
import { WORDS, KIND, TRAIT, MOD_IDS, traitsOf } from '../shared/words.js';
import { boxOfBody, overlaps, pointInBox, normalize } from '../shared/geom.js';
import { Physics, bottomOf } from './physics.js';
import { r3, validVec } from './util.js';
import { SpellMethods } from './spells.js';
import { LiftMethods } from './lift.js';
import { WorldMethods } from './world.js';
import { TokenMethods } from './tokens.js';

export class Game {
  // seats: 접속한 플레이어 자리(A~F 중). 게임 중에도 addPlayer/removePlayer로 바뀐다.
  constructor({ level = LEVEL, tuning = TUNING, seats = ['A', 'B'] } = {}) {
    this.level = level;
    this.T = tuning;
    this.statics = level.statics;
    this.physics = new Physics(this.statics, tuning);
    this.events = [];
    this.round = 0;
    this.seats = [];
    this.reset(seats);
  }

  // 위치·소유권·장착·효과·대기시간을 최초 상태로 되돌린다. seats를 주면 그 자리들로 새 판을 시작한다.
  reset(seats = this.seats) {
    this.events = [];
    this.time = 0;
    this.tick = 0;
    this.round += 1;
    this.seats = SEAT_IDS.filter((id) => seats.includes(id));
    this.bodies = [
      ...this.seats.map((pid) => this.makeBody(this.playerDef(pid))),
      ...this.level.bodies.map((d) => this.makeBody(d)),
    ];
    this.tokens = this.level.tokens
      .filter((d) => d.pos || this.seats.includes(d.seat))
      .map((d) => this.makeToken(d, d.seat || null));
    this.players = {};
    for (const pid of this.seats) this.players[pid] = this.makePlayer(pid);
    this.projectiles = [];
    this.nextProjectileId = 1;
    this.nextTokenId = 1; // 세계에서 새로 생긴 단어(부순 바위·뽑아낸 성질·반응)
    this.kindYields = {}; // 생겼다 사라지는 것(얼음·김)에서 이번 판에 거둔 단어 수(종류별)
    this.goal = { timer: 0, cleared: false, inside: {} };
    this.history = [];
    this.recordHistory();
  }

  playerDef(pid) {
    const seat = this.level.seats.find((s) => s.id === pid);
    return { id: pid, kind: 'player', pos: seat.spawn, size: this.level.playerSize, mass: this.level.playerMass };
  }

  makeToken(d, owner) {
    return {
      id: d.id,
      word: d.word,
      owner,
      pos: owner ? null : [...d.pos],
      vy: 0,
      vel: [0, 0], // 던진 단어의 수평 속도
      lastOwner: null, // 마지막으로 던지거나 내려놓은 사람(주고받기 기록용)
      noPickupBy: null, // 이 사람은 noPickupUntil까지 못 줍는다
      noPickupUntil: 0,
      anyPickupAt: 0, // 누구든 이때부터 주울 수 있다
      lastSafe: d.pos ? { ground: this.groundUnder(d.pos), pos: [...d.pos] } : null,
      acquiredAt: 0,
    };
  }

  // 시작 장착: 그 자리의 시작 단어 중 본인이 가진 것. 효과는 한 칸, 수식은 목록.
  makePlayer(pid) {
    const slots = { effect: null, mods: [] };
    for (const d of this.level.tokens) {
      if (d.seat !== pid) continue;
      const t = this.token(d.id);
      if (!t || t.owner !== pid) continue;
      if (WORDS[d.word].kind === KIND.EFFECT) { if (!slots.effect) slots.effect = d.id; } else slots.mods.push(d.id);
    }
    return { id: pid, slots, cooldownUntil: 0, releaseReadyAt: 0, holding: null, aimDir: [0, 0, 1] };
  }

  // 게임 중 참가: 자리의 시작 위치 근처 빈 곳에 나타나고, 그 자리의 시작 단어를 받는다.
  // 시작 단어가 월드에 떨어져 있으면 가져오고, 다른 사람이 가지고 있으면 그대로 둔다(토큰은 늘 하나뿐).
  addPlayer(pid) {
    if (this.players[pid] || !SEAT_IDS.includes(pid)) return false;
    const b = this.makeBody(this.playerDef(pid));
    this.bodies.unshift(b);
    this.placeNear(b, this.playerDef(pid).pos);
    for (const d of this.level.tokens) {
      if (d.seat !== pid) continue;
      const t = this.token(d.id);
      if (!t) this.tokens.push(this.makeToken(d, pid));
      else if (!t.owner) { t.owner = pid; t.pos = null; t.vy = 0; t.vel = [0, 0]; }
    }
    this.players[pid] = this.makePlayer(pid);
    this.seats = SEAT_IDS.filter((id) => this.players[id]);
    this.emit({ k: 'join', id: pid });
    return true;
  }

  // 게임 중 퇴장: 들고 있던 것·들려 있던 상태를 풀고, 가지고 있던 단어는 그 자리에 떨어뜨린다(허공이면 안전 지점).
  removePlayer(pid) {
    const b = this.body(pid);
    if (!b) return false;
    this.endHold(pid, 'left');
    for (const h of [...b.heldBy]) this.releaseItem(h, pid, 'left');
    const inv = this.inventory(pid);
    inv.forEach((t, i) => {
      const a = (i / Math.max(1, inv.length)) * Math.PI * 2;
      const pos = [b.pos[0] + Math.cos(a) * 0.5, bottomOf(b) + 0.3, b.pos[2] + Math.sin(a) * 0.5];
      const onGround = this.surfaceBelow(pos) !== null && bottomOf(b) > this.T.killY + 1;
      t.owner = null;
      t.vy = 0;
      t.lastSafe = b.lastSafe ? { ground: b.lastSafe.ground, pos: [...b.lastSafe.pos] } : t.lastSafe;
      t.pos = onGround ? pos : this.safePoint(b.lastSafe, [0, 0.3, 0], b.spawn);
    });
    this.bodies = this.bodies.filter((x) => x !== b);
    for (const o of this.bodies) if (o.groundId === pid) { o.groundId = null; o.grounded = false; }
    delete this.players[pid];
    this.seats = SEAT_IDS.filter((id) => this.players[id]);
    this.emit({ k: 'leave', id: pid, dropped: inv.map((t) => t.id) });
    return true;
  }

  // 조준 판정용 위치 기록. 클라이언트는 보간 때문에 약간 과거를 보고 있으므로,
  // 시전 요청이 알려 준 "보고 있던 시점"의 위치로 대상을 고른다(조준 표시와 판정 일치).
  recordHistory() {
    this.history.push({ time: this.time, pos: new Map(this.bodies.map((b) => [b.id, [...b.pos]])) });
    while (this.history.length > 2 && this.history[0].time < this.time - this.T.aimHistory) this.history.shift();
  }

  viewAt(vt) {
    if (!Number.isFinite(vt)) return null;
    const t = Math.max(this.time - this.T.aimHistory, Math.min(this.time, vt));
    let a = this.history[0];
    let b = this.history[this.history.length - 1];
    for (const h of this.history) {
      if (h.time <= t) a = h;
      if (h.time >= t) { b = h; break; }
    }
    const k = b.time > a.time ? (t - a.time) / (b.time - a.time) : 1;
    const out = new Map();
    for (const [id, pa] of a.pos) {
      const pb = b.pos.get(id) || pa;
      out.set(id, [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k]);
    }
    return out;
  }

  makeBody(d) {
    const half = [d.size[0] / 2, d.size[1] / 2, d.size[2] / 2];
    return {
      id: d.id,
      kind: d.kind,
      half,
      spawn: [...d.pos],
      pos: [d.pos[0], d.pos[1] + half[1], d.pos[2]],
      mass: d.mass ?? 1,
      // 캐릭터와 이동 사물은 밀리고 들린다. 허수아비(시험용 적)만 피해를 받는다. 고정 지형은 속성이 없다.
      // 바위·모닥불·샘은 제자리에 박혀 있다(traitsOf).
      traits: traitsOf(d.kind),
      fixed: !!traitsOf(d.kind)[TRAIT.FIXED],
      hp: d.kind === 'dummy' ? this.T.dummyHp : d.kind === 'boulder' ? this.T.boulderHp : null,
      baseHalf: [...half], // 부서지며 작아지는 바위의 원래 크기
      scale: 1,
      empty: false, // 모닥불(꺼짐)·샘(빔)
      refillAt: 0,
      yields: 0, // 이번 판에 뽑아낸 단어 수
      warm: 0, // 얼음이 추운 곳 밖에 있던 시간
      ghost: !!traitsOf(d.kind)[TRAIT.GHOST], // 부딪히지 않는 현상(김)
      expireAt: 0,
      downUntil: 0,
      inVel: [0, 0],
      ext: [0, 0],
      extCap: null,
      vy: 0,
      hold: null, // 들기 제어 목표(물리가 사용)
      heldBy: [], // 들고 있는 플레이어들(같이 들기)
      strained: false, // 붙잡혔지만 힘이 모자라 뜨지 못함
      grounded: false,
      groundId: null,
      groundStatic: null,
      lastSafe: { ground: this.groundUnder(d.pos), pos: [...d.pos] },
      immuneUntil: 0,
      debuffUntil: 0,
      speedFactor: 1,
      wish: [0, 0],
      jumpBuffer: 0,
      yaw: 0,
    };
  }

  body(id) {
    return this.bodies.find((b) => b.id === id);
  }

  token(id) {
    return this.tokens.find((t) => t.id === id);
  }

  groundUnder(p) {
    let best = null;
    for (const s of this.statics) {
      if (!s.ground) continue;
      if (p[0] >= s.min[0] && p[0] <= s.max[0] && p[2] >= s.min[2] && p[2] <= s.max[2] && s.max[1] <= p[1] + 0.05) {
        if (!best || s.max[1] > best.max[1]) best = s;
      }
    }
    return best ? best.id : null;
  }

  emit(ev) {
    this.events.push(ev);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  inventory(pid) {
    return this.tokens.filter((t) => t.owner === pid).sort((a, b) => a.acquiredAt - b.acquiredAt);
  }

  // 장착한 효과 단어(실제로 가지고 있을 때만)
  effectWord(pid) {
    const t = this.token(this.players[pid]?.slots.effect);
    return t && t.owner === pid && WORDS[t.word].kind === KIND.EFFECT ? t.word : null;
  }

  // 장착한 수식 개수. 실제로 가진 토큰만 세므로 넘겨준 단어는 곧바로 빠진다(복제 없음).
  modCounts(pid) {
    const counts = Object.fromEntries(MOD_IDS.map((id) => [id, 0]));
    for (const tid of this.players[pid]?.slots.mods || []) {
      const t = this.token(tid);
      if (t && t.owner === pid && WORDS[t.word].kind === KIND.MOD) counts[t.word] += 1;
    }
    return counts;
  }

  liftCapacity(pid) {
    return this.T.liftCapacity * modFactor(this.T, this.modCounts(pid), 'STRONG', 'liftCapacity');
  }

  // 대상 선택이 보는 월드. 위치는 시전자가 보고 있던 시점(view), 보호·들림 상태는 현재 기준이다.
  targetingWorld(view = null) {
    return {
      statics: this.statics,
      bodies: this.bodies.map((b) => ({
        id: b.id,
        kind: b.kind,
        pos: view?.get(b.id) || b.pos,
        half: b.half,
        mass: b.mass,
        traits: b.traits,
        immune: this.time < b.immuneUntil,
        heldBy: [...b.heldBy],
        holding: this.players[b.id] ? this.holdingChain(b.id) : [],
        empty: this.sourceSpent(b),
      })),
    };
  }

  // pid가 직접·간접으로 들고 있는 것들(A가 B를, B가 C를 들면 A는 B·C). 서로·고리로 들어 끝없이 올라가는 것을 막는 데 쓴다.
  holdingChain(pid) {
    const out = new Set();
    const stack = [pid];
    while (stack.length) {
      const items = this.players[stack.pop()]?.holding?.items || [];
      for (const it of items) {
        if (out.has(it.id)) continue;
        out.add(it.id);
        if (this.players[it.id]) stack.push(it.id);
      }
    }
    return [...out];
  }

  // ---------------------------------------------------------------- 입력 처리
  handle(pid, msg) {
    const p = this.players[pid];
    if (!p || !msg || typeof msg !== 'object') return { ok: false };
    switch (msg.t) {
      case 'input': return this.onInput(pid, msg);
      case 'cast': return this.onCast(pid, msg);
      case 'endCast': return this.onEndCast(pid);
      case 'liftEnd': return this.onEndCast(pid); // 이전 이름
      case 'pickup': return this.onPickup(pid);
      case 'drop': return this.onDrop(pid, msg);
      case 'throw': return this.onThrow(pid, msg);
      case 'equip': return this.onEquip(pid, msg);
      case 'mod': return this.onMod(pid, msg);
      case 'loadout': return this.onLoadout(pid, msg);
      case 'release': return this.onRelease(pid);
      case 'react': return this.onReact(pid, msg);
      case 'restart': return this.onRestart(pid);
      case 'rtt': return this.onRtt(pid, msg);
      default: return { ok: false };
    }
  }

  // 왕복 지연 재기: 보낸 사람에게 받은 값을 그대로 돌려준다(내 캐릭터 예측에 쓴다)
  onRtt(pid, msg) {
    const c = Number(msg.c);
    if (!Number.isFinite(c)) return { ok: false };
    this.emit({ k: 'pong', to: pid, c });
    return { ok: true };
  }

  onInput(pid, msg) {
    const b = this.body(pid);
    let [x, z] = Array.isArray(msg.wish) ? msg.wish.map(Number) : [0, 0];
    if (!Number.isFinite(x) || !Number.isFinite(z)) x = z = 0;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    b.wish = [x, z];
    if (msg.jump) b.jumpBuffer = 0.12;
    // 들기 중 시점 방향(카메라 전방). 들린 물체가 이 방향을 따라온다.
    if (validVec(msg.aim) && Math.hypot(...msg.aim) > 1e-6) this.players[pid].aimDir = normalize(msg.aim);
    return { ok: true };
  }

  onRelease(pid) {
    const p = this.players[pid];
    if (this.time < p.releaseReadyAt) return { ok: false };
    const b = this.body(pid);
    // 자신에게 걸린 외부 이동·들림을 풀고, 다른 플레이어의 마법에 잠시 면역 [임시: v0.2 규칙 유지]
    for (const h of [...b.heldBy]) this.releaseItem(h, b.id, 'released-by-target');
    b.ext = [0, 0];
    if (b.vy > 0) b.vy = 0;
    b.immuneUntil = this.time + this.T.releaseImmunity;
    p.releaseReadyAt = this.time + this.T.releaseCooldown;
    this.emit({ k: 'release', by: pid });
    return { ok: true };
  }

  onRestart(pid) {
    this.reset();
    this.emit({ k: 'restart', by: pid });
    return { ok: true };
  }

  // ---------------------------------------------------------------- 시뮬레이션
  step(dt) {
    this.time += dt;
    this.tick += 1;
    for (const b of this.bodies) {
      b.speedFactor = this.time < b.debuffUntil ? this.T.allyDebuffSpeed : 1;
      if (b.downUntil && this.time >= b.downUntil) {
        b.downUntil = 0;
        b.hp = this.T.dummyHp;
        this.emit({ k: 'dummyUp', id: b.id });
      }
    }
    this.updateHolds();
    this.physics.step(this.bodies, dt);
    for (const b of this.bodies) {
      if (b.kind === 'player' && Math.hypot(b.inVel[0], b.inVel[1]) > 0.5 && !this.players[b.id]?.holding) {
        b.yaw = Math.atan2(b.inVel[0], b.inVel[1]);
      }
      if (bottomOf(b) < this.T.killY) this.recoverBody(b);
    }
    this.stepProjectiles(dt);
    this.stepWorld(dt);
    this.stepTokens(dt);
    this.stepAutoPickup();
    this.stepGoal(dt);
    this.recordHistory();
  }

  surfaceBelow(p) {
    let best = null;
    for (const s of this.statics) {
      if (p[0] >= s.min[0] && p[0] <= s.max[0] && p[2] >= s.min[2] && p[2] <= s.max[2] && s.max[1] <= p[1] + 1e-3) {
        if (best === null || s.max[1] > best) best = s.max[1];
      }
    }
    return best;
  }

  // 마지막으로 서 있던 지면 조각의 가장 가까운 안전 지점
  safePoint(lastSafe, lift = [0, 0, 0], fallback) {
    const list = this.level.respawns;
    let cands = lastSafe ? list.filter((r) => r.ground === lastSafe.ground) : [];
    if (!cands.length) cands = list;
    const ref = lastSafe ? lastSafe.pos : fallback || list[0].pos;
    let best = cands[0];
    for (const r of cands) {
      if (Math.hypot(r.pos[0] - ref[0], r.pos[2] - ref[2]) < Math.hypot(best.pos[0] - ref[0], best.pos[2] - ref[2])) best = r;
    }
    return [best.pos[0] + lift[0], best.pos[1] + lift[1], best.pos[2] + lift[2]];
  }

  // 낙하 복구: 진행 중인 효과·들기와 속도를 초기화하고 빈 자리를 찾아 둔다.
  recoverBody(b) {
    const base = this.safePoint(b.lastSafe, [0, 0, 0], b.spawn);
    for (const h of [...b.heldBy]) this.releaseItem(h, b.id, 'fell');
    if (this.players[b.id]?.holding) this.endHold(b.id, 'fell');
    b.ext = [0, 0];
    b.inVel = [0, 0];
    b.vy = 0;
    b.grounded = false;
    b.groundId = null;
    b.groundStatic = null;
    this.placeNear(b, base);
    this.emit({ k: 'recover', id: b.id });
  }

  // base(바닥 좌표) 근처에서 지형·다른 사물과 겹치지 않고 아래에 지면이 있는 자리에 둔다.
  placeNear(b, base) {
    const offsets = [[0, 0]];
    for (const r of [1.2, 2.4, 3.6]) for (let i = 0; i < 8; i++) offsets.push([Math.cos((i / 8) * Math.PI * 2) * r, Math.sin((i / 8) * Math.PI * 2) * r]);
    for (const [ox, oz] of offsets) {
      const pos = [base[0] + ox, base[1] + b.half[1] + 0.02, base[2] + oz];
      const box = boxOfBody({ pos, half: b.half });
      if (this.statics.some((s) => overlaps(box, s))) continue;
      if (this.bodies.some((o) => o !== b && overlaps(box, boxOfBody(o)))) continue;
      const below = this.surfaceBelow([pos[0], pos[1] - b.half[1], pos[2]]);
      if (below === null || below < base[1] - 0.05) continue;
      b.pos = pos;
      return true;
    }
    return false;
  }

  stepGoal(dt) {
    const g = this.level.goal;
    // 짐 + 접속한 모든 플레이어
    const inside = { cargo: pointInBox(this.body('cargo').pos, g) };
    for (const pid of this.seats) inside[pid] = pointInBox(this.body(pid).pos, g);
    this.goal.inside = inside;
    if (this.seats.length && Object.values(inside).every(Boolean)) {
      this.goal.timer += dt;
      if (!this.goal.cleared && this.goal.timer >= this.T.goalHoldTime) {
        this.goal.cleared = true;
        this.emit({ k: 'clear', time: this.time });
      }
    } else {
      this.goal.timer = 0;
    }
  }

  // ---------------------------------------------------------------- 동기화
  snapshot() {
    const t = this.time;
    return {
      t: 's',
      tick: this.tick,
      time: r3(t),
      round: this.round,
      b: this.bodies.map((b) => {
        const o = {
          id: b.id,
          p: b.pos.map(r3),
          y: r3(b.yaw),
          i: r3(Math.max(0, b.immuneUntil - t)), // 보호
          d: r3(Math.max(0, b.debuffUntil - t)), // 디버프(그을림)
          g: b.grounded ? 1 : 0,
        };
        if (b.heldBy.length) o.h = [...b.heldBy]; // 들고 있는 사람들
        if (b.strained) o.hv = 1; // 붙잡혔지만 힘이 모자라 뜨지 못함
        if (b.hp !== null) { o.hp = r3(b.hp); o.dn = b.downUntil ? 1 : 0; }
        if (b.scale !== 1) o.sc = r3(b.scale); // 부서지며 작아진 바위
        if (b.traits[TRAIT.SOURCE]) o.st = this.sourceSpent(b) ? 0 : 1; // 모닥불 타는 중·샘 참
        if (b.kind === 'campfire' && !b.empty) o.lit = 1;
        return o;
      }),
      pr: this.projectiles.map((pr) => ({ id: pr.id, p: pr.pos.map(r3), r: r3(pr.radius), o: pr.owner, w: pr.word })),
      k: this.tokens.map((tk) => ({ id: tk.id, w: tk.word, o: tk.owner, p: tk.pos ? tk.pos.map(r3) : null })),
      p: Object.fromEntries(this.seats.map((pid) => {
        const pl = this.players[pid];
        return [pid, {
          e: pl.slots.effect,
          m: [...pl.slots.mods],
          mc: this.modCounts(pid),
          cd: r3(Math.max(0, pl.cooldownUntil - t)),
          inv: this.inventory(pid).map((tk) => tk.id),
          hold: pl.holding ? pl.holding.items.map((it) => it.id) : null, // 들고 있는 물체들
        }];
      })),
      g: { t: r3(this.goal.timer), c: this.goal.cleared, in: this.goal.inside },
    };
  }
}

Object.assign(Game.prototype, SpellMethods, LiftMethods, WorldMethods, TokenMethods);
