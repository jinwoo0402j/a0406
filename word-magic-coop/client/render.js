// three.js 장면. 서버 상태를 그대로 그리며, 판정은 하지 않는다(미리보기 강조 표시만).
import * as THREE from 'three';
import { LEVEL, bodyDefs } from '../shared/level.js';
import { WORDS } from '../shared/words.js';
import { makeLabel, iconPlate } from './labels.js';
import { objectVisual } from './objects.js';
import { EFFECT_ICON } from './icons.js';
import {
  bendTree, toon, toonShared, grassTexture, cliffTexture, sandTexture, starTexture, puffTexture,
  skyDome, cloud, water, stepWater, roundTree, palmTree, bush, flowers, mergeStatic, firstHands,
} from './look.js';

const ACTION_COLOR = { PUSH: '#ff9f6e', PULL: '#45c2ad', LIFT: '#6fd3ff', FIREBALL: '#ff7a3d', WATER: '#5fb8ff', FIRE: '#ff6a3d', STEAM: '#eef4f8' };
const KIND_COLOR = { effect: '#ff9f6e', mod: '#a98bff' }; // 효과 단어 / 수식 단어(HUD와 같은 색)
const SCORCH = new THREE.Color('#4a3a32');
const WATER_Y = -1.0;
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
    this.pixelRatio = low ? 1 : Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.perf = { acc: 0, frames: 0, level: 0 }; // 자동 화질 조절(느리면 해상도·그림자를 낮춘다)
    this.renderer.shadowMap.enabled = !low;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.low = low;

    this.scene = new THREE.Scene();
    // 모든 재질에 지면 휨(rolling log)을 건다(표시 전용)
    const add = this.scene.add.bind(this.scene);
    this.scene.add = (...objs) => { for (const o of objs) bendTree(o); return add(...objs); };
    this.scene.background = new THREE.Color('#bfe7fb');
    this.scene.fog = new THREE.Fog('#d9f1fb', 45, 140);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    this.scene.add(skyDome());

    // 동숲처럼 따뜻하고 밝은 빛: 하늘빛·풀빛 반사 + 따뜻한 햇빛
    const hemi = new THREE.HemisphereLight('#fff8ea', '#a6d77f', 1.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d6', 2.0);
    sun.position.set(12, 28, 4);
    sun.target.position.set(0, 0, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 30, bottom: -30, near: 1, far: 80 });
    sun.shadow.bias = -0.0008;
    this.scene.add(sun, sun.target);

    // 섬 둘레 바다와 하늘의 뭉게구름
    this.scene.add(water());
    const sky = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const c = cloud(i * 7 + 3);
      const a = (i / 9) * Math.PI * 2;
      c.position.set(Math.cos(a) * 120, 26 + (i % 3) * 6, 18 + Math.sin(a) * 120);
      sky.add(c);
    }
    this.clouds = [mergeStatic(sky)];
    this.clouds[0].position.set(0, 0, 0);
    this.scene.add(this.clouds[0]);

    this.bodyViews = new Map();
    this.tokenViews = new Map();
    this.projViews = new Map();
    this.tethers = new Map();
    this.fx = [];
    this.buildStatics();
    this.buildBodies();
    this.buildRing();
    this.buildHandScene();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.handCam) {
      this.handCam.aspect = w / h;
      this.handCam.updateProjectionMatrix();
    }
  }

  // 1인칭 손: 따로 된 작은 장면을 본 장면 위에 그린다(깊이만 지우고) → 벽에 가까이 가도 손이 파묻히지 않는다
  buildHandScene() {
    this.handScene = new THREE.Scene();
    this.handCam = new THREE.PerspectiveCamera(60, 1, 0.01, 5);
    this.handScene.add(new THREE.HemisphereLight('#fff8ea', '#a6d77f', 1.9));
    const sun = new THREE.DirectionalLight('#fff1d6', 1.6);
    sun.position.set(0.6, 1, 0.4);
    this.handScene.add(sun);
    this.hands = new Map(); // 자리별 손(혼자 해보기에서 캐릭터를 바꾸면 손도 바뀐다)
    // 손에 든 효과 단어: 오른손 위의 작은 구슬 + 이름표
    this.heldOrb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.heldHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color: '#ffffff', transparent: true, depthWrite: false, opacity: 0.9 }));
    this.heldHalo.scale.setScalar(0.06);
    this.handScene.add(this.heldOrb, this.heldHalo);
    this.heldLabels = new Map();
    this.handAnim = null;
    this.handPhase = 0;
    this.handSway = [0, 0];
    this.liftK = 0;
    this.lastLook = null;
  }

  // 손 동작: cast(오른손 내밀기) · lift(두 손 내밀기) · throw(오른손 휙) · grab(왼손 쥐기)
  handPoke(type) {
    this.handAnim = { type, t0: now() };
  }

  handsFor(seat) {
    let h = this.hands.get(seat);
    if (!h) {
      const def = this.bodyViews.get(seat)?.def;
      h = firstHands(seat, def?.color || '#ff7f73');
      this.handScene.add(h.group);
      this.hands.set(seat, h);
    }
    return h;
  }

  heldLabel(word) {
    let l = this.heldLabels.get(word);
    if (!l) {
      const w = WORDS[word];
      l = iconPlate([EFFECT_ICON[word]], { bg: KIND_COLOR[w.kind], round: true, height: 0.04, border: '#ffffff' }); // 이름은 왼쪽 위 주문 칸에만
      l.material.depthTest = false;
      l.renderOrder = 2;
      this.handScene.add(l);
      this.heldLabels.set(word, l);
    }
    return l;
  }

  // frame.hand: { word, holding, strained, speed, grounded }
  updateHands(frame, dt, t) {
    const show = !!(frame.first && frame.me && this.bodyViews.get(frame.me));
    for (const [seat, h] of this.hands) h.group.visible = show && seat === frame.me;
    for (const l of this.heldLabels.values()) l.visible = false;
    this.heldOrb.visible = this.heldHalo.visible = false;
    if (!show) return false;
    const H = this.handsFor(frame.me);
    H.group.visible = true;
    const hd = frame.hand || {};
    // 걷기 흔들림
    const moving = (hd.speed || 0) > 0.5 && hd.grounded;
    this.handPhase += dt * (moving ? Math.min(14, 4 + hd.speed * 2.2) : 0);
    const bob = moving ? -Math.abs(Math.sin(this.handPhase)) * 0.022 : Math.sin(t * 2) * 0.006;
    const swing = moving ? Math.sin(this.handPhase) * 0.016 : 0;
    // 시점을 돌리면 손이 살짝 늦게 따라온다
    const dir = new THREE.Vector3(...frame.camera.look).sub(new THREE.Vector3(...frame.camera.pos)).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    if (this.lastLook && dt > 0) {
      let dy = yaw - this.lastLook[0];
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const tx = Math.max(-0.05, Math.min(0.05, (dy / dt) * 0.012));
      const ty = Math.max(-0.04, Math.min(0.04, ((pitch - this.lastLook[1]) / dt) * -0.01));
      const k = Math.min(1, dt * 8);
      this.handSway[0] += (tx - this.handSway[0]) * k;
      this.handSway[1] += (ty - this.handSway[1]) * k;
    }
    this.lastLook = [yaw, pitch];
    // 들기 유지 중: 두 손을 들어 손바닥을 앞으로
    this.liftK += ((hd.holding ? 1 : 0) - this.liftK) * Math.min(1, dt * 10);
    const L = this.liftK;
    const shake = hd.strained ? Math.sin(t * 40) * 0.006 : 0;
    let anim = null;
    if (this.handAnim) {
      const e = now() - this.handAnim.t0;
      const dur = { cast: 0.3, lift: 0.3, throw: 0.35, grab: 0.3 }[this.handAnim.type] || 0.3;
      if (e > dur) this.handAnim = null;
      else anim = { type: this.handAnim.type, w: Math.sin((Math.PI * e) / dur) };
    }
    for (const [hand, sx] of [[H.left, -1], [H.right, 1]]) {
      // 평소: 화면 아래 양쪽 구석(핫바 옆), 팔뚝은 아래·바깥으로. 들기: 두 손을 올려 손바닥을 앞으로
      let x = sx * (0.3 - 0.05 * L) + this.handSway[0] + swing * sx;
      let y = -0.205 + bob + 0.07 * L + this.handSway[1];
      let z = -0.52 - 0.04 * L;
      let rx = 0.55 + 0.85 * L;
      let sc = 1;
      if (anim) {
        const { type, w } = anim;
        if ((type === 'cast' && sx > 0) || type === 'lift') { z -= 0.15 * w; y += 0.06 * w; x -= sx * 0.05 * w; rx += 0.6 * w; }
        if (type === 'throw' && sx > 0) { z -= 0.1 * w; y += 0.1 * w; rx -= 0.6 * w; }
        if (type === 'grab' && sx < 0) { y += 0.04 * w; sc = 1 + 0.25 * w; }
      }
      hand.position.set(x + shake, y, z);
      hand.rotation.set(rx, sx * 0.35 * (1 - L), sx * 0.1);
      hand.scale.setScalar(sc * 0.68); // 화면을 가리지 않게 작게
    }
    // 오른손에 든 효과 단어
    if (hd.word && WORDS[hd.word]) {
      const r = H.right.position;
      const glow = 1 + 0.12 * Math.sin(t * 6);
      // 손 위에 단어 기호 배지 + 뒤에서 도는 반짝이(이름 글자는 왼쪽 위 주문 칸에만)
      const lab = this.heldLabel(hd.word);
      lab.visible = true;
      lab.position.set(r.x - 0.01, r.y + 0.085 + 0.04 * L, r.z - 0.045);
      this.heldHalo.visible = true;
      this.heldHalo.material.color.set(ACTION_COLOR[hd.word] || '#ffffff');
      this.heldHalo.position.copy(lab.position).add(new THREE.Vector3(0, 0, -0.002));
      this.heldHalo.scale.setScalar(0.07 * glow);
      this.heldHalo.material.rotation = t * 1.5;
    }
    return true;
  }

  buildStatics() {
    this.deco = new THREE.Group(); // 움직이지 않는 장식: 다 만든 뒤 재질별로 합친다
    const grassTex = grassTexture();
    const cliffTex = cliffTexture();
    const cliff = (sx, sy) => {
      const t = cliffTex.clone();
      t.needsUpdate = true;
      t.repeat.set(Math.max(1, sx / 2), Math.max(1, sy / 2));
      return toon('#ffffff', { map: t });
    };
    for (const s of LEVEL.statics) {
      const size = [s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]];
      const center = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2];
      if (s.id.startsWith('hedge')) {
        // 울타리 → 동글동글한 덤불(충돌은 원래 상자 그대로)
        const b = bush(size[0], s.min[0] < 0 ? 3 : 9);
        b.position.set(center[0], s.min[1], center[2]);
        this.deco.add(b);
        continue;
      }
      let mat;
      if (s.ground) {
        // 땅: 윗면은 풀밭, 옆면은 흙 절벽
        const top = grassTex.clone();
        top.needsUpdate = true;
        top.repeat.set(size[0] / 4, size[2] / 4);
        const topMat = toon(s.id === 'plateau' ? '#f4ffe0' : '#ffffff', { map: top });
        const sideX = cliff(size[2], size[1]);
        const sideZ = cliff(size[0], size[1]);
        mat = [sideX, sideX, topMat, toon('#c99a66'), sideZ, sideZ];
      } else if (s.id.startsWith('wall')) {
        // 벽 → 풀이 덮인 언덕 절벽
        mat = cliff(Math.max(size[0], size[2]), size[1]);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(size[0] + 0.3, 0.35, size[2] + 0.3), toonShared('#7fcd5c'));
        cap.position.set(center[0], s.max[1] + 0.1, center[2]);
        cap.castShadow = true;
        this.deco.add(cap);
      } else {
        // 낮은 턱: 둥근 돌 디딤판
        mat = toon('#d9d3c4');
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
      m.position.set(...center);
      m.receiveShadow = true;
      m.castShadow = !s.ground;
      this.scene.add(m);
    }
    this.buildSnow();
    this.buildIsland();
    this.scene.add(mergeStatic(this.deco));
    // 도착 구역
    const g = LEVEL.goal;
    const gs = [g.max[0] - g.min[0], 0.05, g.max[2] - g.min[2]];
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(...gs),
      new THREE.MeshBasicMaterial({ color: '#9ff0c4', transparent: true, opacity: 0.45 }),
    );
    pad.position.set((g.min[0] + g.max[0]) / 2, g.min[1] + 0.03, (g.min[2] + g.max[2]) / 2);
    this.scene.add(pad);
    this.goalPad = pad;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(gs[0], 2.2, gs[2])),
      new THREE.LineBasicMaterial({ color: '#45c2ad', transparent: true, opacity: 0.45 }),
    );
    edges.position.set(pad.position.x, g.min[1] + 1.1, pad.position.z);
    this.scene.add(edges);
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4), toon('#ffffff'));
    flagPole.position.set(g.max[0] - 0.3, g.min[1] + 1.2, g.max[2] - 0.3);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), toon('#ff9f6e', { side: THREE.DoubleSide }));
    flag.position.set(flagPole.position.x - 0.45, g.min[1] + 2.1, flagPole.position.z);
    this.flag = flag;
    this.scene.add(flagPole, flag);

    for (const l of LEVEL.labels) {
      // 나무 표지판 느낌: 글 대신 기호
      const plate = iconPlate(l.icons, { bg: '#f3dcae', fg: '#6b563c', border: '#c99a66', height: 1.1, sprite: false });
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(plate.width, plate.height),
        new THREE.MeshBasicMaterial({ map: plate.texture, transparent: true }),
      );
      sign.position.set(...l.pos);
      sign.rotation.y = l.yaw || 0;
      this.scene.add(sign);
    }
  }

  // 섬: 모래사장, 나무·야자수, 꽃밭(표시 전용, 충돌 없음)
  buildIsland() {
    const sandTex = sandTexture();
    sandTex.repeat.set(12, 24);
    const beach = new THREE.Mesh(new THREE.BoxGeometry(26, 0.6, 52), toon('#ffffff', { map: sandTex }));
    beach.position.set(0, -0.95, 18);
    beach.receiveShadow = true;
    this.scene.add(beach);
    if (this.low) return;
    const deco = this.deco;
    let seed = 1;
    // 벽(언덕) 바깥쪽 둥근 나무
    for (let z = -1; z <= 25; z += 4.2) {
      for (const x of [-10.2, 10.2]) {
        const t = roundTree(seed++, 1.1);
        t.position.set(x + Math.sin(z) * 0.5, -0.65, z);
        deco.add(t);
      }
    }
    for (let x = -7.5; x <= 7.5; x += 3.6) {
      const t = roundTree(seed++, 1.2);
      t.position.set(x, -0.65, -4.2);
      deco.add(t);
    }
    // 도착 쪽 모래사장의 야자수
    for (const [x, z] of [[-9.5, 31], [9.6, 33.5], [-8.6, 39], [8.4, 40.5], [0, 42.5]]) {
      const p = palmTree(seed++);
      p.position.set(x, -0.65, z);
      deco.add(p);
    }
    // 꽃밭: 벽 가장자리와 단차 위 모퉁이
    const spots = [];
    let r = 17;
    const rnd = () => { r = (r * 16807) % 2147483647; return (r - 1) / 2147483646; };
    for (let i = 0; i < 46; i++) {
      const side = i % 2 ? 1 : -1;
      spots.push([side * (6.4 + rnd() * 1.4), 0, -1 + rnd() * 23]);
    }
    for (let i = 0; i < 16; i++) spots.push([(i % 2 ? 1 : -1) * (4.2 + rnd() * 1.5), 1.6, 36.2 + rnd() * 1.6]);
    deco.add(flowers(spots));
  }

  // 추운 곳(눈밭): 바닥에 눈 덮개 + 눈 더미. 여기에 닿은 물은 얼음이 된다
  buildSnow() {
    let r = 7;
    const rnd = () => { r = (r * 16807) % 2147483647; return (r - 1) / 2147483646; };
    for (const z of LEVEL.zones || []) {
      if (z.kind !== 'cold') continue;
      const w = z.max[0] - z.min[0];
      const d = z.max[2] - z.min[2];
      const snow = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), toon('#f7fbff'));
      snow.position.set((z.min[0] + z.max[0]) / 2, 0.02, (z.min[2] + z.max[2]) / 2);
      snow.receiveShadow = true;
      this.scene.add(snow);
      for (let i = 0; i < 9; i++) {
        const lump = new THREE.Mesh(new THREE.SphereGeometry(0.25 + rnd() * 0.25, 10, 8), toonShared('#ffffff'));
        lump.scale.y = 0.45;
        lump.position.set(z.min[0] + 0.3 + rnd() * (w - 0.6), 0.04, z.min[2] + 0.3 + rnd() * (d - 0.6));
        this.deco.add(lump);
      }
      const tag = iconPlate(['snow'], { bg: '#8fc6ee', round: true, height: 0.5, border: '#ffffff' }); // 추운 곳
      tag.position.set((z.min[0] + z.max[0]) / 2, 1.6, z.min[2] + 0.3);
      this.scene.add(tag);
    }
  }

  buildBodies() {
    for (const d of bodyDefs()) {
      const group = new THREE.Group();
      group.visible = false; // 스냅숏에 있는 것만 보인다(접속한 자리만 캐릭터가 있다)
      const mats = [];
      const std = (color, extra = {}) => {
        const { roughness, metalness, flatShading, ...rest } = extra; // 툰 재질에는 금속감·거칠기가 없다
        const m = toon(color, { flatShading: !!flatShading, ...rest });
        m.userData.baseEmissive = m.emissive.clone();
        m.userData.baseIntensity = m.emissiveIntensity;
        m.userData.baseColor = m.color.clone();
        mats.push(m);
        return m;
      };
      const h = d.size[1];
      const visual = objectVisual(d, std, group);
      visual.traverse((o) => { if (o.isMesh) { o.castShadow = d.kind !== 'steamcloud'; o.receiveShadow = true; } });
      group.add(visual);

      // 들려 있음 표시 고리
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(d.size[0], d.size[2]) * 0.7, 0.045, 8, 32),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }),
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
      this.bodyViews.set(d.id, { group, visual, mats, ring, shield, def: d, baseScale: visual.scale.clone(), anim: null, smokeAt: 0, phase: 0, dustAt: 0, wasG: true, wasAbove: true });
    }
  }

  buildRing() {
    // 「주변의 대상들을」 반경 표시
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.88, 3.0, 64),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    const disk = new THREE.Mesh(
      new THREE.CircleGeometry(3, 64),
      new THREE.MeshBasicMaterial({ color: '#fff3a8', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.add(disk);
    this.scene.add(ring);
    this.nearbyRing = ring;
  }

  // 바닥의 단어: 동숲에서 떨어진 물건처럼 잎사귀 + 위에 단어 이름표
  tokenView(id, word) {
    let v = this.tokenViews.get(id);
    if (v) return v;
    const w = WORDS[word];
    const group = new THREE.Group();
    const label = makeLabel(w.label, { bg: KIND_COLOR[w.kind], size: 56, height: 0.46, border: '#ffffff' });
    label.position.y = 0.8;
    group.add(label);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.32, 24),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.12, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);
    const gem = new THREE.Group();
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), toon(KIND_COLOR[w.kind]));
    leaf.scale.set(1, 0.35, 1.45);
    gem.add(leaf);
    gem.position.y = 0.28;
    gem.rotation.x = 0.35;
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

  // 반짝이 별(동숲 효과처럼 통통 튀어 나간다)
  burst(pos, color, n, speed, up, life = 0.55, size = 0.07) {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color, transparent: true, depthWrite: false }));
      p.scale.setScalar(size * 4.2);
      p.userData.base = size * 4.2;
      p.position.set(...pos);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const vel = new THREE.Vector3(Math.cos(ang) * speed, up + Math.random() * up, Math.sin(ang) * speed);
      this.scene.add(p);
      this.fx.push({ obj: p, life, age: 0, kind: 'particle', vel });
    }
  }

  // 빛줄기 대신 별 몇 개가 줄지어 날아간다
  beam(a, b, color, life = 0.35) {
    const n = Math.max(3, Math.round(a.distanceTo(b) / 0.6));
    for (let i = 1; i <= n; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color, transparent: true, depthWrite: false }));
      p.position.copy(a).lerp(b, i / (n + 1));
      p.scale.setScalar(0.28);
      p.userData.base = 0.28;
      this.scene.add(p);
      this.fx.push({ obj: p, life: life + i * 0.03, age: -i * 0.025, kind: 'twinkle' });
    }
  }

  // 뭉게 연기(걸을 때 먼지, 착지, 폭발, 물보라)
  puffs(pos, n, { color = '#ffffff', size = 0.35, spread = 0.3, rise = 0.6, life = 0.6, opacity = 0.9 } = {}) {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color, transparent: true, opacity, depthWrite: false }));
      const a = (i / n) * Math.PI * 2 + Math.random();
      p.position.set(pos[0] + Math.cos(a) * spread * Math.random(), pos[1], pos[2] + Math.sin(a) * spread * Math.random());
      p.scale.setScalar(size);
      this.scene.add(p);
      this.fx.push({ obj: p, life: life * (0.8 + Math.random() * 0.4), age: 0, kind: 'puff', base: size, op: opacity,
        vel: new THREE.Vector3(Math.cos(a) * spread * 1.5, rise * (0.6 + Math.random() * 0.6), Math.sin(a) * spread * 1.5) });
    }
  }

  // 물에 빠짐: 물보라
  splashFx(pos) {
    this.puffs([pos[0], -0.95, pos[2]], 10, { color: '#e8fbff', size: 0.6, spread: 0.6, rise: 2.2, life: 0.7 });
    this.burst([pos[0], -0.9, pos[2]], new THREE.Color('#9fe6f5'), 8, 2, 2.5, 0.6, 0.08);
  }

  // 단어를 주움: 반짝
  pickupFx(pos) {
    this.burst(pos, new THREE.Color('#ffe066'), 10, 1.4, 1.2, 0.6, 0.07);
  }

  // 시전 효과: 밀치기·당기기는 빛줄기·튀는 입자, 주변 모드는 퍼지는 고리, 파이어볼은 손끝 불꽃
  castFx(ev, positions) {
    const color = new THREE.Color(ACTION_COLOR[ev.effect] || '#ffffff');
    this.poke(ev.by, 'cast');
    const from = positions.get(ev.by);
    if (!from) return;
    if (ev.effect === 'FIREBALL' || (ev.effect === 'WATER' && ev.mode !== 'SELF')) {
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
      if (ev.effect === 'STEAM') this.puffs([to[0], to[1] - 0.5, to[2]], 8, { color: '#ffffff', size: 0.7, spread: 0.4, rise: 2.5, life: 0.9 });
      if (ev.effect === 'FIRE') this.puffs(to, 5, { color: '#ffb36b', size: 0.45, spread: 0.2, rise: 1.2, life: 0.5 });
      if (ev.effect === 'WATER') this.puffs([to[0], to[1] + 0.8, to[2]], 6, { color: '#cfefff', size: 0.4, spread: 0.3, rise: -1.5, life: 0.5 });
    }
  }

  // 세계의 성질 효과: 물 튀김·얼음·녹음·바위 깎임·단어 생김
  worldFx(e) {
    if (e.k === 'splash') {
      this.puffs(e.pos, 8, { color: '#e3f6ff', size: 0.5, spread: e.radius * 0.5, rise: 1.4, life: 0.55 });
      this.burst(e.pos, new THREE.Color('#5fb8ff'), 10, 2, 1.6, 0.5, 0.07);
      for (const h of e.hits) if (h.effects.includes('douse')) this.puffs(e.pos, 10, { color: '#ffffff', size: 0.7, spread: 0.3, rise: 2, life: 1.1 });
    } else if (e.k === 'freeze') {
      this.burst(e.pos, new THREE.Color('#bfe9ff'), 14, 1.8, 1, 0.6, 0.08);
      this.puffs(e.pos, 6, { color: '#f4fbff', size: 0.6, spread: 0.4, rise: 0.4, life: 0.7 });
      this.poke(e.id, 'hit');
    } else if (e.k === 'melt') {
      if (e.steam) this.puffs(e.pos, 10, { color: '#ffffff', size: 0.7, spread: 0.4, rise: 1.8, life: 1 }); // 김이 오른다
      else this.burst(e.pos, new THREE.Color('#9fe6ff'), 10, 1.4, 0.6, 0.5, 0.07); // 물이 되어 흩어진다
    } else if (e.k === 'steam' || e.k === 'vanish') {
      this.puffs(e.pos, 8, { color: '#ffffff', size: 0.6, spread: 0.4, rise: 1.2, life: 0.9 });
    } else if (e.k === 'chip' || e.k === 'shatter') {
      const big = e.k === 'shatter';
      const b = this.bodyViews.get(e.id);
      const pos = e.pos || (b ? [b.group.position.x, b.group.position.y, b.group.position.z] : null);
      if (!pos) return;
      this.burst(pos, new THREE.Color('#b9b6c4'), big ? 20 : 8, big ? 3 : 2, 1.5, 0.6, 0.09);
      this.puffs(pos, big ? 12 : 4, { color: '#ece6dc', size: big ? 0.9 : 0.5, spread: 0.6, rise: 0.8, life: 0.8 });
      this.poke(e.id, 'hit');
    } else if (e.k === 'wordBorn') {
      this.burst(e.pos, new THREE.Color('#ffe066'), 12, 1.6, 1.4, 0.7, 0.08);
    } else if (e.k === 'ignite') {
      const b = this.bodyViews.get(e.id);
      if (b) this.burst([b.group.position.x, b.group.position.y + 0.3, b.group.position.z], new THREE.Color('#ffb347'), 12, 1.4, 1.6, 0.6, 0.08);
    }
  }

  // 파이어볼 명중 폭발(반경 = 실제 판정 반경)
  // 만화 같은 뭉게 폭발: 통통한 공 몇 개가 부풀었다 줄고, 연기·별이 튄다(크기 = 실제 판정 반경)
  boomFx(e) {
    const colors = ['#ffd95a', '#ffa25a', '#ff7a3d', '#fff3c4'];
    for (let i = 0; i < 6; i++) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), toon(colors[i % colors.length], { transparent: true, opacity: 0.95 }));
      const a = (i / 6) * Math.PI * 2;
      const off = i === 0 ? 0 : e.blast * 0.45;
      ball.position.set(e.pos[0] + Math.cos(a) * off, e.pos[1] + (i === 0 ? 0 : 0.15), e.pos[2] + Math.sin(a) * off);
      ball.userData.maxScale = e.blast * (i === 0 ? 0.85 : 0.5);
      this.scene.add(ball);
      this.fx.push({ obj: ball, life: 0.45 + i * 0.03, age: -i * 0.02, kind: 'boom' });
    }
    this.puffs(e.pos, 8, { color: '#ffffff', size: 0.7, spread: e.blast * 0.6, rise: 1.2, life: 0.8 });
    this.burst(e.pos, new THREE.Color('#ffd95a'), 12, 3, 1.5, 0.6, 0.08);
    for (const h of e.hits) this.poke(h.id, 'hit');
  }

  fizzleFx(pos) {
    this.puffs(pos, 5, { color: '#f2eee6', size: 0.4, spread: 0.2, rise: 0.6, life: 0.5 });
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
        if (!f.obj.isSprite) f.obj.geometry.dispose();
        f.obj.material.dispose();
        return false;
      }
      if (f.kind === 'ring') {
        const s = 1 + k * 3;
        f.obj.scale.set(s, s, s);
        f.obj.material.opacity = 0.8 * (1 - k);
      } else if (f.kind === 'boom') {
        if (k < 0) { f.obj.visible = false; return true; }
        f.obj.visible = true;
        // 통통하게 부풀었다(넘침) 줄어든다
        const grow = Math.min(1, k * 2.4);
        const pop = grow < 1 ? 1 - (1 - grow) ** 3 : 1 - (k - 0.42) * 1.6;
        const sc = Math.max(0.01, f.obj.userData.maxScale * Math.max(0, pop) * 1.1);
        f.obj.scale.set(sc, sc, sc);
        f.obj.material.opacity = 0.95 * Math.min(1, 1.6 * (1 - k));
      } else if (f.kind === 'particle') {
        f.obj.position.addScaledVector(f.vel, dt);
        f.vel.y -= 3 * dt;
        f.obj.material.opacity = 1 - k;
        if (f.obj.isSprite) { f.obj.material.rotation += dt * 4; f.obj.scale.setScalar(f.obj.userData.base * (1 - k * 0.6)); }
      } else if (f.kind === 'puff') {
        f.obj.position.addScaledVector(f.vel, dt);
        f.vel.multiplyScalar(1 - dt * 2.5);
        f.obj.scale.setScalar(f.base * (1 + k * 1.4));
        f.obj.material.opacity = f.op * (1 - k) * (1 - k);
      } else if (f.kind === 'twinkle') {
        if (k < 0) { f.obj.visible = false; return true; }
        f.obj.visible = true;
        f.obj.material.rotation += dt * 6;
        f.obj.scale.setScalar(f.obj.userData.base * (1 + Math.sin(k * Math.PI) * 0.6));
        f.obj.material.opacity = 1 - k;
      } else {
        f.obj.material.opacity = 0.9 * (1 - k);
      }
      return true;
    });
  }

  // 느린 기기(내장 그래픽·소프트웨어 렌더링)에서는 2초마다 평균 프레임을 보고 한 단계씩 낮춘다:
  // 1) 해상도 75% → 2) 그림자 끄기 → 3) 해상도 60%. 한 번 낮추면 다시 올리지 않는다(깜빡임 방지).
  autoQuality(dt) {
    const p = this.perf;
    p.acc += dt;
    p.frames += 1;
    if (p.acc < 2) return;
    const fps = p.frames / p.acc;
    p.acc = 0;
    p.frames = 0;
    if (fps >= 28 || p.level >= 3) return;
    p.level += 1;
    if (p.level === 1) this.renderer.setPixelRatio(Math.max(0.6, this.pixelRatio * 0.75));
    if (p.level === 2) { this.renderer.shadowMap.enabled = false; this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); }); }
    if (p.level === 3) this.renderer.setPixelRatio(0.6);
    this.resize();
  }

  // frame: { bodies: Map(id → {p,y,f,i}), tokens: [{id,w,o,p}], me, preview: {ok:Set, bad:Set}, nearby, camera: {pos, look}, cleared }
  render(frame, dt, t) {
    for (const [id, v] of this.bodyViews) {
      const s = frame.bodies.get(id);
      v.group.visible = !!s && !(frame.first && id === frame.me); // 1인칭이면 내 몸은 숨기고 손만
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
      const sc = s.sc || 1; // 부서지며 작아진 바위
      v.visual.scale.set(v.baseScale.x * sxz * sc, v.baseScale.y * sy * sc, v.baseScale.z * sxz * sc);
      if (v.group.userData.tag && v.def.kind !== 'player') v.group.userData.tag.position.y = (v.def.size[1] * sc) / 2 + 0.45 + (v.def.kind === 'campfire' ? 0.45 : 0);
      // 모닥불 불꽃·샘의 물(뽑아내면 꺼지고 빈다)
      const flame = v.group.userData.flame;
      if (flame) {
        flame.visible = !!s.lit;
        if (s.lit) {
          flame.scale.set(1 + 0.08 * Math.sin(t * 13), 1 + 0.15 * Math.sin(t * 9), 1 + 0.08 * Math.cos(t * 11));
          if (t - v.smokeAt > 0.35) {
            v.smokeAt = t;
            this.puffs([s.p[0], s.p[1] + 0.5, s.p[2]], 1, { color: '#f0ebe6', size: 0.35, spread: 0.05, rise: 0.9, life: 0.9, opacity: 0.6 });
          }
        }
      }
      if (v.group.userData.pool) v.group.userData.pool.visible = !!s.st;
      if (v.group.userData.cloud) { v.visual.rotation.y = t * 0.6; v.visual.position.y = Math.sin(t * 2) * 0.08; }
      if (v.group.userData.tag && v.def.kind !== 'player' && s.st !== undefined) v.group.userData.tag.material.opacity = s.st ? 1 : 0.35;
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
        // 걷기: 팔다리를 흔들고 통통 튄다, 발밑에 먼지 뭉게
        const moving = s.speed > 0.5 && s.g;
        const rig = v.group.userData.rig;
        v.phase += dt * (moving ? Math.min(14, 4 + s.speed * 2.2) : 0);
        const amt = moving ? 0.7 : 0;
        const sw = Math.sin(v.phase) * amt;
        rig.legs[0].rotation.x = sw;
        rig.legs[1].rotation.x = -sw;
        rig.arms[0].rotation.x = -sw * 0.9;
        rig.arms[1].rotation.x = sw * 0.9;
        rig.head.rotation.z = moving ? Math.sin(v.phase) * 0.06 : Math.sin(t * 1.5) * 0.03;
        v.visual.position.y = moving ? Math.abs(Math.sin(v.phase)) * 0.07 : Math.sin(t * 2) * 0.008;
        const feet = [s.p[0], s.p[1] - v.def.size[1] / 2 + 0.05, s.p[2]];
        if (moving && t - v.dustAt > 0.24) {
          v.dustAt = t;
          this.puffs(feet, 1, { color: '#fffaf0', size: 0.28, spread: 0.1, rise: 0.4, life: 0.45, opacity: 0.8 });
        }
        if (s.g && !v.wasG) this.puffs(feet, 5, { color: '#fffaf0', size: 0.32, spread: 0.35, rise: 0.3, life: 0.45, opacity: 0.85 });
        v.wasG = !!s.g;
        v.group.userData.tag.visible = id !== frame.me; // 내 이름표는 시야를 가리므로 숨긴다
      }
      // 바다에 빠지면 물보라
      const above = s.p[1] > WATER_Y;
      if (v.wasAbove && !above) this.splashFx(s.p);
      v.wasAbove = above;
      if (v.group.userData.star) v.group.userData.star.rotation.y = t * 1.5;
      const hl = frame.preview?.ok.has(id) ? 'ok' : frame.preview?.bad.has(id) ? 'bad' : null;
      for (const m of v.mats) {
        if (hl === 'ok') { m.emissive.set('#ffd84d'); m.emissiveIntensity = 0.35 + 0.2 * Math.sin(t * 10); }
        else if (hl === 'bad') { m.emissive.set('#ff8f7a'); m.emissiveIntensity = 0.3; }
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
      v.gem.rotation.y = t * 1.2;
      v.gem.position.y = 0.28 + Math.sin(t * 2.4 + tk.id.charCodeAt(1)) * 0.04;
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
      const wet = pr.w === 'WATER';
      if (!pv) {
        // 통통한 불덩이: 노란 속 + 주황 겉 / 물방울: 하늘색 속 + 파란 겉
        const core = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), wet
          ? toon('#bfe9ff', { emissive: '#5fb8ff', emissiveIntensity: 0.3 })
          : toon('#ffe27a', { emissive: '#ffb347', emissiveIntensity: 0.6 }));
        const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: wet ? '#5fb8ff' : '#ff8a4d', transparent: true, opacity: 0.45, depthWrite: false }));
        this.scene.add(core, halo);
        pv = { core, halo, trailAt: 0 };
        this.projViews.set(pr.id, pv);
      }
      pv.core.position.set(...pr.p);
      pv.halo.position.set(...pr.p);
      pv.core.scale.setScalar(pr.r);
      pv.halo.scale.setScalar(pr.r * (1.7 + 0.2 * Math.sin(t * 30)));
      if (t - pv.trailAt > 0.04) {
        pv.trailAt = t;
        if (wet) this.puffs(pr.p, 1, { color: '#cfefff', size: pr.r * 1.8, spread: 0.05, rise: -0.6, life: 0.3, opacity: 0.8 });
        else this.puffs(pr.p, 1, { color: Math.random() > 0.5 ? '#ffd27a' : '#ffa25a', size: pr.r * 2.2, spread: 0.05, rise: 0.4, life: 0.35, opacity: 0.85 });
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
          tv = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8), new THREE.MeshBasicMaterial({ color: '#9fe6ff', transparent: true, opacity: 0.65, depthWrite: false }));
          this.scene.add(tv);
          this.tethers.set(key, tv);
        }
        const a = new THREE.Vector3(from.p[0], from.p[1] + 0.3, from.p[2]);
        const b = new THREE.Vector3(...s.p);
        tv.visible = true;
        tv.material.color.set(s.hv ? '#ffa08a' : '#9fe6ff');
        tv.scale.set(1, Math.max(0.01, a.distanceTo(b)), 1);
        tv.position.copy(a).add(b).multiplyScalar(0.5);
        tv.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        tv.material.opacity = 0.45 + 0.2 * Math.sin(t * 12);
      }
    }
    for (const [id, tv] of this.tethers) if (!held.has(id)) tv.visible = false;

    this.flag.rotation.y = Math.sin(t * 2) * 0.25;
    this.goalPad.material.opacity = frame.cleared ? 0.75 : 0.35 + 0.1 * Math.sin(t * 3);

    this.autoQuality(dt);
    stepWater(t);
    for (const c of this.clouds || []) c.rotation.y = t * 0.004; // 구름이 천천히 하늘을 돈다
    this.stepFx(dt);
    this.camera.position.set(...frame.camera.pos);
    this.camera.lookAt(...frame.camera.look);
    this.renderer.render(this.scene, this.camera);
    if (this.updateHands(frame, dt, t)) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.handScene, this.handCam);
      this.renderer.autoClear = true;
    }
  }
}
