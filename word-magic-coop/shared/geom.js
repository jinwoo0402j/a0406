// AABB·레이캐스트 등 서버와 클라이언트가 함께 쓰는 기하 함수.
// 박스는 { min: [x,y,z], max: [x,y,z] } 형태다.

export const EPS = 1e-6;

export function boxOfBody(b) {
  const [x, y, z] = b.pos;
  const [hx, hy, hz] = b.half;
  return { min: [x - hx, y - hy, z - hz], max: [x + hx, y + hy, z + hz] };
}

export function overlaps(a, b, eps = EPS) {
  return (
    a.min[0] < b.max[0] - eps && a.max[0] > b.min[0] + eps &&
    a.min[1] < b.max[1] - eps && a.max[1] > b.min[1] + eps &&
    a.min[2] < b.max[2] - eps && a.max[2] > b.min[2] + eps
  );
}

export function overlapsOnAxes(a, b, axes, eps = EPS) {
  for (const i of axes) {
    if (!(a.min[i] < b.max[i] - eps && a.max[i] > b.min[i] + eps)) return false;
  }
  return true;
}

export function pointInBox(p, b) {
  return (
    p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[1] <= b.max[1] &&
    p[2] >= b.min[2] && p[2] <= b.max[2]
  );
}

// 슬랩 방식 레이-AABB 교차. 원점이 박스 안이면 0을 반환한다. 맞지 않으면 null.
export function rayBox(origin, dir, box, maxT = Infinity) {
  let tmin = 0;
  let tmax = maxT;
  for (let i = 0; i < 3; i++) {
    const o = origin[i];
    const d = dir[i];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[i] || o > box.max[i]) return null;
    } else {
      let t1 = (box.min[i] - o) / d;
      let t2 = (box.max[i] - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function len(a) { return Math.hypot(a[0], a[1], a[2]); }
export function dist(a, b) { return len(sub(a, b)); }
export function normalize(a) {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0];
}

// 선분 a→b가 정적 지형에 가려지는지. 끝점에 닿는 것은 가림으로 보지 않는다.
export function segmentBlocked(a, b, statics) {
  const d = sub(b, a);
  const l = len(d);
  if (l < 1e-9) return null;
  const dir = scale(d, 1 / l);
  for (const s of statics) {
    const t = rayBox(a, dir, s, l);
    if (t !== null && t < l - 1e-4) return s;
  }
  return null;
}
