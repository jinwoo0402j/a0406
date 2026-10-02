// <들기>: 지속형 시전, 같이 들기(무게 분담), 주변 들기, 매 틱 들린 물체의 목표 지점.
// Game.prototype에 붙는 메서드 묶음이다(this = Game).

import { modFactor } from '../shared/tuning.js';
import { resolveTargets, REASON, liftMaxBottom, liftLoads, liftShare, liftStrain } from '../shared/targeting.js';
import { dist } from '../shared/geom.js';
import { bottomOf } from './physics.js';

export const LiftMethods = {
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
  },

  // 시전 종료: 시전자가 자신이 유지 중인 지속형 마법(현재는 <들기>뿐)을 직접 끝낸다.
  // 다른 사람이 건 마법에서 벗어나는 해제(R, onRelease)와는 별개다. 같이 들던 사람은 계속 든다.
  onEndCast(pid) {
    if (!this.players[pid].holding) return { ok: false };
    this.endHold(pid, 'released');
    this.players[pid].cooldownUntil = this.time + this.T.castCooldown;
    return { ok: true };
  },

  // 물체의 버거움: 드는 사람들의 (나눠 든 무게 합 / 힘)의 조화 평균. 1을 넘으면 바닥에서 뜨지 않는다.
  strainOf(b, loads = liftLoads(this.bodies)) {
    return liftStrain(b.heldBy.map((pid) => ({ load: loads.get(pid) || b.mass, capacity: this.liftCapacity(pid) })));
  },

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
  },

  // 들고 있는 것을 모두 놓는다
  endHold(pid, reason) {
    const p = this.players[pid];
    if (!p || !p.holding) return;
    for (const it of [...p.holding.items]) this.releaseItem(pid, it.id, reason);
  },

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
  },
};
