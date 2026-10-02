// 호스트 권한 게임 상태 (v0.3). 토큰 소유권, 줍기·내려놓기, 주문 유효성, 효과, 투사체, 사물 위치, 클리어를 확정한다.
// 자기 시전과 게스트 시전은 같은 handle() 경로로 같은 검증을 받는다. 네트워크와 분리되어 테스트에서 직접 구동한다.
//
// 주문 = 효과 단어 1개 + 수식 단어(보유·장착한 개수만큼 중첩). 대상은 시전 요청의 대상 모드(AIM/SELF/NEAR).
// 효과마다 시전 방식이 다르다: 밀치기·당기기(즉시·한 번) / 들기(시전 종료까지 지속 제어) / 파이어볼(투사체, 실제 명중 시 적용).
// 들기는 여러 명이 한 물체를 같이 들 수 있고(무게를 나눠 든다), 주변 모드로 여러 물체를 한꺼번에 들 수 있다.
//
// 세계의 성질을 단어로(v0.5): 커다란 바위를 마법으로 부수면 <큰>이, 모닥불·샘에서 <당기기>로 뽑아내면 <불>·<물>이 나온다.
// <물>은 추운 곳에서 얼음이 되고, <불>은 얼음을 녹이고 모닥불을 붙인다. 섞는 칸에서 <물> + <불> → <수증기>.
// 생긴 현상도 거둔다: 얼음을 당기면 <차가운>(얼음은 녹는다), 불에 녹은 얼음·물에 꺼진 모닥불에서 피어오른 김을 당기면 <수증기>.

