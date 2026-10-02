// 호스트 전용 간단 물리. 모든 이동 사물은 회전하지 않는 AABB다.
// - 입력 이동(inVel)과 외부(마법) 이동(ext)을 따로 보관하고 합산한다. 입력이 마법 이동을 덮어쓰지 않는다.
// - 축별 이동(X → Z → Y)으로 충돌을 해결한다. 이미 겹친 물체끼리는 서로 빠져나갈 수 있게 무시한다.
// - 아래에 있는 물체부터 움직이고, 위에 올라탄 물체는 받치는 물체의 이동을 따라간다(물체 위에 서기).
// - 들린 물체(b.hold)는 중력 대신 목표 지점을 향한 스프링·감쇠로 움직인다(관성·넘침이 생긴다).
//   들린 물체가 올라가면 위에 얹힌 물체를 함께 밀어 올린다.
// - 제자리에 박힌 물체(b.fixed: 바위·모닥불·샘)는 움직이지 않고 지형처럼 막기만 한다.
// - 현상(b.ghost: 김)은 아무것과도 부딪히지 않는다.

import { boxOfBody, overlaps, overlapsOnAxes, EPS } from '../shared/geom.js';

const XZ = [0, 2];

export function bottomOf(b) {
  return b.pos[1] - b.half[1];
}

function approach2(v, target, maxDelta) {
  const dx = target[0] - v[0];
  const dz = target[1] - v[1];
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) return [target[0], target[1]];
  return [v[0] + (dx / d) * maxDelta, v[1] + (dz / d) * maxDelta];
}

export function clampExt(b, max) {
  const s = Math.hypot(b.ext[0], b.ext[1]);
  if (s > max) {
    b.ext[0] *= max / s;
    b.ext[1] *= max / s;
  }
}

export class Physics {
  constructor(statics, tuning) {
    this.statics = statics;
    this.groundIds = new Set(statics.filter((s) => s.ground).map((s) => s.id));
    this.t = tuning;
  }

  // 축 하나로 d만큼 이동. 반환: { moved, hit: {type, id} | null }
  moveAxis(b, bodies, axis, d) {
    if (Math.abs(d) < 1e-12) return { moved: 0, hit: null };
    const box = boxOfBody(b);
    const others = [0, 1, 2].filter((i) => i !== axis);
    let allowed = d;
    let hit = null;
    const consider = (o, type, id) => {
      if (overlaps(box, o)) return; // 이미 겹쳐 있으면 빠져나갈 수 있게 무시
      if (!overlapsOnAxes(box, o, others)) return;
      if (d > 0 && o.min[axis] >= box.max[axis] - EPS) {
        const gap = o.min[axis] - box.max[axis];
        if (gap < allowed) { allowed = Math.max(0, gap); hit = { type, id }; }
      } else if (d < 0 && o.max[axis] <= box.min[axis] + EPS) {
        const gap = o.max[axis] - box.min[axis];
        if (gap > allowed) { allowed = Math.min(0, gap); hit = { type, id }; }
      }
    };
    for (const s of this.statics) consider(s, 'static', s.id);
    for (const o of bodies) if (o !== b && !o.ghost) consider(boxOfBody(o), 'body', o.id);
    b.pos[axis] += allowed;
    return { moved: allowed, hit };
  }

  // 위로 이동하면서 위에 얹힌 물체를 밀어 올린다. 정적 지형과 이미 방문한 물체는 천장처럼 막는다.
  moveUp(b, bodies, dy, visited) {
    const box = boxOfBody(b);
    let allowed = dy;
    for (const s of this.statics) {
      if (overlaps(box, s)) continue;
      if (overlapsOnAxes(box, s, XZ) && s.min[1] >= box.max[1] - EPS) {
        allowed = Math.min(allowed, s.min[1] - box.max[1]);
      }
    }
    allowed = Math.max(0, allowed);
    const above = bodies
      .filter((o) => o !== b && !o.ghost)
      .map((o) => ({ o, ob: boxOfBody(o) }))
      .filter(({ ob }) => !overlaps(box, ob) && overlapsOnAxes(box, ob, XZ) && ob.min[1] >= box.max[1] - EPS)
      .sort((p, q) => p.ob.min[1] - q.ob.min[1]);
    for (const { o, ob } of above) {
      if (ob.min[1] >= box.max[1] + allowed) continue;
      if (visited.has(o.id) || o.fixed) {
        allowed = Math.min(allowed, ob.min[1] - box.max[1]);
        continue;
      }
      const need = box.max[1] + allowed - ob.min[1];
      visited.add(b.id);
      this.moveUp(o, bodies, need, visited);
      allowed = Math.min(allowed, bottomOf(o) - box.max[1]);
    }
    allowed = Math.max(0, allowed);
    b.pos[1] += allowed;
    return allowed;
  }

