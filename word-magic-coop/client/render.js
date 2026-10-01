// three.js 장면. 서버 상태를 그대로 그리며, 판정은 하지 않는다(미리보기 강조 표시만).
import * as THREE from 'three';
import { LEVEL, bodyDefs } from '../shared/level.js';
import { WORDS } from '../shared/words.js';
import { makeLabel } from './labels.js';

const ACTION_COLOR = { PUSH: '#ff9a4d', PULL: '#3fcf8e', LIFT: '#4fd6ff', FIREBALL: '#ff5a2a' };
const KIND_COLOR = { effect: '#ff9a4d', mod: '#9b7bff' }; // 효과 단어 / 수식 단어
const SCORCH = new THREE.Color('#3a2a22');
const now = () => performance.now() / 1000;

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
  // low: 저사양 모드(그림자·안티앨리어싱 끔, 픽셀 비율 1). 주소에 ?gfx=low
  constructor(canvas, { low = false } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !low });
    this.renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !low;
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
    this.projViews = new Map();
    this.tethers = new Map();
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
    for (const d of bodyDefs()) {
      const group = new THREE.Group();
      group.visible = false; // 스냅숏에 있는 것만 보인다(접속한 자리만 캐릭터가 있다)
      const mats = [];
      const std = (color, extra = {}) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
        m.userData.baseEmissive = m.emissive.clone();
        m.userData.baseIntensity = m.emissiveIntensity;
        m.userData.baseColor = m.color.clone();
        mats.push(m);
        return m;
      };
      const h = d.size[1];
      let visual;
      if (d.kind === 'player') {
        visual = new THREE.Group();
        const col = d.color;
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
      } else if (d.kind === 'heavy') {
        // 무거운 상자: <세게> 없이는 들 수 없다
        visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#6d7486', { metalness: 0.3, roughness: 0.5 }));
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(visual.geometry), new THREE.LineBasicMaterial({ color: '#2f3440' }));
        visual.add(edge);
        const tag = makeLabel('무거운 상자', { bg: '#4a5063', size: 36, height: 0.26 });
        tag.position.y = h / 2 + 0.35;
        group.add(tag);
      } else if (d.kind === 'dummy') {
        // 시험용 적(허수아비): 체력 막대
        visual = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h, 8), std('#8a5a2b'));
        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.7, 12), std('#e2c275'));
        torso.position.y = 0.05;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), std('#f0d58a'));
        head.position.y = 0.6;
        const arms = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), std('#8a5a2b'));
        arms.rotation.z = Math.PI / 2;
        arms.position.y = 0.25;
        const eyeMat = new THREE.MeshBasicMaterial({ color: '#2f2a3d' });
        for (const x of [-0.08, 0.08]) {
          const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), eyeMat);
          e.position.set(x, 0.63, 0.21);
          e.rotation.z = x > 0 ? 0.6 : -0.6;
          visual.add(e);
        }
        visual.add(pole, torso, head, arms);
        const bar = new THREE.Group();
        const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.12), new THREE.MeshBasicMaterial({ color: '#2f2a3d', transparent: true, opacity: 0.7, depthWrite: false }));
        const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.08), new THREE.MeshBasicMaterial({ color: '#ff5a5a', depthWrite: false }));
        fill.position.z = 0.001;
        bar.add(bg, fill);
        bar.position.y = h / 2 + 0.3;
        group.add(bar);
        group.userData.hpBar = { bar, fill };
        const tag = makeLabel('허수아비', { bg: '#b0883a', size: 36, height: 0.26 });
        tag.position.y = h / 2 + 0.6;
        group.add(tag);
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

      // 들려 있음 표시 고리
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
      this.bodyViews.set(d.id, { group, visual, mats, ring, shield, def: d, baseScale: visual.scale.clone(), anim: null, smokeAt: 0 });
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
    const label = makeLabel(w.label, { bg: KIND_COLOR[w.kind], size: 56, height: 0.46, border: '#ffffff' });
    label.position.y = 0.75;
    group.add(label);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 32),
      new THREE.MeshBasicMaterial({ color: KIND_COLOR[w.kind], transparent: true, opacity: 0.45, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    group.add(glow);
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.14),
      new THREE.MeshStandardMaterial({ color: KIND_COLOR[w.kind], emissive: KIND_COLOR[w.kind], emissiveIntensity: 0.5 }),
    );
    gem.position.y = 0.3;
    group.add(gem);
    this.scene.add(group);
    v = { group, label, gem, base: label.scale.clone() };
    this.tokenViews.set(id, v);
    return v;
  }

  // 캐릭터 형태 과장: 시전하면 쭉 늘어나고, 맞으면 납작해졌다 튀어 오른다
  poke(id, type) {
    const v = this.bodyViews.get(id);
    if (v) v.anim = { type, t0: now() };
  }

  burst(pos, color, n, speed, up, life = 0.55, size = 0.07) {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 4), new THREE.MeshBasicMaterial({ color, transparent: true }));
      p.position.set(...pos);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const vel = new THREE.Vector3(Math.cos(ang) * speed, up + Math.random() * up, Math.sin(ang) * speed);
      this.scene.add(p);
      this.fx.push({ obj: p, life, age: 0, kind: 'particle', vel });
    }
  }

  beam(a, b, color, life = 0.3) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, a.distanceTo(b), 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    beam.position.copy(a).add(b).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.scene.add(beam);
    this.fx.push({ obj: beam, life, age: 0, kind: 'fade' });
  }

  // 시전 효과: 밀치기·당기기는 빛줄기·튀는 입자, 주변 모드는 퍼지는 고리, 파이어볼은 손끝 불꽃
  castFx(ev, positions) {
    const color = new THREE.Color(ACTION_COLOR[ev.effect] || '#ffffff');
    this.poke(ev.by, 'cast');
    const from = positions.get(ev.by);
    if (!from) return;
    if (ev.effect === 'FIREBALL') {
      const n = ev.mode === 'NEAR' ? 16 : 8;
      this.burst([from[0], from[1] + 0.3, from[2]], color, n, ev.mode === 'NEAR' ? 2.4 : 1.2, 0.8, 0.3, 0.06);
      return;
    }
    if (ev.effect === 'PULL' && ev.anchor) {
      // 지형을 당김: 내 손 → 붙잡은 지점으로 줄
      this.beam(new THREE.Vector3(from[0], from[1] + 0.3, from[2]), new THREE.Vector3(...ev.anchor), color, 0.45);
      this.burst(ev.anchor, color, 10, 1.6, 0.4);
      return;
    }
    if (ev.mode === 'NEAR') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1.0, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(from[0], from[1] - 0.6, from[2]);
      this.scene.add(ring);
      this.fx.push({ obj: ring, life: 0.45, age: 0, kind: 'ring' });
    }
    for (const id of ev.targets || []) {
      const to = positions.get(id);
      if (!to) continue;
      if (id !== ev.by) {
        this.beam(new THREE.Vector3(from[0], from[1] + 0.3, from[2]), new THREE.Vector3(...to), color);
        this.poke(id, 'hit');
      }
      this.burst(to, color, 10, 2.2, 0.6);
    }
  }

  // 파이어볼 명중 폭발(반경 = 실제 판정 반경)
  boomFx(e) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: '#ff7a2a', transparent: true, opacity: 0.6, depthWrite: false }),
    );
    ball.position.set(...e.pos);
    ball.userData.maxScale = e.blast;
    this.scene.add(ball);
    this.fx.push({ obj: ball, life: 0.4, age: 0, kind: 'boom' });
    this.burst(e.pos, new THREE.Color('#ffb347'), 16, 3, 1.5, 0.6, 0.08);
    for (const h of e.hits) this.poke(h.id, 'hit');
  }

  fizzleFx(pos) {
    this.burst(pos, new THREE.Color('#9a9aa8'), 6, 0.6, 0.6, 0.4, 0.06);
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
      } else if (f.kind === 'boom') {
        const sc = 0.2 + (f.obj.userData.maxScale - 0.2) * Math.min(1, k * 1.8);
        f.obj.scale.set(sc, sc, sc);
        f.obj.material.opacity = 0.6 * (1 - k);
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
      v.group.visible = !!s;
      if (!s) continue;
      v.group.position.set(s.p[0], s.p[1], s.p[2]);
      v.visual.rotation.y = s.y || 0;
      // 들려 있으면 고리 표시
      v.ring.visible = !!s.h;
      if (v.ring.visible) v.ring.rotation.z = t * 3;
      // 형태 과장(늘어남·납작해짐) + 들려 있는 동안 흔들림
      let sy = 1;
      let sxz = 1;
      if (v.anim) {
        const e = now() - v.anim.t0;
        const dur = v.anim.type === 'cast' ? 0.35 : 0.45;
        if (e > dur) v.anim = null;
        else if (v.anim.type === 'cast') { const w = Math.sin((Math.PI * e) / dur); sy = 1 + 0.4 * w; sxz = 1 - 0.2 * w; }
        else { const w = Math.sin((Math.PI * e) / dur) * (1 - e / dur); sy = 1 - 0.45 * w; sxz = 1 + 0.3 * w; }
      }
      if (s.h) { sy *= 1 + 0.08 * Math.sin(t * 14); sxz *= 1 - 0.04 * Math.sin(t * 14); }
      // 붙잡혔지만 힘이 모자라 뜨지 못함: 바닥에서 버둥거린다
      v.visual.position.x = s.hv ? Math.sin(t * 40) * 0.04 : 0;
      v.visual.scale.set(v.baseScale.x * sxz, v.baseScale.y * sy, v.baseScale.z * sxz);
      // 그을림(아군 디버프): 색이 어두워지고 연기가 난다
      const scorched = s.d > 0;
      for (const m of v.mats) {
        if (scorched) m.color.copy(m.userData.baseColor).lerp(SCORCH, 0.55);
        else m.color.copy(m.userData.baseColor);
      }
      if (scorched && t - v.smokeAt > 0.15) {
        v.smokeAt = t;
        this.burst([s.p[0], s.p[1] + v.def.size[1] / 2, s.p[2]], new THREE.Color('#5a5560'), 1, 0.3, 0.8, 0.7, 0.09);
      }
      // 허수아비 체력 막대·쓰러짐
      const hpBar = v.group.userData.hpBar;
      if (hpBar) {
        const k = Math.max(0, (s.hp ?? 100) / 100);
        hpBar.fill.scale.x = Math.max(0.001, k);
        hpBar.fill.position.x = -0.43 * (1 - k);
        hpBar.bar.quaternion.copy(this.camera.quaternion);
        v.visual.rotation.x = s.dn ? -Math.PI / 2.2 : 0;
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

    // 범위 표시(주변 모드, <큰>으로 커진 반경)
    const me = frame.bodies.get(frame.me);
    this.nearbyRing.visible = !!(frame.nearby && me);
    if (this.nearbyRing.visible) {
      const def = this.bodyViews.get(frame.me).def;
      this.nearbyRing.position.set(me.p[0], me.p[1] - def.size[1] / 2 + 0.04, me.p[2]);
      this.nearbyRing.scale.set(frame.nearby / 3, frame.nearby / 3, 1);
    }

    // 파이어볼 투사체: 실제 판정 반지름 크기 + 꼬리
    const live = new Set();
    for (const pr of frame.projectiles || []) {
      live.add(pr.id);
      let pv = this.projViews.get(pr.id);
      if (!pv) {
        const core = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffd27a' }));
        const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: '#ff5a2a', transparent: true, opacity: 0.35, depthWrite: false }));
        this.scene.add(core, halo);
        pv = { core, halo, trailAt: 0 };
        this.projViews.set(pr.id, pv);
      }
      pv.core.position.set(...pr.p);
      pv.halo.position.set(...pr.p);
      pv.core.scale.setScalar(pr.r);
      pv.halo.scale.setScalar(pr.r * (1.7 + 0.2 * Math.sin(t * 30)));
      if (t - pv.trailAt > 0.03) {
        pv.trailAt = t;
        this.burst(pr.p, new THREE.Color('#ff8a3d'), 1, 0.2, 0.2, 0.3, pr.r * 0.5);
      }
    }
    for (const [id, pv] of this.projViews) {
      if (live.has(id)) continue;
      this.scene.remove(pv.core, pv.halo);
      this.projViews.delete(id);
    }

    // 들기 연결선: 드는 사람마다 손 → 들린 대상(같이 들면 여러 줄). 힘이 모자라면 붉게.
    const held = new Set();
    for (const [id, s] of frame.bodies) {
      for (const holder of s.h || []) {
        const from = frame.bodies.get(holder);
        if (!from) continue;
        const key = `${id}>${holder}`;
        held.add(key);
        let tv = this.tethers.get(key);
        if (!tv) {
          tv = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 6), new THREE.MeshBasicMaterial({ color: '#4fd6ff', transparent: true, opacity: 0.65, depthWrite: false }));
          this.scene.add(tv);
          this.tethers.set(key, tv);
        }
        const a = new THREE.Vector3(from.p[0], from.p[1] + 0.3, from.p[2]);
        const b = new THREE.Vector3(...s.p);
        tv.visible = true;
        tv.material.color.set(s.hv ? '#ff6b6b' : '#4fd6ff');
        tv.scale.set(1, Math.max(0.01, a.distanceTo(b)), 1);
        tv.position.copy(a).add(b).multiplyScalar(0.5);
        tv.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        tv.material.opacity = 0.45 + 0.2 * Math.sin(t * 12);
      }
    }
    for (const [id, tv] of this.tethers) if (!held.has(id)) tv.visible = false;

    this.flag.rotation.y = Math.sin(t * 2) * 0.25;
    this.goalPad.material.opacity = frame.cleared ? 0.75 : 0.35 + 0.1 * Math.sin(t * 3);

    this.stepFx(dt);
    this.camera.position.set(...frame.camera.pos);
    this.camera.lookAt(...frame.camera.look);
    this.renderer.render(this.scene, this.camera);
  }
}
