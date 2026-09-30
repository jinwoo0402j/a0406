// 3인칭 어깨 너머 카메라. 조준선 = 카메라 위치에서 화면 중앙(십자선) 방향.
import { rayBox } from '../shared/geom.js';
import { LEVEL } from '../shared/level.js';

export const CAM = { dist: 5, shoulder: 0.6, pivotUp: 0.75, minPitch: -1.1, maxPitch: 0.95, pad: 0.25 };

function castStatic(origin, dir, maxT) {
  let best = maxT;
  for (const s of LEVEL.statics) {
    const t = rayBox(origin, dir, s, maxT);
    if (t !== null && t < best) best = t;
  }
  return best;
}

export function cameraRig(center, yaw, pitch) {
  const pivot = [center[0], center[1] + CAM.pivotUp, center[2]];
  const cp = Math.cos(pitch);
  const dir = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
  const right = [-Math.cos(yaw), 0, Math.sin(yaw)];
  const sh = Math.max(0, castStatic(pivot, right, CAM.shoulder + CAM.pad) - CAM.pad);
  const shoulderPt = [pivot[0] + right[0] * sh, pivot[1], pivot[2] + right[2] * sh];
  const back = [-dir[0], -dir[1], -dir[2]];
  const d = Math.max(0.3, castStatic(shoulderPt, back, CAM.dist + CAM.pad) - CAM.pad);
  const pos = [shoulderPt[0] + back[0] * d, shoulderPt[1] + back[1] * d, shoulderPt[2] + back[2] * d];
  return { pos, dir, look: [pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]] };
}
