// 호스트 권한 게임 상태 (v0.3). 토큰 소유권, 줍기·내려놓기, 주문 유효성, 효과, 투사체, 사물 위치, 클리어를 확정한다.
// 자기 시전과 게스트 시전은 같은 handle() 경로로 같은 검증을 받는다. 네트워크와 분리되어 테스트에서 직접 구동한다.
//
// 주문 = 효과 단어 1개 + 수식 단어(보유·장착한 개수만큼 중첩). 대상은 시전 요청의 대상 모드(AIM/SELF/NEAR).
// 효과마다 시전 방식이 다르다: 밀치기(즉시·한 번) / 들기(누르는 동안 지속 제어) / 파이어볼(투사체, 실제 명중 시 적용).

import { LEVEL, SEAT_IDS } from '../shared/level.js';
import { TUNING, modFactor } from '../shared/tuning.js';
import { WORDS, KIND, TRAIT, MOD_IDS, MODE_ORDER } from '../shared/words.js';
import { resolveTargets, REASON, modeUnsupported, liftMaxBottom } from '../shared/targeting.js';
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
      else if (!t.owner) { t.owner = pid; t.pos = null; t.vy = 0; }
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
    if (b.heldBy) this.endHold(b.heldBy, 'left');
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
      traits: { [TRAIT.MOVABLE]: true, [TRAIT.LIFTABLE]: true, [TRAIT.DAMAGEABLE]: d.kind === 'dummy' },
      hp: d.kind === 'dummy' ? this.T.dummyHp : null,
      downUntil: 0,
      inVel: [0, 0],
      ext: [0, 0],
      extCap: null,
      vy: 0,
      hold: null, // 들기 제어 목표(물리가 사용)
      heldBy: null, // 들고 있는 플레이어
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
        heldBy: b.heldBy,
      })),
    };
  }

  // ---------------------------------------------------------------- 입력 처리
  handle(pid, msg) {
    const p = this.players[pid];
    if (!p || !msg || typeof msg !== 'object') return { ok: false };
    switch (msg.t) {
      case 'input': return this.onInput(pid, msg);
      case 'cast': return this.onCast(pid, msg);
      case 'liftEnd': return this.onLiftEnd(pid);
      case 'pickup': return this.onPickup(pid);
      case 'drop': return this.onDrop(pid, msg);
      case 'equip': return this.onEquip(pid, msg);
      case 'mod': return this.onMod(pid, msg);
      case 'release': return this.onRelease(pid);
      case 'restart': return this.onRestart(pid);
      default: return { ok: false };
    }
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
    if (p.holding) return { ok: false }; // 들기 유지 중에는 새로 시전하지 않는다
    if (this.time < p.cooldownUntil - 1e-9) return fail(REASON.COOLDOWN);
    const { aim, view } = this.parseAim(pid, msg);
    if (mode === 'AIM' && !aim) return fail(REASON.BAD_AIM);
    if (aim) p.aimDir = aim.dir;
    const mods = this.modCounts(pid);
    if (effect === 'PUSH') return this.castPush(pid, mode, aim, view, mods, fail);
    if (effect === 'FIREBALL') return this.castFireball(pid, aim, mods);
    if (effect === 'LIFT') return this.startLift(pid, aim, view, fail);
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

  // <파이어볼>: 시전자 앞에서 조준점으로 투사체를 쏜다. 효과는 날아가서 실제로 맞았을 때 적용한다.
  castFireball(pid, aim, mods) {
    const T = this.T;
    const caster = this.body(pid);
    let fwd = normalize([aim.dir[0], 0, aim.dir[2]]);
    if (!fwd[0] && !fwd[2]) fwd = [Math.sin(caster.yaw), 0, Math.cos(caster.yaw)];
    let spawn = [caster.pos[0] + fwd[0] * T.fireballSpawnForward, caster.pos[1] + 0.25, caster.pos[2] + fwd[2] * T.fireballSpawnForward];
    if (segmentBlocked(caster.pos, spawn, this.statics)) spawn = [...caster.pos];
    // 조준점: 카메라 조준선이 처음 닿는 곳(없으면 먼 지점)
    let t = T.aimPointRange;
    for (const s of this.statics) { const h = rayBox(aim.origin, aim.dir, s, t); if (h !== null && h < t) t = h; }
    for (const b of this.bodies) {
      if (b.id === pid) continue;
      const h = rayBox(aim.origin, aim.dir, boxOfBody(b), t);
      if (h !== null && h < t) t = h;
    }
    const aimPoint = aim.origin.map((o, i) => o + aim.dir[i] * t);
    let dir = normalize(aimPoint.map((v, i) => v - spawn[i]));
    if (dir[0] * aim.dir[0] + dir[1] * aim.dir[1] + dir[2] * aim.dir[2] < 0.2) dir = aim.dir;
    const proj = {
      id: this.nextProjectileId++,
      owner: pid,
      pos: spawn,
      vel: dir.map((v) => v * T.fireballSpeed),
      radius: T.fireballRadius * modFactor(T, mods, 'BIG', 'fireballRadius'),
      blast: T.fireballBlastRadius * modFactor(T, mods, 'BIG', 'blastRadius'),
      damage: T.fireballDamage * modFactor(T, mods, 'STRONG', 'fireballDamage'),
      life: T.fireballLife,
    };
    this.projectiles.push(proj);
    this.faceAim(pid, aim);
    this.players[pid].cooldownUntil = this.time + T.castCooldown;
    this.emit({ k: 'cast', by: pid, effect: 'FIREBALL', mode: 'AIM', mods, projectile: proj.id, radius: r3(proj.radius), targets: [] });
    return { ok: true, projectile: proj.id };
  }

  // <들기>: 조준한 대상을 잡고, 버튼을 누르는 동안(liftEnd 전까지) 시점을 따라 끌고 다닌다.
  startLift(pid, aim, view, fail) {
    const T = this.T;
    const caster = this.body(pid);
    const capacity = this.liftCapacity(pid);
    const res = resolveTargets('AIM', 'LIFT', this.targetingWorld(view), pid, aim, { range: T.liftRange, capacity, casterGround: caster.groundId }, T);
    if (!res.applicable.length) return fail(res.reason);
    const b = this.body(res.applicable[0]);
    const eye = [caster.pos[0], caster.pos[1] + T.liftEye, caster.pos[2]];
    const holdDist = Math.max(T.liftHoldMin, Math.min(T.liftHoldMax, dist(eye, b.pos)));
    this.players[pid].holding = { target: b.id, dist: holdDist };
    b.heldBy = pid;
    b.grounded = false;
    this.faceAim(pid, aim);
    this.emit({ k: 'liftStart', by: pid, target: b.id, mods: this.modCounts(pid) });
    return { ok: true, targets: [b.id] };
  }

  onLiftEnd(pid) {
    if (!this.players[pid].holding) return { ok: false };
    this.endHold(pid, 'released');
    this.players[pid].cooldownUntil = this.time + this.T.castCooldown;
    return { ok: true };
  }

  // 들기 종료. 물체는 그때의 속도를 그대로 가진다(던지기) [임시].
  endHold(pid, reason) {
    const p = this.players[pid];
    if (!p || !p.holding) return;
    const b = this.body(p.holding.target);
    if (b) {
      b.hold = null;
      b.heldBy = null;
      b.extCap = this.T.pushMaxSpeed;
    }
    p.holding = null;
    this.emit({ k: 'liftEnd', by: pid, target: b?.id, reason });
  }

  // 매 틱 들린 물체의 목표 지점을 정한다: 시선 방향 앞 일정 거리, 무게에 따라 높이 상한.
  updateHolds() {
    const T = this.T;
    for (const pid of this.seats) {
      const p = this.players[pid];
      if (!p.holding) continue;
      const caster = this.body(pid);
      const b = this.body(p.holding.target);
      const capacity = this.liftCapacity(pid);
      if (!caster || !b) { this.endHold(pid, 'gone'); continue; }
      if (this.effectWord(pid) !== 'LIFT') { this.endHold(pid, 'word'); continue; } // 단어를 내려놓거나 바꾸면 놓친다 [임시]
      if (b.mass > capacity + 1e-9) { this.endHold(pid, 'heavy'); continue; } // <세게>를 넘겨주면 힘이 줄어든다
      if (dist(caster.pos, b.pos) > T.liftBreakDistance) { this.endHold(pid, 'far'); continue; }
      const eye = [caster.pos[0], caster.pos[1] + T.liftEye, caster.pos[2]];
      const target = eye.map((v, i) => v + p.aimDir[i] * p.holding.dist);
      const maxBottom = liftMaxBottom(bottomOf(caster), b.mass, capacity, T);
      if (target[1] - b.half[1] > maxBottom) target[1] = maxBottom + b.half[1];
      // 무거울수록 끄는 힘의 여유가 적어 더 느리게 따라온다 [임시]
      const amax = T.liftMaxAccel * Math.max(0.15, 1 - b.mass / capacity);
      b.hold = { target, k: T.liftSpring, c: T.liftDamping, amax };
    }
    for (const b of this.bodies) if (!b.heldBy) b.hold = null;
  }

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
    const t = best.t;
    t.owner = pid;
    t.pos = null;
    t.vy = 0;
    t.acquiredAt = this.time + this.tick * 1e-9;
    // 효과 칸이 비어 있으면 바로 장착, 수식은 바로 붙인다(편집창에서 개수를 줄일 수 있다).
    const p = this.players[pid];
    let equipped = false;
    if (WORDS[t.word].kind === KIND.EFFECT) {
      if (!this.effectWord(pid)) { p.slots.effect = t.id; equipped = true; }
    } else {
      p.slots.mods.push(t.id);
      equipped = true;
    }
    this.emit({ k: 'pickup', by: pid, token: t.id, word: t.word, equipped });
    return { ok: true, token: t.id };
  }

  onDrop(pid, msg) {
    const t = this.token(msg.token);
    if (!t || t.owner !== pid) return { ok: false };
    const b = this.body(pid);
    const p = this.players[pid];
    if (p.slots.effect === t.id) p.slots.effect = null; // 장착 칸은 비운다
    p.slots.mods = p.slots.mods.filter((id) => id !== t.id);
    const fwd = [Math.sin(b.yaw), Math.cos(b.yaw)];
    const base = [b.pos[0], bottomOf(b) + 0.3, b.pos[2]];
    let pos = [base[0] + fwd[0] * this.T.dropForward, base[1], base[2] + fwd[1] * this.T.dropForward];
    if (segmentBlocked(base, pos, this.statics)) pos = base;
    t.owner = null;
    t.pos = pos;
    t.vy = 0;
    // 떨어지면 내려놓은 사람이 마지막으로 서 있던 지면 기준으로 복구한다
    if (b.lastSafe) t.lastSafe = { ground: b.lastSafe.ground, pos: [...b.lastSafe.pos] };
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
    p.slots.mods = [...others, ...owned.slice(0, n)];
    return { ok: true, count: n };
  }

  onRelease(pid) {
    const p = this.players[pid];
    if (this.time < p.releaseReadyAt) return { ok: false };
    const b = this.body(pid);
    // 자신에게 걸린 외부 이동·들림을 풀고, 다른 플레이어의 마법에 잠시 면역 [임시: v0.2 규칙 유지]
    if (b.heldBy) this.endHold(b.heldBy, 'released-by-target');
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
    this.stepTokens(dt);
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
      for (const b of this.bodies) if (b.id !== pr.owner) test(boxOfBody(b), 'body', b.id);
      if (hit) {
        this.explode(pr, pr.pos.map((v, i) => v + dir[i] * hit.t), hit);
        continue;
      }
      pr.pos = pr.pos.map((v, i) => v + move[i]);
      if (pr.life <= 0 || pr.pos[1] < this.T.killY) {
        this.emit({ k: 'fizzle', id: pr.id, pos: pr.pos.map(r3) });
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
    for (const b of this.bodies) {
      if (b.id === pr.owner) continue;
      const box = boxOfBody(b);
      const dx = Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]);
      const dy = Math.max(box.min[1] - point[1], 0, point[1] - box.max[1]);
      const dz = Math.max(box.min[2] - point[2], 0, point[2] - box.max[2]);
      const direct = hit.type === 'body' && hit.id === b.id;
      if (!direct && Math.hypot(dx, dy, dz) > pr.blast) continue;
      if (!direct && segmentBlocked(point, b.pos, this.statics)) continue;
      if (b.kind === 'player' && this.time < b.immuneUntil) continue;
      const effects = [];
      if (b.traits[TRAIT.DAMAGEABLE]) {
        if (!b.downUntil) {
          b.hp = Math.max(0, b.hp - pr.damage);
          effects.push('damage');
          if (b.hp <= 0) {
            b.downUntil = this.time + T.dummyRespawn;
            this.emit({ k: 'dummyDown', id: b.id });
          }
        }
      } else if (b.kind === 'player') {
        b.debuffUntil = this.time + T.allyDebuffDuration; // 아군: 피해 대신 디버프
        effects.push('debuff');
      }
      if (b.traits[TRAIT.MOVABLE]) {
        let d = [b.pos[0] - point[0], b.pos[2] - point[2]];
        const l = Math.hypot(d[0], d[1]);
        d = l > 1e-3 ? [d[0] / l, d[1] / l] : normalize([pr.vel[0], 0, pr.vel[2]]).filter((_, i) => i !== 1);
        b.ext[0] += d[0] * T.fireballKnockback;
        b.ext[1] += d[1] * T.fireballKnockback;
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

  stepTokens(dt) {
    for (const t of this.tokens) {
      if (t.owner || !t.pos) continue;
      const floorY = this.surfaceBelow(t.pos);
      if (floorY !== null && t.pos[1] <= floorY + 1e-4) {
        t.pos[1] = floorY;
        t.vy = 0;
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
        this.emit({ k: 'tokenRecover', token: t.id, word: t.word });
      }
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
    if (b.heldBy) this.endHold(b.heldBy, 'fell');
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
        if (b.heldBy) o.h = b.heldBy; // 들고 있는 사람
        if (b.hp !== null) { o.hp = r3(b.hp); o.dn = b.downUntil ? 1 : 0; }
        return o;
      }),
      pr: this.projectiles.map((pr) => ({ id: pr.id, p: pr.pos.map(r3), r: r3(pr.radius), o: pr.owner })),
      k: this.tokens.map((tk) => ({ id: tk.id, w: tk.word, o: tk.owner, p: tk.pos ? tk.pos.map(r3) : null })),
      p: Object.fromEntries(this.seats.map((pid) => {
        const pl = this.players[pid];
        return [pid, {
          e: pl.slots.effect,
          m: [...pl.slots.mods],
          mc: this.modCounts(pid),
          cd: r3(Math.max(0, pl.cooldownUntil - t)),
          inv: this.inventory(pid).map((tk) => tk.id),
          hold: pl.holding?.target || null,
        }];
      })),
      g: { t: r3(this.goal.timer), c: this.goal.cleared, in: this.goal.inside },
    };
  }
}
