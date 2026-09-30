// three.js 장면. 서버 상태를 그대로 그리며, 판정은 하지 않는다(미리보기 강조 표시만).
import * as THREE from 'three';
import { LEVEL } from '/shared/level.js';
import { WORDS } from '/shared/words.js';
import { makeLabel } from './labels.js';

const PLAYER_COLOR = { A: '#ff7f73', B: '#5fa8ff' };
const ACTION_COLOR = { PUSH: '#ff9a4d', LIFT: '#4fd6ff' };
const SLOT_COLOR = { target: '#9b7bff', action: '#ff9a4d' };

function checkerTexture(a, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillRect(64, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l * k)));
  return `#${c.getHexString()}`;
}

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#cfe9ff');
    this.scene.fog = new THREE.Fog('#cfe9ff', 40, 110);
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 300);

    const hemi = new THREE.HemisphereLight('#ffffff', '#b8c9a8', 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(12, 28, 4);
    sun.target.position.set(0, 0, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 30, bottom: -30, near: 1, far: 80 });
    sun.shadow.bias = -0.0008;
    this.scene.add(sun, sun.target);

    // 아래쪽 구름 바다(낙하 영역 표시)
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: '#eef6ff' }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -9;
    this.scene.add(sea);

    this.bodyViews = new Map();
    this.tokenViews = new Map();
    this.fx = [];
    this.buildStatics();
    this.buildBodies();
    this.buildRing();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildStatics() {
    for (const s of LEVEL.statics) {
      const size = [s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]];
      const geo = new THREE.BoxGeometry(...size);
      let mat;
      if (s.ground) {
        const tex = checkerTexture(s.color, shade(s.color, 0.93));
        const top = tex.clone();
        top.needsUpdate = true;
        top.repeat.set(size[0] / 2, size[2] / 2);
        const side = new THREE.MeshStandardMaterial({ color: shade(s.color, 0.8), roughness: 0.95 });
        const topMat = new THREE.MeshStandardMaterial({ map: top, roughness: 0.95 });
        mat = [side, side, topMat, side, side, side];
      } else {
        mat = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.85 });
      }
      const m = new THREE.Mesh(geo, mat);
      m.position.set((s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2);
      m.receiveShadow = true;
      m.castShadow = !s.ground;
      this.scene.add(m);
    }

    // 도착 구역
    const g = LEVEL.goal;
    const gs = [g.max[0] - g.min[0], 0.05, g.max[2] - g.min[2]];
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(...gs),
      new THREE.MeshBasicMaterial({ color: '#7be3a4', transparent: true, opacity: 0.45 }),
    );
    pad.position.set((g.min[0] + g.max[0]) / 2, g.min[1] + 0.03, (g.min[2] + g.max[2]) / 2);
    this.scene.add(pad);
    this.goalPad = pad;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(gs[0], 2.2, gs[2])),
      new THREE.LineBasicMaterial({ color: '#3cc47c', transparent: true, opacity: 0.6 }),
    );
    edges.position.set(pad.position.x, g.min[1] + 1.1, pad.position.z);
    this.scene.add(edges);
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4), new THREE.MeshStandardMaterial({ color: '#ffffff' }));
    flagPole.position.set(g.max[0] - 0.3, g.min[1] + 1.2, g.max[2] - 0.3);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshStandardMaterial({ color: '#ff8a3d', side: THREE.DoubleSide }));
    flag.position.set(flagPole.position.x - 0.45, g.min[1] + 2.1, flagPole.position.z);
    this.flag = flag;
    this.scene.add(flagPole, flag);

    for (const l of LEVEL.labels) {
      const sprite = makeLabel(l.text, { bg: 'rgba(255,255,255,0.85)', fg: '#5b4a8a', size: 64, height: 0.7, radius: 30 });
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(sprite.scale.x, sprite.scale.y),
        new THREE.MeshBasicMaterial({ map: sprite.material.map, transparent: true }),
      );
      sign.position.set(...l.pos);
      sign.rotation.y = l.yaw || 0;
      this.scene.add(sign);
    }
  }

  buildBodies() {
    for (const d of LEVEL.bodies) {
      const group = new THREE.Group();
      const mats = [];
      const std = (color, extra = {}) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
        m.userData.baseEmissive = m.emissive.clone();
        m.userData.baseIntensity = m.emissiveIntensity;
        mats.push(m);
        return m;
      };
      const h = d.size[1];
      let visual;
      if (d.kind === 'player') {
        visual = new THREE.Group();
        const col = PLAYER_COLOR[d.id];
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), std(col));
        body.scale.set(1, 0.95, 1);
        body.position.y = -h / 2 + 0.4;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.33, 24, 16), std(shade(col, 1.12)));
        head.position.y = -h / 2 + 0.95;
        const eyeMat = new THREE.MeshBasicMaterial({ color: '#2f2a3d' });
        const cheekMat = new THREE.MeshBasicMaterial({ color: '#ffb3c1' });
        const mkEye = (x) => {
          const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), eyeMat);
          e.position.set(x, 0.03, 0.3);
          e.scale.set(1, 1.4, 0.6);
          return e;
        };
        const mkCheek = (x) => {
          const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), cheekMat);
          e.position.set(x, -0.07, 0.29);
          e.scale.set(1.3, 0.7, 0.4);
          return e;
        };
        head.add(mkEye(-0.11), mkEye(0.11), mkCheek(-0.18), mkCheek(0.18));
        const hat = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 20), std(shade(col, 0.75)));
        hat.position.y = 0.38;
        hat.rotation.z = 0.15;
        head.add(hat);
        const feet = [-0.17, 0.17].map((x) => {
          const f = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), std(shade(col, 0.7)));
          f.scale.set(1, 0.6, 1.3);
          f.position.set(x, -h / 2 + 0.06, 0.05);
          return f;
        });
        visual.add(body, head, ...feet);
        const tag = makeLabel(d.id, { bg: col, size: 44, height: 0.34 });
        tag.position.y = h / 2 + 0.45;
        group.add(tag);
        group.userData.tag = tag;
      } else if (d.kind === 'rock') {
        visual = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), std('#a3a3b5', { flatShading: true }));
        visual.scale.set(1, 0.85, 1);
      } else if (d.kind === 'box') {
        visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#d19a5f'));
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(visual.geometry), new THREE.LineBasicMaterial({ color: '#8a5a2b' }));
        visual.add(edge);
      } else {
        // 목표 짐: 표식이 있는 금색 상자
        visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#ffcf4a'));
        const band = new THREE.Mesh(new THREE.BoxGeometry(d.size[0] + 0.02, 0.18, d.size[2] + 0.02), std('#ff8a3d'));
        visual.add(band);
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), std('#ff8a3d', { emissive: '#ff8a3d', emissiveIntensity: 0.3 }));
        star.position.y = d.size[1] / 2 + 0.35;
        visual.add(star);
        group.userData.star = star;
        const tag = makeLabel('짐', { bg: '#ff8a3d', size: 40, height: 0.3 });
        tag.position.y = h / 2 + 0.9;
        group.add(tag);
      }
      visual.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      group.add(visual);

      // 부양 표시 고리
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(d.size[0], d.size[2]) * 0.7, 0.045, 8, 32),
        new THREE.MeshBasicMaterial({ color: ACTION_COLOR.LIFT, transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -h / 2 - 0.08;
      ring.visible = false;
      group.add(ring);

      // 보호 상태 방패
      let shield = null;
      if (d.kind === 'player') {
        shield = new THREE.Mesh(
          new THREE.SphereGeometry(0.95, 24, 16),
          new THREE.MeshBasicMaterial({ color: '#b9a8ff', transparent: true, opacity: 0.28, depthWrite: false }),
        );
        shield.visible = false;
        group.add(shield);
      }

      this.scene.add(group);
      this.bodyViews.set(d.id, { group, visual, mats, ring, shield, def: d, highlight: null });
    }
  }

  buildRing() {
    // 「주변의 대상들을」 반경 표시
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.92, 3.0, 64),
      new THREE.MeshBasicMaterial({ color: '#9b7bff', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    const disk = new THREE.Mesh(
      new THREE.CircleGeometry(3, 64),
      new THREE.MeshBasicMaterial({ color: '#9b7bff', transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.add(disk);
    this.scene.add(ring);
    this.nearbyRing = ring;
  }

  tokenView(id, word) {
    let v = this.tokenViews.get(id);
    if (v) return v;
    const w = WORDS[word];
    const group = new THREE.Group();
    const label = makeLabel(w.label, { bg: SLOT_COLOR[w.slot], size: 56, height: 0.46, border: '#ffffff' });
    label.position.y = 0.75;
    group.add(label);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 32),
      new THREE.MeshBasicMaterial({ color: SLOT_COLOR[w.slot], transparent: true, opacity: 0.45, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    group.add(glow);
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.14),
      new THREE.MeshStandardMaterial({ color: SLOT_COLOR[w.slot], emissive: SLOT_COLOR[w.slot], emissiveIntensity: 0.5 }),
    );
    gem.position.y = 0.3;
    group.add(gem);
    this.scene.add(group);
    v = { group, label, gem, base: label.scale.clone() };
    this.tokenViews.set(id, v);
    return v;
  }

  // 시전 효과: 시전자 → 대상 빛줄기 + 대상 반짝임, 범위 주문은 퍼지는 고리
  castFx(ev, positions) {
    const color = new THREE.Color(ACTION_COLOR[ev.action] || '#ffffff');
    const from = positions.get(ev.by);
    if (!from) return;
    if (ev.target === 'NEARBY') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1.0, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(from[0], from[1] - 0.6, from[2]);
      this.scene.add(ring);
      this.fx.push({ obj: ring, life: 0.45, age: 0, kind: 'ring' });
    }
    for (const id of ev.targets) {
      const to = positions.get(id);
      if (!to) continue;
      if (id !== ev.by) {
        const a = new THREE.Vector3(from[0], from[1] + 0.3, from[2]);
        const b = new THREE.Vector3(...to);
        const len = a.distanceTo(b);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.05, len, 6),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
        );
        beam.position.copy(a).add(b).multiplyScalar(0.5);
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        this.scene.add(beam);
        this.fx.push({ obj: beam, life: 0.3, age: 0, kind: 'fade' });
      }
      for (let i = 0; i < 10; i++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshBasicMaterial({ color, transparent: true }));
        p.position.set(...to);
        const ang = (i / 10) * Math.PI * 2;
        const vel = ev.action === 'LIFT'
          ? new THREE.Vector3(Math.cos(ang) * 0.8, 2 + Math.random(), Math.sin(ang) * 0.8)
          : new THREE.Vector3(Math.cos(ang) * 2.2, 0.6 + Math.random() * 0.6, Math.sin(ang) * 2.2);
        this.scene.add(p);
        this.fx.push({ obj: p, life: 0.55, age: 0, kind: 'particle', vel });
      }
    }
  }

  releaseFx(pos) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.75, 40),
      new THREE.MeshBasicMaterial({ color: '#b9a8ff', transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.position.set(pos[0], pos[1], pos[2]);
    ring.lookAt(this.camera.position);
    this.scene.add(ring);
    this.fx.push({ obj: ring, life: 0.4, age: 0, kind: 'ring' });
  }

  stepFx(dt) {
    this.fx = this.fx.filter((f) => {
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) {
        this.scene.remove(f.obj);
        f.obj.geometry.dispose();
        f.obj.material.dispose();
        return false;
      }
      if (f.kind === 'ring') {
        const s = 1 + k * 3;
        f.obj.scale.set(s, s, s);
        f.obj.material.opacity = 0.8 * (1 - k);
      } else if (f.kind === 'particle') {
        f.obj.position.addScaledVector(f.vel, dt);
        f.vel.y -= 3 * dt;
        f.obj.material.opacity = 1 - k;
      } else {
        f.obj.material.opacity = 0.9 * (1 - k);
      }
      return true;
    });
  }

  // frame: { bodies: Map(id → {p,y,f,i}), tokens: [{id,w,o,p}], me, preview: {ok:Set, bad:Set}, nearby, camera: {pos, look}, cleared }
  render(frame, dt, t) {
    for (const [id, v] of this.bodyViews) {
      const s = frame.bodies.get(id);
      if (!s) continue;
      v.group.position.set(s.p[0], s.p[1], s.p[2]);
      v.visual.rotation.y = s.y || 0;
      v.ring.visible = s.f > 0;
      if (v.ring.visible) {
        v.ring.rotation.z = t * 3;
        v.ring.material.opacity = s.f < 0.6 ? 0.4 + 0.4 * Math.abs(Math.sin(t * 16)) : 0.85;
      }
      if (v.shield) {
        v.shield.visible = s.i > 0;
        v.shield.material.opacity = 0.18 + 0.1 * Math.sin(t * 8);
      }
      if (v.def.kind === 'player') {
        // 걷는 느낌의 가벼운 흔들림
        const moving = s.speed > 0.5 && s.g;
        v.visual.position.y = moving ? Math.abs(Math.sin(t * 12)) * 0.06 : 0;
        v.group.userData.tag.visible = id !== frame.me; // 내 이름표는 시야를 가리므로 숨긴다
      }
      if (v.group.userData.star) v.group.userData.star.rotation.y = t * 1.5;
      const hl = frame.preview?.ok.has(id) ? 'ok' : frame.preview?.bad.has(id) ? 'bad' : null;
      for (const m of v.mats) {
        if (hl === 'ok') { m.emissive.set('#ffd84d'); m.emissiveIntensity = 0.35 + 0.2 * Math.sin(t * 10); }
        else if (hl === 'bad') { m.emissive.set('#ff4040'); m.emissiveIntensity = 0.3; }
        else { m.emissive.copy(m.userData.baseEmissive); m.emissiveIntensity = m.userData.baseIntensity; }
      }
    }

    // 월드의 단어 토큰
    const seen = new Set();
    for (const tk of frame.tokens) {
      if (!tk.p) continue;
      seen.add(tk.id);
      const v = this.tokenView(tk.id, tk.w);
      v.group.visible = true;
      v.group.position.set(tk.p[0], tk.p[1], tk.p[2]);
      v.label.position.y = 0.8 + Math.sin(t * 2 + tk.id.charCodeAt(1)) * 0.08;
      v.gem.rotation.y = t * 2;
      v.label.material.opacity = frame.pickable === tk.id ? 1 : 0.92;
      const k = frame.pickable === tk.id ? 1.15 : 1;
      v.label.scale.set(v.base.x * k, v.base.y * k, 1);
    }
    for (const [id, v] of this.tokenViews) if (!seen.has(id)) v.group.visible = false;

    // 범위 표시
    const me = frame.bodies.get(frame.me);
    this.nearbyRing.visible = !!(frame.nearby && me);
    if (this.nearbyRing.visible) {
      const def = this.bodyViews.get(frame.me).def;
      this.nearbyRing.position.set(me.p[0], me.p[1] - def.size[1] / 2 + 0.04, me.p[2]);
    }

    this.flag.rotation.y = Math.sin(t * 2) * 0.25;
    this.goalPad.material.opacity = frame.cleared ? 0.75 : 0.35 + 0.1 * Math.sin(t * 3);

    this.stepFx(dt);
    this.camera.position.set(...frame.camera.pos);
    this.camera.lookAt(...frame.camera.look);
    this.renderer.render(this.scene, this.camera);
  }
}
