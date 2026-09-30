// 호스트 권한 게임 상태. 토큰 소유권, 줍기·내려놓기, 주문 유효성, 효과, 사물 위치, 클리어를 모두 여기서 확정한다.
// 자기 시전과 게스트 시전은 같은 handle() 경로로 같은 검증을 받는다.
// 네트워크와 분리되어 있어 테스트에서 직접 구동할 수 있다.

import { LEVEL, SEAT_IDS } from '../shared/level.js';
import { TUNING } from '../shared/tuning.js';
import { WORDS, SLOT, TRAIT } from '../shared/words.js';
import { resolveSpell, REASON } from '../shared/targeting.js';
import { boxOfBody, overlaps, pointInBox, dist, normalize, segmentBlocked } from '../shared/geom.js';
import { Physics, bottomOf, clampExt } from './physics.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

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

  // 위치·소유권·슬롯·효과·대기시간을 최초 상태로 되돌린다. seats를 주면 그 자리들로 새 판을 시작한다.
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
    this.goal = { timer: 0, cleared: false, inside: {} };
    this.history = [];
    this.recordHistory();
  }

  playerDef(pid) {
    const seat = this.level.seats.find((s) => s.id === pid);
    return { id: pid, kind: 'player', pos: seat.spawn, size: this.level.playerSize };
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

  // 시작 슬롯: 그 자리의 시작 단어 중 본인이 가진 것을 분류별로 장착한다.
  makePlayer(pid) {
    const slots = { target: null, action: null };
    for (const d of this.level.tokens) {
      if (d.seat !== pid) continue;
      const t = this.tokens.find((x) => x.id === d.id);
      if (t && t.owner === pid) slots[WORDS[d.word].slot] = d.id;
    }
    return { id: pid, slots, cooldownUntil: 0, releaseReadyAt: 0 };
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
      const t = this.tokens.find((x) => x.id === d.id);
      if (!t) this.tokens.push(this.makeToken(d, pid));
      else if (!t.owner) { t.owner = pid; t.pos = null; t.vy = 0; }
    }
    this.players[pid] = this.makePlayer(pid);
    this.seats = SEAT_IDS.filter((id) => this.players[id]);
    this.emit({ k: 'join', id: pid });
    return true;
  }

  // 게임 중 퇴장: 가지고 있던 단어는 그 자리에 떨어뜨린다(허공이면 안전 지점으로).
  removePlayer(pid) {
    const b = this.body(pid);
    if (!b) return false;
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
      // 최소안의 캐릭터와 이동 사물은 두 속성을 모두 가진다. 고정 지형은 가지지 않는다.
      traits: { [TRAIT.MOVABLE]: true, [TRAIT.FLOATABLE]: true },
      inVel: [0, 0],
      ext: [0, 0],
      vy: 0,
      float: null,
      grounded: false,
      groundId: null,
      groundStatic: null,
      groundRefY: d.pos[1],
      lastSafe: { ground: this.groundUnder(d.pos), pos: [...d.pos] },
      immuneUntil: 0,
      wish: [0, 0],
      jumpBuffer: 0,
      yaw: 0,
    };
  }

  body(id) {
    return this.bodies.find((b) => b.id === id);
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

  // 대상 지정 규칙이 보는 월드. 위치는 시전자가 보고 있던 시점(view), 보호 상태는 현재 기준이다.
  targetingWorld(view = null) {
    return {
      statics: this.statics,
      bodies: this.bodies.map((b) => ({
        id: b.id,
        kind: b.kind,
        pos: view?.get(b.id) || b.pos,
        half: b.half,
        traits: b.traits,
        immune: this.time < b.immuneUntil,
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
      case 'pickup': return this.onPickup(pid);
      case 'drop': return this.onDrop(pid, msg);
      case 'equip': return this.onEquip(pid, msg);
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
    return { ok: true };
  }

  onCast(pid, msg) {
    const p = this.players[pid];
    const caster = this.body(pid);
    const fail = (reason) => {
      this.emit({ k: 'castFail', to: pid, by: pid, reason });
      return { ok: false, reason };
    };

    // 1) 보유 단어 확인
    const tt = this.tokens.find((t) => t.id === p.slots.target);
    const at = this.tokens.find((t) => t.id === p.slots.action);
    if (!tt || !at || tt.owner !== pid || at.owner !== pid) return fail(REASON.INCOMPLETE);
    const tw = WORDS[tt.word];
    const aw = WORDS[at.word];
    if (tw.slot !== SLOT.TARGET || aw.slot !== SLOT.ACTION) return fail(REASON.INCOMPLETE);
    if (this.time < p.cooldownUntil - 1e-9) return fail(REASON.COOLDOWN);

    // 조준 정보 검증(원점은 시전자 근처의 카메라여야 한다)
    const view = this.viewAt(Number(msg.vt));
    const casterPos = view?.get(pid) || caster.pos;
    let aim = null;
    const o = msg.origin, d = msg.dir;
    const valid = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
    if (valid(o) && valid(d) && Math.hypot(...d) > 1e-6) {
      if (dist(o, casterPos) <= this.T.maxCameraOffset) aim = { origin: o, dir: normalize(d) };
    }
    if (tw.rule === 'AIMED' && !aim) return fail(REASON.BAD_AIM);

    // 2) 대상 지정 규칙으로 대상 목록 결정 → 3) 공통 속성·보호 상태 검사
    const res = resolveSpell(tw.rule, aw.action, this.targetingWorld(view), pid, aim, this.T);
    if (!res.applicable.length) return fail(res.reason);

    // 4) 작용 적용
    const camFwd = aim ? normalize([aim.dir[0], 0, aim.dir[2]]) : [Math.sin(caster.yaw), 0, Math.cos(caster.yaw)];
    for (const id of res.applicable) this.applyAction(aw.action, pid, this.body(id), camFwd);
    if (aim && (camFwd[0] || camFwd[2])) caster.yaw = Math.atan2(camFwd[0], camFwd[2]);
    p.cooldownUntil = this.time + this.T.castCooldown;

    // 5) 결과 동기화(이벤트 + 다음 스냅숏)
    this.emit({
      k: 'cast', by: pid, target: tw.id, action: aw.id,
      targets: res.applicable, rejected: res.rejected.map((r) => r.id),
    });
    return { ok: true, targets: res.applicable };
  }

  applyAction(action, casterId, b, camFwd) {
    const T = this.T;
    const caster = this.body(casterId);
    if (action === 'PUSH') {
      // 방향은 시전자 → 대상. 자기 자신이거나 위치가 겹치면 카메라 수평 전방.
      let dir = [b.pos[0] - caster.pos[0], b.pos[2] - caster.pos[2]];
      const l = Math.hypot(dir[0], dir[1]);
      if (b.id === casterId || l < T.pushSelfEpsilon) dir = [camFwd[0], camFwd[2]];
      else dir = [dir[0] / l, dir[1] / l];
      b.ext[0] += dir[0] * T.pushDeltaV;
      b.ext[1] += dir[1] * T.pushDeltaV;
      clampExt(b, T.extMaxSpeed);
    } else if (action === 'LIFT') {
      // 기준 높이는 마지막으로 착지한 높이(physics가 매 틱 갱신)다. 떠 있는 물체 위에서는 갱신되지 않으며,
      // 공중에서 반복해도 높이는 누적되지 않고 지속시간만 갱신된다.
      b.float = { targetY: b.groundRefY + T.liftHeight, left: T.liftDuration };
      b.grounded = false;
    }
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
    // 해당 분류의 슬롯이 비어 있으면 바로 장착한다.
    const slot = WORDS[t.word].slot;
    const p = this.players[pid];
    let equipped = false;
    if (!p.slots[slot]) { p.slots[slot] = t.id; equipped = true; }
    this.emit({ k: 'pickup', by: pid, token: t.id, word: t.word, equipped });
    return { ok: true, token: t.id };
  }

  onDrop(pid, msg) {
    const t = this.tokens.find((x) => x.id === msg.token);
    if (!t || t.owner !== pid) return { ok: false };
    const b = this.body(pid);
    const p = this.players[pid];
    for (const s of Object.keys(p.slots)) if (p.slots[s] === t.id) p.slots[s] = null; // 장착 슬롯은 비운다
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

  onEquip(pid, msg) {
    const p = this.players[pid];
    const slot = msg.slot;
    if (slot !== SLOT.TARGET && slot !== SLOT.ACTION) return { ok: false };
    if (msg.token == null) {
      p.slots[slot] = null;
      return { ok: true };
    }
    const t = this.tokens.find((x) => x.id === msg.token);
    if (!t || t.owner !== pid || WORDS[t.word].slot !== slot) return { ok: false };
    p.slots[slot] = t.id;
    this.emit({ k: 'equip', by: pid, slot, token: t.id, word: t.word, to: pid });
    return { ok: true };
  }

  onRelease(pid) {
    const p = this.players[pid];
    if (this.time < p.releaseReadyAt) return { ok: false };
    const b = this.body(pid);
    // 자신의 부양 상태와 외부 이동 효과를 해제하고, 다른 플레이어의 이동 마법에 잠시 면역
    b.float = null;
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
    this.physics.step(this.bodies, dt);

    for (const b of this.bodies) {
      if (b.kind === 'player' && Math.hypot(b.inVel[0], b.inVel[1]) > 0.5) {
        b.yaw = Math.atan2(b.inVel[0], b.inVel[1]);
      }
      if (bottomOf(b) < this.T.killY) this.recoverBody(b);
    }
    this.stepTokens(dt);
    this.stepGoal(dt);
    this.recordHistory();
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

  // 낙하 복구: 진행 중인 효과와 속도를 초기화하고 빈 자리를 찾아 둔다.
  recoverBody(b) {
    const base = this.safePoint(b.lastSafe, [0, 0, 0], b.spawn);
    b.float = null;
    b.ext = [0, 0];
    b.inVel = [0, 0];
    b.vy = 0;
    b.grounded = false;
    b.groundId = null;
    b.groundStatic = null;
    this.placeNear(b, base);
    b.groundRefY = base[1];
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
    return {
      t: 's',
      tick: this.tick,
      time: r3(this.time),
      round: this.round,
      b: this.bodies.map((b) => ({
        id: b.id,
        p: b.pos.map(r3),
        y: r3(b.yaw),
        f: b.float ? r3(b.float.left) : 0,
        i: r3(Math.max(0, b.immuneUntil - this.time)),
        g: b.grounded ? 1 : 0,
      })),
      k: this.tokens.map((t) => ({ id: t.id, w: t.word, o: t.owner, p: t.pos ? t.pos.map(r3) : null })),
      p: Object.fromEntries(this.seats.map((pid) => [pid, {
        s: { ...this.players[pid].slots },
        cd: r3(Math.max(0, this.players[pid].cooldownUntil - this.time)),
        inv: this.inventory(pid).map((t) => t.id),
      }])),
      g: { t: r3(this.goal.timer), c: this.goal.cleared, in: this.goal.inside },
    };
  }
}
