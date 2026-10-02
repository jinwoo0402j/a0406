// 시전: 효과 단어별 시전 방식과 맞은 뒤의 효과(투사체 폭발·물 튀김·데우기).
// 새 효과 단어를 더할 때는 shared/words.js에 정의하고, 여기 CAST 표에 시전 함수를 하나 더한다.
// Game.prototype에 붙는 메서드 묶음이다(this = Game).

import { inZone } from '../shared/level.js';
import { modFactor } from '../shared/tuning.js';
import { WORDS, TRAIT, MODE_ORDER } from '../shared/words.js';
import { resolveTargets, REASON, modeUnsupported } from '../shared/targeting.js';
import { boxOfBody, dist, normalize, segmentBlocked, rayBox } from '../shared/geom.js';
import { bottomOf, clampExt } from './physics.js';
import { r3, validVec } from './util.js';

// 효과 단어 → 시전 함수. c = { pid, mode, aim, view, mods, fail } (this = Game)
// 대상 모드 검사·대기시간·조준 확인은 onCast가 먼저 끝낸다.
export const CAST = {
  PUSH(c) { return this.castPush(c.pid, c.mode, c.aim, c.view, c.mods, c.fail); },
  PULL(c) { return this.castPull(c.pid, c.mode, c.aim, c.view, c.mods, c.fail); },
  LIFT(c) { return this.startLift(c.pid, c.mode, c.aim, c.view, c.mods, c.fail); },
  FIREBALL(c) {
    if (c.mode === 'SELF') return this.castSelfBlast(c.pid, c.aim, c.mods);
    if (c.mode === 'NEAR') return this.castFireballRing(c.pid, c.aim, c.mods);
    return this.castFireball(c.pid, c.aim, c.mods);
  },
  WATER(c) {
    if (c.mode === 'SELF') return this.castSelfWash(c.pid, c.mods);
    if (c.mode === 'NEAR') return this.castFireballRing(c.pid, c.aim, c.mods, 'WATER');
    return this.castFireball(c.pid, c.aim, c.mods, 'WATER');
  },
  FIRE(c) { return this.castFire(c.pid, c.mode, c.aim, c.view, c.mods, c.fail); },
  STEAM(c) { return this.castSteam(c.pid, c.mode, c.aim, c.view, c.mods, c.fail); },
};

export const SpellMethods = {
  // 조준 정보 검증(원점은 시전자 근처의 카메라여야 한다). view: 시전자가 보고 있던 시점의 위치
  parseAim(pid, msg) {
    const view = this.viewAt(Number(msg.vt));
    const casterPos = view?.get(pid) || this.body(pid).pos;
    let aim = null;
    if (validVec(msg.origin) && validVec(msg.dir) && Math.hypot(...msg.dir) > 1e-6) {
      if (dist(msg.origin, casterPos) <= this.T.maxCameraOffset) aim = { origin: msg.origin, dir: normalize(msg.dir) };
    }
    return { aim, view };
  },

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
    const cast = CAST[effect];
    if (!cast) return fail(REASON.NO_EFFECT);
    return cast.call(this, { pid, mode, aim, view, mods: this.modCounts(pid), fail });
  },

  faceAim(pid, aim) {
    const b = this.body(pid);
    if (aim && (aim.dir[0] || aim.dir[2])) b.yaw = Math.atan2(aim.dir[0], aim.dir[2]);
  },

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
  },

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
  },

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
  },

  // 시전자 앞 수평 방향 fwd로 발사 위치. 벽에 막히면 몸 중심에서.
  fireballSpawnPoint(caster, fwd) {
    const T = this.T;
    const spawn = [caster.pos[0] + fwd[0] * T.fireballSpawnForward, caster.pos[1] + 0.25, caster.pos[2] + fwd[2] * T.fireballSpawnForward];
    return segmentBlocked(caster.pos, spawn, this.statics) ? [...caster.pos] : spawn;
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },
};