  step(bodies, dt) {
    const T = this.t;
    const byId = new Map(bodies.map((b) => [b.id, b]));

    // 1) 속도 갱신
    for (const b of bodies) {
      if (b.fixed) continue;
      if (b.kind === 'player') {
        const accel = b.grounded ? T.groundAccel : T.airAccel;
        const speed = T.walkSpeed * (b.speedFactor ?? 1); // 디버프(그을림) 등으로 느려질 수 있다
        const target = [b.wish[0] * speed, b.wish[1] * speed];
        b.inVel = approach2(b.inVel, target, accel * dt);
        if (b.jumpBuffer > 0) {
          if (b.grounded && !b.hold) {
            b.vy = T.jumpSpeed;
            b.grounded = false;
            b.jumpBuffer = 0;
          } else {
            b.jumpBuffer -= dt;
          }
        }
      }
      if (b.hold) {
        // 들기: 목표 지점으로 끄는 스프링 + 감쇠. 가속도 상한이 있어 시점을 돌리면 늦게 따라오고,
        // 감쇠가 임계보다 작아 멈춘 뒤 조금 더 움직였다가 돌아온다.
        const h = b.hold;
        const v = [b.ext[0], b.vy, b.ext[1]];
        const a = [0, 1, 2].map((i) => h.k * (h.target[i] - b.pos[i]) - h.c * v[i]);
        const am = Math.hypot(...a);
        if (am > h.amax) for (let i = 0; i < 3; i++) a[i] *= h.amax / am;
        b.ext[0] += a[0] * dt;
        b.vy += a[1] * dt;
        b.ext[1] += a[2] * dt;
        const sp = Math.hypot(b.ext[0], b.vy, b.ext[1]);
        if (sp > T.liftMaxSpeed) { b.ext[0] *= T.liftMaxSpeed / sp; b.vy *= T.liftMaxSpeed / sp; b.ext[1] *= T.liftMaxSpeed / sp; }
      } else {
        // 외부 수평 속도 감속 + 상한
        const decel = b.grounded ? T.extGroundFriction : T.extAirDrag;
        const s = Math.hypot(b.ext[0], b.ext[1]);
        if (s > 0) {
          const ns = Math.max(0, s - decel * dt);
          b.ext[0] *= ns / s;
          b.ext[1] *= ns / s;
        }
        clampExt(b, b.extCap ?? T.pushMaxSpeed);
        b.vy = Math.max(-T.terminalFall, b.vy - T.gravity * dt);
      }
    }

    // 2) 이동: 아래에 있는 물체부터
    const order = [...bodies].sort((p, q) => bottomOf(p) - bottomOf(q));
    const disp = new Map();
    for (const b of order) {
      if (b.fixed) { b.grounded = true; continue; }
      const start = [...b.pos];

      // 받치는 물체가 이번 틱에 움직였다면 따라간다
      const carrier = b.groundId && byId.get(b.groundId);
      if (carrier && disp.has(carrier.id)) {
        const d = disp.get(carrier.id);
        this.moveAxis(b, bodies, 0, d[0]);
        this.moveAxis(b, bodies, 2, d[2]);
        if (d[1] < 0) this.moveAxis(b, bodies, 1, d[1]);
      }

      const vx = b.inVel[0] + b.ext[0];
      const vz = b.inVel[1] + b.ext[1];
      const rx = this.moveAxis(b, bodies, 0, vx * dt);
      if (rx.hit) { b.ext[0] = 0; b.inVel[0] = 0; }
      const rz = this.moveAxis(b, bodies, 2, vz * dt);
      if (rz.hit) { b.ext[1] = 0; b.inVel[1] = 0; }

      const dy = b.vy * dt;
      if (dy > 0) {
        const moved = b.hold
          ? this.moveUp(b, bodies, dy, new Set())
          : this.moveAxis(b, bodies, 1, dy).moved;
        if (moved < dy - 1e-6) b.vy = 0; // 천장
        b.grounded = false;
        b.groundId = null;
      } else {
        const r = this.moveAxis(b, bodies, 1, dy);
        if (r.hit && dy < 0) {
          b.grounded = true;
          b.groundId = r.hit.type === 'body' ? r.hit.id : null;
          b.groundStatic = r.hit.type === 'static' ? r.hit.id : null;
          b.vy = 0;
        } else {
          b.grounded = false;
          b.groundId = null;
          b.groundStatic = null;
        }
      }
      disp.set(b.id, [b.pos[0] - start[0], b.pos[1] - start[1], b.pos[2] - start[2]]);
    }

    // 3) 마지막으로 서 있던 지면(낙하 복구용 안전 위치)
    for (const b of bodies) {
      if (b.grounded && b.groundStatic && this.groundIds.has(b.groundStatic)) {
        b.lastSafe = { ground: b.groundStatic, pos: [b.pos[0], bottomOf(b), b.pos[2]] };
      }
    }
  }
}