import { LEVEL, SEAT_IDS, inZone } from '../shared/level.js';
import { TUNING, modFactor } from '../shared/tuning.js';
import { WORDS, KIND, TRAIT, MOD_IDS, MODE_ORDER, traitsOf, reactionFor } from '../shared/words.js';
import { resolveTargets, REASON, modeUnsupported, liftMaxBottom, liftLoads, liftShare, liftStrain } from '../shared/targeting.js';
import { boxOfBody, overlaps, pointInBox, dist, normalize, segmentBlocked, rayBox } from '../shared/geom.js';
import { Physics, bottomOf, clampExt } from './physics.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const validVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

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

  // 조준 정보 검증(원점은 시전자 근처의 카메라여야 한다). view: 시전자가 보고 있던 시점의 위치
  parseAim(pid, msg) {
    const view = this.viewAt(Number(msg.vt));
    const casterPos = view?.get(pid) || this.body(pid).pos;
    let aim = null;
    if (validVec(msg.origin) && validVec(msg.dir) && Math.hypot(...msg.dir) > 1e-6) {
      if (dist(msg.origin, casterPos) <= this.T.maxCameraOffset) aim = { origin: msg.origin, dir: normalize(msg.dir) };
    }
    return { aim, view };
  }

  onCast(pid, msg) {
    const p = this.players[pid];
    const fail = (reason) => {
      this.emit({ k: 'castFail', to: pid, by: pid, reason });
      return { ok: false, reason };
    };
    // 1) 장착한 효과 단어 확인 → 2) 대상 모드가 이 효과에 정의되어 있는지 → 3) 대기시간
    const effect = this.effectWord(pid);
    if (!effect) return fail(REASON.NO_EFFECT);
    const mode = MODE_ORDER.includes(msg.mode) ? msg.mode : 'AIM';
    if (!WORDS[effect].modes.includes(mode)) return fail(modeUnsupported(effect, mode));
    if (p.holding) return fail(REASON.SUSTAINING); // 지속형 마법을 유지하는 동안에는 새로 시전하지 않는다 [임시]
    if (this.time < p.cooldownUntil - 1e-9) return fail(REASON.COOLDOWN);
    const { aim, view } = this.parseAim(pid, msg);
    if (mode === 'AIM' && !aim) return fail(REASON.BAD_AIM);
    if (aim) p.aimDir = aim.dir;
    const mods = this.modCounts(pid);
    if (effect === 'PUSH') return this.castPush(pid, mode, aim, view, mods, fail);
    if (effect === 'PULL') return this.castPull(pid, mode, aim, view, mods, fail);
    if (effect === 'FIREBALL') {
      if (mode === 'SELF') return this.castSelfBlast(pid, aim, mods);
      if (mode === 'NEAR') return this.castFireballRing(pid, aim, mods);
      return this.castFireball(pid, aim, mods);
    }
    if (effect === 'LIFT') return this.startLift(pid, mode, aim, view, mods, fail);
    if (effect === 'WATER') {
      if (mode === 'SELF') return this.castSelfWash(pid, mods);
      if (mode === 'NEAR') return this.castFireballRing(pid, aim, mods, 'WATER');
      return this.castFireball(pid, aim, mods, 'WATER');
    }
    if (effect === 'FIRE') return this.castFire(pid, mode, aim, view, mods, fail);
    if (effect === 'STEAM') return this.castSteam(pid, mode, aim, view, mods, fail);
    return fail(REASON.NO_EFFECT);
  }

  faceAim(pid, aim) {
    const b = this.body(pid);
    if (aim && (aim.dir[0] || aim.dir[2])) b.yaw = Math.atan2(aim.dir[0], aim.dir[2]);
  }

  // <밀치기>: 즉시 발동, 한 번 적용. 방향은 시전자 → 대상(자기 자신이면 카메라 수평 전방).
  castPush(pid, mode, aim, view, mods, fail) {
    const T = this.T;
    const reach = modFactor(T, mods, 'BIG', 'pushReach');
    const force = modFactor(T, mods, 'STRONG', 'pushForce');
    const res = resolveTargets(mode, 'PUSH', this.targetingWorld(view), pid, aim, { range: T.aimedMaxRange * reach, radius: T.nearbyRadius * reach }, T);
    if (!res.applicable.length) return fail(res.reason);
    const caster = this.body(pid);
    const camFwd = aim ? normalize([aim.dir[0], 0, aim.dir[2]]) : [Math.sin(caster.yaw), 0, Math.cos(caster.yaw)];
    for (const id of res.applicable) {
      const b = this.body(id);
      if (!b) continue;
      if (b.traits[TRAIT.BREAKABLE]) { this.chip(b, T.boulderPushHit * force, pid); continue; } // 부서지는 것은 깎인다
      let dir = [b.pos[0] - caster.pos[0], b.pos[2] - caster.pos[2]];
      const l = Math.hypot(dir[0], dir[1]);
      if (b.id === pid || l < T.pushSelfEpsilon) dir = [camFwd[0], camFwd[2]];
      else dir = [dir[0] / l, dir[1] / l];
      b.ext[0] += dir[0] * T.pushDeltaV * force;
      b.ext[1] += dir[1] * T.pushDeltaV * force;
      b.extCap = T.pushMaxSpeed * force;
      clampExt(b, b.extCap);
    }
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'PUSH', mode, mods, targets: res.applicable });
    return { ok: true, targets: res.applicable };
  }

  // <당기기>: 즉시 발동, 한 번 적용. 대상을 시전자 앞까지 끌어온다(지면 마찰로 멈출 거리만큼의 속도).
  // 조준 모드에서 지형을 당기면 반대로 시전자가 그 지점으로 끌려간다(수평으로만) [제안안]
  castPull(pid, mode, aim, view, mods, fail) {
    const T = this.T;
    const reach = modFactor(T, mods, 'BIG', 'pullReach');
    const cap = T.pullMaxSpeed * modFactor(T, mods, 'STRONG', 'pullForce');
    const res = resolveTargets(mode, 'PULL', this.targetingWorld(view), pid, aim, { range: T.aimedMaxRange * reach, radius: T.nearbyRadius * reach, ghosts: true }, T);
    if (!res.applicable.length) return fail(res.reason);
    const caster = this.body(pid);
    // 남은 거리 d를 지면 마찰로 멈추며 지나가는 속도 √(2·마찰·d), 상한 cap
    const speedFor = (d) => Math.min(cap, Math.sqrt(2 * T.extGroundFriction * Math.max(0, d)));
    const kick = (b, dir, v) => {
      b.ext[0] += dir[0] * v;
      b.ext[1] += dir[1] * v;
      b.extCap = Math.max(cap, T.pushMaxSpeed);
      clampExt(b, b.extCap);
    };
    const sel = res.selection.selected[0];
    let targets;
    if (mode === 'AIM' && sel?.type === 'static') {
      const hp = res.selection.hitPoint;
      const d = [hp[0] - caster.pos[0], hp[2] - caster.pos[2]];
      const l = Math.hypot(d[0], d[1]);
      if (l < 0.3) return fail(REASON.NO_TARGET);
      kick(caster, [d[0] / l, d[1] / l], speedFor(l - caster.half[0] - 0.1));
      targets = [pid];
      this.emit({ k: 'cast', by: pid, effect: 'PULL', mode, mods, targets, anchor: hp.map(r3) });
    } else {
      const force = modFactor(T, mods, 'STRONG', 'pullForce');
      for (const id of res.applicable) {
        const b = this.body(id);
        if (!b) continue;
        // 모닥불·샘·얼음·김: 성질을 단어로 뽑아낸다. 다 뽑아낸 얼음은 보통 물체처럼 끌려온다
        if (b.traits[TRAIT.SOURCE] && (this.extract(b, pid) || !b.traits[TRAIT.MOVABLE])) continue;
        if (b.traits[TRAIT.BREAKABLE]) { this.chip(b, T.boulderPushHit * force, pid); continue; }
        const d = [caster.pos[0] - b.pos[0], caster.pos[2] - b.pos[2]];
        const l = Math.hypot(d[0], d[1]);
        if (l < 1e-3) continue;
        kick(b, [d[0] / l, d[1] / l], speedFor(l - T.pullStopDistance));
      }
      targets = res.applicable;
      this.emit({ k: 'cast', by: pid, effect: 'PULL', mode, mods, targets });
    }
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    return { ok: true, targets };
  }

  // 투사체 하나 생성(수식 반영). word: FIREBALL(폭발) / WATER(물 튀김)
  spawnFireball(pid, spawn, dir, mods, word = 'FIREBALL') {
    const T = this.T;
    const water = word === 'WATER';
    const proj = {
      id: this.nextProjectileId++,
      word,
      owner: pid,
      pos: spawn,
      vel: dir.map((v) => v * (water ? T.waterSpeed : T.fireballSpeed)),
      radius: water ? T.waterRadius * modFactor(T, mods, 'BIG', 'waterRadius') : T.fireballRadius * modFactor(T, mods, 'BIG', 'fireballRadius'),
      blast: water ? T.waterSplashRadius * modFactor(T, mods, 'BIG', 'waterRadius') : T.fireballBlastRadius * modFactor(T, mods, 'BIG', 'blastRadius'),
      damage: water ? 0 : T.fireballDamage * modFactor(T, mods, 'STRONG', 'fireballDamage'),
      push: water ? T.waterPush * modFactor(T, mods, 'STRONG', 'waterPush') : T.fireballKnockback,
      cold: water && mods.COLD > 0, // <차가운> + <물>: 어디에 닿아도 언다
      life: water ? T.waterLife : T.fireballLife,
    };
    this.projectiles.push(proj);
    return proj;
  }

  // 시전자 앞 수평 방향 fwd로 발사 위치. 벽에 막히면 몸 중심에서.
  fireballSpawnPoint(caster, fwd) {
    const T = this.T;
    const spawn = [caster.pos[0] + fwd[0] * T.fireballSpawnForward, caster.pos[1] + 0.25, caster.pos[2] + fwd[2] * T.fireballSpawnForward];
    return segmentBlocked(caster.pos, spawn, this.statics) ? [...caster.pos] : spawn;
  }

  // <파이어볼>(조준): 시전자 앞에서 조준점으로 투사체를 쏜다. 효과는 날아가서 실제로 맞았을 때 적용한다.
  castFireball(pid, aim, mods, word = 'FIREBALL') {
    const T = this.T;
    const caster = this.body(pid);
    let fwd = normalize([aim.dir[0], 0, aim.dir[2]]);
    if (!fwd[0] && !fwd[2]) fwd = [Math.sin(caster.yaw), 0, Math.cos(caster.yaw)];
    const spawn = this.fireballSpawnPoint(caster, fwd);
    // 조준점: 카메라 조준선이 처음 닿는 곳(없으면 먼 지점)
    let t = T.aimPointRange;
    for (const s of this.statics) { const h = rayBox(aim.origin, aim.dir, s, t); if (h !== null && h < t) t = h; }
    for (const b of this.bodies) {
      if (b.id === pid || b.ghost) continue;
      const h = rayBox(aim.origin, aim.dir, boxOfBody(b), t);
      if (h !== null && h < t) t = h;
    }
    const aimPoint = aim.origin.map((o, i) => o + aim.dir[i] * t);
    let dir = normalize(aimPoint.map((v, i) => v - spawn[i]));
    if (dir[0] * aim.dir[0] + dir[1] * aim.dir[1] + dir[2] * aim.dir[2] < 0.2) dir = aim.dir;
    const proj = this.spawnFireball(pid, spawn, dir, mods, word);
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: word, mode: 'AIM', mods, projectile: proj.id, projectiles: [proj.id], radius: r3(proj.radius), targets: [] });
    return { ok: true, projectile: proj.id };
  }

  // <파이어볼>(주변): 시전자 둘레 사방으로 수평 발사. 각 투사체는 실제로 맞은 대상에만 적용한다 [제안안]
  castFireballRing(pid, aim, mods, word = 'FIREBALL') {
    const T = this.T;
    const caster = this.body(pid);
    const yaw = aim && (aim.dir[0] || aim.dir[2]) ? Math.atan2(aim.dir[0], aim.dir[2]) : caster.yaw;
    const ids = [];
    let radius = 0;
    for (let i = 0; i < T.fireballNearCount; i++) {
      const a = yaw + (i / T.fireballNearCount) * Math.PI * 2;
      const fwd = [Math.sin(a), 0, Math.cos(a)];
      const proj = this.spawnFireball(pid, this.fireballSpawnPoint(caster, fwd), fwd, mods, word);
      ids.push(proj.id);
      radius = proj.radius;
    }
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: word, mode: 'NEAR', mods, projectile: ids[0], projectiles: ids, radius: r3(radius), targets: [] });
    return { ok: true, projectiles: ids };
  }

  // <파이어볼>(본인): 발밑 폭발. 시전자는 피해·디버프 없이 땅에 있을 때만 튀어 오르고, 주변은 폭발을 맞는다 [제안안]
  castSelfBlast(pid, aim, mods) {
    const T = this.T;
    const caster = this.body(pid);
    const fwd = [Math.sin(caster.yaw), 0, Math.cos(caster.yaw)];
    const point = [caster.pos[0], bottomOf(caster) + 0.2, caster.pos[2]];
    const pr = {
      id: this.nextProjectileId++,
      word: 'FIREBALL',
      owner: pid,
      vel: fwd,
      push: T.fireballKnockback,
      blast: T.fireballBlastRadius * modFactor(T, mods, 'BIG', 'blastRadius'),
      damage: T.fireballDamage * modFactor(T, mods, 'STRONG', 'fireballDamage'),
    };
    const launched = caster.grounded && !caster.heldBy.length;
    if (launched) { caster.vy = Math.max(caster.vy, T.fireballSelfLaunch); caster.grounded = false; }
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'FIREBALL', mode: 'SELF', mods, targets: [pid], launched });
    this.explode(pr, point, { type: 'self' });
    return { ok: true, launched };
  }

  // <물>(본인): 머리 위로 물을 끼얹는다. 그을림을 씻어 낸다. 추운 곳이면 발밑에 얼음이 생긴다 [제안안]
  castSelfWash(pid, mods) {
    const caster = this.body(pid);
    const washed = caster.debuffUntil > this.time;
    caster.debuffUntil = 0;
    this.players[pid].cooldownUntil = this.time + this.T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'WATER', mode: 'SELF', mods, targets: [pid], washed });
    const feet = [caster.pos[0], bottomOf(caster) + 0.05, caster.pos[2]];
    if (inZone(feet, 'cold', this.level) || mods.COLD > 0) this.freezeAt(feet, pid);
    return { ok: true, washed };
  }

  // <불>: 즉시. 조준한 것(주변 모드면 둘레의 것들)을 데운다.
  // 적은 피해, 친구는 그을림, 얼음은 녹고, 꺼진 모닥불은 다시 붙는다 [제안안]
  castFire(pid, mode, aim, view, mods, fail) {
    const T = this.T;
    const reach = modFactor(T, mods, 'BIG', 'fireReach');
    const res = resolveTargets(mode, 'FIRE', this.targetingWorld(view), pid, aim, { range: T.aimedMaxRange * reach, radius: T.nearbyRadius * reach }, T);
    if (!res.applicable.length) return fail(res.reason);
    const dmg = T.fireDamage * modFactor(T, mods, 'STRONG', 'fireDamage');
    const hits = [];
    for (const id of res.applicable) {
      const b = this.body(id);
      if (b) hits.push({ id, effects: this.heat(b, dmg, pid) });
    }
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'FIRE', mode, mods, targets: res.applicable, hits });
    return { ok: true, targets: res.applicable, hits };
  }

  // 데우기(<불>·파이어볼 폭발 공통). 반환: 일어난 일 목록
  heat(b, dmg, by) {
    const effects = [];
    if (b.kind === 'ice') { this.melt(b, by, true); effects.push('melt'); return effects; }
    if (b.kind === 'campfire' && b.empty) {
      b.empty = false;
      b.refillAt = 0;
      this.emit({ k: 'ignite', id: b.id, by });
      effects.push('ignite');
      return effects;
    }
    if (b.traits[TRAIT.DAMAGEABLE]) {
      if (!b.downUntil && dmg > 0) {
        b.hp = Math.max(0, b.hp - dmg);
        effects.push('damage');
        if (b.hp <= 0) {
          b.downUntil = this.time + this.T.dummyRespawn;
          this.emit({ k: 'dummyDown', id: b.id });
        }
      }
    } else if (b.kind === 'player') {
      b.debuffUntil = this.time + this.T.allyDebuffDuration; // 아군: 피해 대신 그을림
      effects.push('debuff');
    }
    return effects;
  }

  // <수증기>: 즉시. 뜨거운 김이 솟아 대상을 위로 띄운다(본인 모드는 없다: 혼자 높은 곳에 오르지 않게) [제안안]
  castSteam(pid, mode, aim, view, mods, fail) {
    const T = this.T;
    const reach = modFactor(T, mods, 'BIG', 'steamReach');
    const res = resolveTargets(mode, 'STEAM', this.targetingWorld(view), pid, aim, { range: T.aimedMaxRange * reach, radius: T.nearbyRadius * reach }, T);
    if (!res.applicable.length) return fail(res.reason);
    const up = T.steamLift * modFactor(T, mods, 'STRONG', 'steamLift');
    for (const id of res.applicable) {
      const b = this.body(id);
      if (!b || b.hold) continue; // 들려 있는 것은 드는 사람이 정한 높이를 따른다
      b.vy = Math.max(b.vy, up);
      b.grounded = false;
    }
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'STEAM', mode, mods, targets: res.applicable });
    return { ok: true, targets: res.applicable };
  }

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
  }

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
  }

  // 모닥불·샘이 다 쓰였나(비었거나 이번 판에 내줄 만큼 다 내줌)
  // 생겼다 사라지는 것(얼음·김)은 하나하나가 아니라 종류별로 센다
  sourceSpent(b) {
    if (!b.traits?.[TRAIT.SOURCE]) return false;
    if (this.isReserve(b)) return (this.kindYields[b.kind] || 0) >= this.T.sourceYields;
    return b.empty || b.yields >= this.T.sourceYields;
  }

  isReserve(b) {
    return (this.level.reserve || []).some((d) => d.id === b.id);
  }

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
  }

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
  }

  // 추운 곳에 닿은 물이 언다: 닿은 곳 아래 땅에 얼음 덩이가 생긴다
  freezeAt(point, by) {
    const floor = this.surfaceBelow([point[0], point[1] + 0.01, point[2]]);
    if (floor === null) return null;
    const b = this.activate('ice', [point[0], floor, point[2]], by);
    if (b) this.emit({ k: 'freeze', id: b.id, by, pos: b.pos.map(r3) });
    return b;
  }

  // 얼음이 녹는다. 열(<불>·파이어볼)에 녹으면 그 자리에 김이 피어오른다
  melt(b, by = null, steam = false) {
    const pos = [...b.pos];
    this.emit({ k: 'melt', id: b.id, by, pos: pos.map(r3), steam });
    this.deactivate(b);
    if (steam) this.puffSteam([pos[0], pos[1] - b.half[1] + 0.2, pos[2]], by);
  }

  // 김이 피어오른다(잠깐 떠 있다가 흩어진다). 그 안에 <당기기>로 거두면 <수증기>
  puffSteam(base, by = null) {
    const c = this.activate('steamcloud', base, by, true);
    if (!c) return null;
    c.expireAt = this.time + this.T.steamLife;
    this.emit({ k: 'steam', id: c.id, by, pos: c.pos.map(r3) });
    return c;
  }

  vanish(b) {
    this.emit({ k: 'vanish', id: b.id, pos: b.pos.map(r3) });
    this.deactivate(b);
  }

  // 사물을 세계에서 뺀다(녹은 얼음, 다 부서진 바위). 들고 있던 것·위에 서 있던 것을 정리한다.
  deactivate(b) {
    for (const h of [...b.heldBy]) this.releaseItem(h, b.id, 'gone');
    this.bodies = this.bodies.filter((x) => x !== b);
    for (const o of this.bodies) if (o.groundId === b.id) { o.groundId = null; o.grounded = false; }
  }

  // 물 튀김: 친구는 그을림이 씻기고, 움직이는 것은 살짝 밀리고, 모닥불은 꺼지고, 빈 샘은 찬다.
  // 추운 곳에 닿으면 그 자리에 얼음이 생긴다.
  splash(pr, point, hit) {
    const hits = [];
    for (const b of [...this.bodies]) {
      if (b.id === pr.owner || b.ghost) continue;
      const box = boxOfBody(b);
      const dx = Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]);
      const dy = Math.max(box.min[1] - point[1], 0, point[1] - box.max[1]);
      const dz = Math.max(box.min[2] - point[2], 0, point[2] - box.max[2]);
      const direct = hit.type === 'body' && hit.id === b.id;
      if (!direct && Math.hypot(dx, dy, dz) > pr.blast) continue;
      if (!direct && segmentBlocked(point, b.pos, this.statics)) continue;
      if (b.kind === 'player' && this.time < b.immuneUntil) continue;
      const effects = [];
      if (b.kind === 'player' && b.debuffUntil > this.time) { b.debuffUntil = 0; effects.push('wash'); }
      if (b.kind === 'campfire' && !b.empty) {
        b.empty = true;
        b.refillAt = this.time + this.T.sourceRefill;
        effects.push('douse');
        this.puffSteam([b.pos[0], b.pos[1] + b.half[1] + 0.1, b.pos[2]], pr.owner); // 치익 — 김이 오른다
      }
      if (b.kind === 'well' && b.empty) { b.empty = false; b.refillAt = 0; effects.push('fill'); }
      if (b.traits[TRAIT.MOVABLE] && pr.push > 0) {
        let d = [b.pos[0] - point[0], b.pos[2] - point[2]];
        const l = Math.hypot(d[0], d[1]);
        d = l > 1e-3 ? [d[0] / l, d[1] / l] : normalize([pr.vel[0], 0, pr.vel[2]]).filter((_, i) => i !== 1);
        b.ext[0] += d[0] * pr.push;
        b.ext[1] += d[1] * pr.push;
        clampExt(b, b.extCap ?? this.T.pushMaxSpeed);
        effects.push('push');
      }
      if (effects.length) hits.push({ id: b.id, effects, direct });
    }
    this.emit({ k: 'splash', id: pr.id, by: pr.owner, pos: point.map(r3), radius: r3(pr.blast), hits });
    if (inZone(point, 'cold', this.level) || pr.cold) this.freezeAt(point, pr.owner);
  }

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
  }

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
  }

  // <들기>: 조준 모드는 조준한 하나, 주변 모드는 반경 안의 들 수 있는 것들을 가벼운 것부터 힘이 닿는 만큼 잡는다.
  // 이미 다른 사람이 들고 있는 물체에는 합류해 같이 든다(무게를 나눠 든다). 시전 종료 전까지 계속 제어한다.
  // 조준 모드는 혼자 힘으로 못 드는 물체도 "붙잡을" 수 있다: 바닥에서 뜨지 않다가 같이 들 사람이 합류하면 올라간다 [제안안]
  startLift(pid, mode, aim, view, mods, fail) {
    const T = this.T;
    const caster = this.body(pid);
    const capacity = this.liftCapacity(pid);
    const radius = T.nearbyRadius * modFactor(T, mods, 'BIG', 'liftReach');
    // 조준 모드는 무게로 거절하지 않는다(붙잡기). 주변 모드는 아래에서 힘이 닿는 만큼만 고른다.
    const opts = { range: T.liftRange, radius, capacity: mode === 'NEAR' ? capacity : undefined, load: 0, casterGround: caster.groundId };
    const world = this.targetingWorld(view);
    const res = resolveTargets(mode, 'LIFT', world, pid, aim, opts, T);
    if (!res.applicable.length) return fail(res.reason);
    let picked = res.applicable.map((id) => this.body(id));
    if (mode === 'NEAR') {
      // 가벼운 것부터, 나눠 든 무게의 합이 힘 안에 들 때까지
      picked.sort((a, b) => a.mass - b.mass);
      let load = 0;
      picked = picked.filter((b) => {
        const share = liftShare(b.mass, b.heldBy.length + 1);
        if (load + share > capacity + 1e-9) return false;
        load += share;
        return true;
      });
      if (!picked.length) return fail(REASON.TOO_HEAVY);
    } else {
      picked = picked.slice(0, 1);
    }
    const yaw0 = Math.atan2(this.players[pid].aimDir[0], this.players[pid].aimDir[2]);
    const eye = [caster.pos[0], caster.pos[1] + T.liftEye, caster.pos[2]];
    const items = picked.map((b) => {
      if (mode === 'NEAR') {
        // 시전 순간의 시선 기준 상대 위치를 기억했다가, 시점을 돌리면 같이 돈다
        const ox = b.pos[0] - caster.pos[0];
        const oz = b.pos[2] - caster.pos[2];
        const c = Math.cos(-yaw0);
        const sn = Math.sin(-yaw0);
        return { id: b.id, off: [ox * c + oz * sn, -ox * sn + oz * c] };
      }
      return { id: b.id, dist: Math.max(T.liftHoldMin, Math.min(T.liftHoldMax, dist(eye, b.pos))) };
    });
    this.players[pid].holding = { mode, items };
    for (const b of picked) {
      b.heldBy.push(pid);
      b.grounded = false;
    }
    this.faceAim(pid, aim);
    const targets = picked.map((b) => b.id);
    const joined = picked.filter((b) => b.heldBy.length > 1).map((b) => b.id);
    // 붙잡기만 되는(같이 들어야 올라가는) 물체
    const loads = liftLoads(this.bodies);
    const heavy = picked.filter((b) => this.strainOf(b, loads) > 1 + 1e-9).map((b) => b.id);
    this.emit({ k: 'liftStart', by: pid, mode, target: targets[0], targets, joined, heavy, mods: this.modCounts(pid) });
    return { ok: true, targets, joined, heavy };
  }

  // 시전 종료: 시전자가 자신이 유지 중인 지속형 마법(현재는 <들기>뿐)을 직접 끝낸다.
  // 다른 사람이 건 마법에서 벗어나는 해제(R, onRelease)와는 별개다. 같이 들던 사람은 계속 든다.
  onEndCast(pid) {
    if (!this.players[pid].holding) return { ok: false };
    this.endHold(pid, 'released');
    this.players[pid].cooldownUntil = this.time + this.T.castCooldown;
    return { ok: true };
  }

  // 물체의 버거움: 드는 사람들의 (나눠 든 무게 합 / 힘)의 조화 평균. 1을 넘으면 바닥에서 뜨지 않는다.
  strainOf(b, loads = liftLoads(this.bodies)) {
    return liftStrain(b.heldBy.map((pid) => ({ load: loads.get(pid) || b.mass, capacity: this.liftCapacity(pid) })));
  }

  // 한 사람이 물체 하나를 놓는다. 마지막으로 들던 사람이 놓으면 물체는 그때의 속도를 그대로 가진다(던지기) [임시].
  releaseItem(pid, bodyId, reason) {
    const p = this.players[pid];
    if (!p?.holding) return;
    p.holding.items = p.holding.items.filter((it) => it.id !== bodyId);
    if (!p.holding.items.length) p.holding = null;
    const b = this.body(bodyId);
    if (b) {
      b.heldBy = b.heldBy.filter((h) => h !== pid);
      if (!b.heldBy.length) {
        b.hold = null;
        b.strained = false;
        b.extCap = this.T.pushMaxSpeed;
      }
    }
    this.emit({ k: 'liftEnd', by: pid, target: bodyId, reason, still: b ? [...b.heldBy] : [] });
  }

  // 들고 있는 것을 모두 놓는다
  endHold(pid, reason) {
    const p = this.players[pid];
    if (!p || !p.holding) return;
    for (const it of [...p.holding.items]) this.releaseItem(pid, it.id, reason);
  }

  // 매 틱 들린 물체의 목표 지점을 정한다.
  // 각자의 목표(조준: 시선 앞 일정 거리 / 주변: 시전자 둘레의 상대 위치)를 드는 사람끼리 평균하고,
  // 버거움(나눠 든 무게/힘)에 따라 높이 상한과 끄는 가속도를 정한다.
  updateHolds() {
    const T = this.T;
    // 1) 단어·거리·대상 확인
    for (const pid of this.seats) {
      const p = this.players[pid];
      if (!p.holding) continue;
      const caster = this.body(pid);
      if (!caster) { this.endHold(pid, 'gone'); continue; }
      if (this.effectWord(pid) !== 'LIFT') { this.endHold(pid, 'word'); continue; } // 단어를 내려놓거나 바꾸면 놓친다 [임시]
      for (const it of [...p.holding.items]) {
        const b = this.body(it.id);
        if (!b) this.releaseItem(pid, it.id, 'gone');
        else if (dist(caster.pos, b.pos) > T.liftBreakDistance) this.releaseItem(pid, it.id, 'far');
      }
    }
    // 2) 물체별 목표 지점. 힘이 모자라면(버거움 > 1: <세게>를 넘겨줬거나 같이 들던 사람이 놓았을 때)
    //    놓치지는 않지만 바닥에서 뜨지 못한다(중력·마찰을 그대로 받는다). 같이 들 사람이 오면 다시 올라간다.
    const caps = new Map(this.seats.map((pid) => [pid, this.liftCapacity(pid)]));
    const loads = liftLoads(this.bodies);
    for (const b of this.bodies) {
      if (!b.heldBy.length) { b.hold = null; b.strained = false; continue; }
      const sum = [0, 0, 0];
      let bottomSum = 0;
      const strainIn = [];
      for (const pid of b.heldBy) {
        const p = this.players[pid];
        const caster = this.body(pid);
        const it = p.holding.items.find((x) => x.id === b.id);
        let target;
        if (it.off) {
          const yaw = Math.atan2(p.aimDir[0], p.aimDir[2]);
          const c = Math.cos(yaw);
          const sn = Math.sin(yaw);
          const ox = it.off[0] * c + it.off[1] * sn;
          const oz = -it.off[0] * sn + it.off[1] * c;
          target = [caster.pos[0] + ox, bottomOf(caster) + T.liftNearHeight + b.half[1], caster.pos[2] + oz];
        } else {
          const eye = [caster.pos[0], caster.pos[1] + T.liftEye, caster.pos[2]];
          target = eye.map((v, i) => v + p.aimDir[i] * it.dist);
        }
        for (let i = 0; i < 3; i++) sum[i] += target[i];
        bottomSum += bottomOf(caster);
        strainIn.push({ load: loads.get(pid) || b.mass, capacity: caps.get(pid) });
      }
      const n = b.heldBy.length;
      const target = sum.map((v) => v / n);
      const strain = liftStrain(strainIn);
      b.strained = strain > 1 + 1e-9;
      if (b.strained) { b.hold = null; continue; }
      const maxBottom = liftMaxBottom(bottomSum / n, strain, T);
      if (target[1] - b.half[1] > maxBottom) target[1] = maxBottom + b.half[1];
      // 버거울수록 끄는 힘의 여유가 적어 더 느리게 따라온다 [임시]
      const amax = T.liftMaxAccel * Math.max(0.15, 1 - strain);
      b.hold = { target, k: T.liftSpring, c: T.liftDamping, amax };
    }
  }

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
  }

  // 월드의 단어를 갖는다. 다른 사람이 던진(내려놓은) 것이면 주고받기로 기록한다.
  collectToken(pid, t) {
    t.pos = null;
    t.vy = 0;
    t.vel = [0, 0];
    const from = t.lastOwner && t.lastOwner !== pid ? t.lastOwner : null;
    t.lastOwner = null;
    const equipped = this.receiveToken(pid, t);
    this.emit({ k: 'pickup', by: pid, token: t.id, word: t.word, equipped, from });
  }

  // 단어를 갖게 한다(마인크래프트처럼 가방으로). 손에 든 효과가 없을 때 효과 단어만 바로 손에 든다.
  // 수식은 자동으로 붙지 않는다: 가방 창(E)에서 수식 칸에 넣어야 주문에 붙는다.
  receiveToken(pid, t) {
    t.owner = pid;
    t.acquiredAt = this.time + this.tick * 1e-9;
    const p = this.players[pid];
    if (WORDS[t.word].kind === KIND.EFFECT && !this.effectWord(pid)) { p.slots.effect = t.id; return true; }
    return false;
  }

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
  }

  // 장착 칸에서 뺀다(던지거나 내려놓을 때)
  unequipToken(pid, tokenId) {
    const p = this.players[pid];
    if (p.slots.effect === tokenId) p.slots.effect = null;
    p.slots.mods = p.slots.mods.filter((id) => id !== tokenId);
  }

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
  }

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
  }

  // 내려놓기(편집창): 바로 앞에 살짝 떨군다
  onDrop(pid, msg) {
    const t = this.token(msg.token);
    if (!t || t.owner !== pid) return { ok: false };
    const b = this.body(pid);
    this.releaseToken(pid, t, [Math.sin(b.yaw), 0, Math.cos(b.yaw)], 2.5, 1); // 줍는 거리(0.9m)보다 조금 멀리
    this.emit({ k: 'drop', by: pid, token: t.id, word: t.word });
    return { ok: true };
  }

  // 효과 칸 장착·해제
  onEquip(pid, msg) {
    const p = this.players[pid];
    if (msg.slot !== 'effect') return { ok: false };
    if (msg.token == null) { p.slots.effect = null; return { ok: true }; }
    const t = this.token(msg.token);
    if (!t || t.owner !== pid || WORDS[t.word].kind !== KIND.EFFECT) return { ok: false };
    p.slots.effect = t.id;
    return { ok: true };
  }

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

  // 투사체: 이동 → 실제 충돌 → 맞은 대상과 유효성 확인 → 효과 적용. 날아가는 동안에는 아무것도 미리 적용하지 않는다.
  stepProjectiles(dt) {
    const keep = [];
    for (const pr of this.projectiles) {
      pr.life -= dt;
      const move = pr.vel.map((v) => v * dt);
      const L = Math.hypot(...move);
      const dir = move.map((v) => v / L);
      let hit = null;
      const test = (box, type, id) => {
        const ex = { min: box.min.map((v) => v - pr.radius), max: box.max.map((v) => v + pr.radius) };
        const t = rayBox(pr.pos, dir, ex, L);
        if (t !== null && (!hit || t < hit.t)) hit = { t, type, id };
      };
      for (const s of this.statics) test(s, 'static', s.id);
      for (const b of this.bodies) if (b.id !== pr.owner && !b.ghost) test(boxOfBody(b), 'body', b.id);
      if (hit) {
        const point = pr.pos.map((v, i) => v + dir[i] * hit.t);
        if (pr.word === 'WATER') this.splash(pr, point, hit);
        else this.explode(pr, point, hit);
        continue;
      }
      pr.pos = pr.pos.map((v, i) => v + move[i]);
      if (pr.life <= 0 || pr.pos[1] < this.T.killY) {
        this.emit({ k: 'fizzle', id: pr.id, pos: pr.pos.map(r3), word: pr.word });
        continue;
      }
      keep.push(pr);
    }
    this.projectiles = keep;
  }

  // 명중 지점의 작은 폭발. 적은 피해, 다른 플레이어는 디버프(체력 감소 없음), 모두 약간 밀린다.
  // 시전자 자신은 제외 [임시: 자기 시전 피해 미정]. 보호 중인 플레이어는 받지 않는다.
  explode(pr, point, hit) {
    const T = this.T;
    const hits = [];
    for (const b of [...this.bodies]) {
      if (b.id === pr.owner || b.ghost || !this.bodies.includes(b)) continue;
      const box = boxOfBody(b);
      const dx = Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]);
      const dy = Math.max(box.min[1] - point[1], 0, point[1] - box.max[1]);
      const dz = Math.max(box.min[2] - point[2], 0, point[2] - box.max[2]);
      const direct = hit.type === 'body' && hit.id === b.id;
      if (!direct && Math.hypot(dx, dy, dz) > pr.blast) continue;
      if (!direct && segmentBlocked(point, b.pos, this.statics)) continue;
      if (b.kind === 'player' && this.time < b.immuneUntil) continue;
      if (b.traits[TRAIT.BREAKABLE]) { this.chip(b, pr.damage, pr.owner); hits.push({ id: b.id, effects: ['chip'], direct }); continue; }
      // 적은 피해, 아군은 그을림(체력 감소 없음), 얼음은 녹고, 꺼진 모닥불은 붙는다
      const effects = b.traits[TRAIT.HEATABLE] ? this.heat(b, pr.damage, pr.owner) : [];
      if (effects.includes('melt')) { hits.push({ id: b.id, effects, direct }); continue; }
      if (b.traits[TRAIT.MOVABLE]) {
        let d = [b.pos[0] - point[0], b.pos[2] - point[2]];
        const l = Math.hypot(d[0], d[1]);
        d = l > 1e-3 ? [d[0] / l, d[1] / l] : normalize([pr.vel[0], 0, pr.vel[2]]).filter((_, i) => i !== 1);
        b.ext[0] += d[0] * pr.push;
        b.ext[1] += d[1] * pr.push;
        clampExt(b, b.extCap ?? T.pushMaxSpeed);
        effects.push('push');
      }
      hits.push({ id: b.id, effects, direct });
    }
    this.emit({
      k: 'boom', id: pr.id, by: pr.owner, pos: point.map(r3), blast: r3(pr.blast), damage: r3(pr.damage),
      direct: hit.type === 'body' ? hit.id : null, hits,
    });
  }

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
  }

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
