// 동물의 숲 느낌의 그림: 부드러운 툰 셰이딩, "굴러가는 통나무"처럼 멀수록 휘어 내려가는 땅,
// 파스텔 하늘·뭉게구름·바다·모래사장·나무·꽃, 동물 주민 같은 캐릭터, 별·뭉게 연기 효과.
// 표시 전용이다. 판정(물리·조준)은 휘지 않은 원래 좌표로 한다.
import * as THREE from 'three';

// ------------------------------------------------------------------ 지면 휨(rolling log)
// 카메라에서 수평 거리 d만큼 떨어진 곳은 d²·k만큼 아래로 내려 그린다. 조준 오차가 커지지 않게 약하게.
export const BEND = { value: 0.0018 };

const BENT_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 bendW = modelMatrix * mvPosition;
vec2 bendD = bendW.xz - cameraPosition.xz;
bendW.y -= dot( bendD, bendD ) * uBend;
mvPosition = viewMatrix * bendW;
gl_Position = projectionMatrix * mvPosition;
`;

const BENT_SPRITE = /* glsl */`
vec4 bendW = modelMatrix[ 3 ];
vec2 bendD = bendW.xz - cameraPosition.xz;
bendW.y -= dot( bendD, bendD ) * uBend;
vec4 mvPosition = viewMatrix * bendW;
`;

export function bend(mat) {
  if (!mat || mat.userData.bent || mat.userData.noBend || mat.isShaderMaterial) return;
  mat.userData.bent = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBend = BEND;
    if (mat.isSpriteMaterial) {
      shader.vertexShader = `uniform float uBend;\n${shader.vertexShader.replace('vec4 mvPosition = modelViewMatrix[ 3 ];', BENT_SPRITE)}`;
    } else {
      shader.vertexShader = `uniform float uBend;\n${shader.vertexShader.replace('#include <project_vertex>', BENT_PROJECT)}`;
    }
  };
  mat.customProgramCacheKey = () => 'bend1';
  mat.needsUpdate = true;
}

export function bendTree(obj) {
  obj.traverse((o) => {
    const m = o.material;
    if (Array.isArray(m)) m.forEach(bend);
    else if (m) bend(m);
  });
}

// ------------------------------------------------------------------ 툰 재질
let gradient = null;
function toonGradient() {
  if (gradient) return gradient;
  // 그림자 쪽도 너무 어둡지 않게(밝고 부드러운 3단)
  const data = new Uint8Array([168, 168, 168, 255, 222, 222, 222, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = gradient.magFilter = THREE.LinearFilter;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(color, extra = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...extra });
}

// 장식용 공유 재질: 같은 색이면 같은 재질이라 합칠 때 한 덩어리가 된다
const shared = new Map();
export function toonShared(color, extra = {}) {
  const key = `${new THREE.Color(color).getHexString()}|${JSON.stringify(extra)}`;
  if (!shared.has(key)) shared.set(key, toon(color, extra));
  return shared.get(key);
}

// ------------------------------------------------------------------ 캔버스 텍스처
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function rand(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

export function grassTexture(base = '#9bd46e') {
  return canvasTex(256, 256, (g, w, h) => {
    const r = rand(7);
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    // 부드러운 얼룩
    for (let i = 0; i < 26; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(60,120,30,0.08)';
      g.beginPath();
      g.ellipse(r() * w, r() * h, 18 + r() * 30, 12 + r() * 20, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // 작은 풀잎(세 갈래)
    g.strokeStyle = 'rgba(70,140,40,0.55)';
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const x = r() * w;
      const y = r() * h;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x - 3, y - 6);
      g.moveTo(x, y); g.lineTo(x, y - 7);
      g.moveTo(x, y); g.lineTo(x + 3, y - 6);
      g.stroke();
    }
  });
}

export function cliffTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#d6a873';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(150,100,55,0.45)';
    g.lineWidth = 4;
    for (let y = 18; y < h; y += 26) {
      g.beginPath();
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin(x * 0.12 + y) * 3);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 12; i++) g.fillRect((i * 37) % w, (i * 53) % h, 10, 4);
  });
}

export function sandTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    const r = rand(3);
    g.fillStyle = '#f6e6bb';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = r() > 0.5 ? 'rgba(210,180,120,0.35)' : 'rgba(255,255,255,0.4)';
      g.beginPath();
      g.arc(r() * w, r() * h, 1 + r() * 1.5, 0, Math.PI * 2);
      g.fill();
    }
  });
}

export function woodTexture(base = '#e0a66a') {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120,70,30,0.45)';
    g.lineWidth = 4;
    for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = 'rgba(120,70,30,0.25)';
    g.lineWidth = 2;
    for (let y = 8; y < h; y += 32) { g.beginPath(); g.moveTo(10, y + 6); g.quadraticCurveTo(w / 2, y + 2, w - 10, y + 8); g.stroke(); }
    g.strokeStyle = 'rgba(120,70,30,0.6)';
    g.lineWidth = 6;
    g.strokeRect(3, 3, w - 6, h - 6);
  }, false);
}

let starTex = null;
export function starTexture() {
  if (starTex) return starTex;
  starTex = canvasTex(64, 64, (g, w, h) => {
    g.translate(w / 2, h / 2);
    g.fillStyle = '#ffffff';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? 11 : 28;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 6;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fill();
  }, false);
  return starTex;
}

let puffTex = null;
export function puffTexture() {
  if (puffTex) return puffTex;
  puffTex = canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
    g.fill();
  }, false);
  return puffTex;
}

// ------------------------------------------------------------------ 하늘·구름·바다
export function skyDome() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color('#79c8f2') }, mid: { value: new THREE.Color('#bfe7fb') }, low: { value: new THREE.Color('#fff4dc') } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.15 ? mix(mid, top, smoothstep(0.15, 0.75, h)) : mix(low, mid, smoothstep(-0.1, 0.15, h)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 16), mat);
  dome.userData.noBend = true;
  return dome;
}

export function cloud(seed) {
  const r = rand(seed);
  const g = new THREE.Group();
  const mat = toonShared('#ffffff', { fog: false });
  mat.userData.noBend = true;
  const n = 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), mat);
    const k = 3 + r() * 3;
    s.scale.set(k * 1.2, k * 0.8, k);
    s.position.set((i - n / 2) * 3.4 + r() * 1.5, r() * 1.6, r() * 2);
    g.add(s);
  }
  return g;
}

let waveTex = null;
// 바다: 물결 무늬를 그린 한 장(겹치는 투명 판 없이 가볍게)
export function water() {
  waveTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#5fcbdc';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    c.lineWidth = 3;
    c.lineCap = 'round';
    const r = rand(11);
    for (let i = 0; i < 24; i++) {
      c.beginPath();
      c.arc(r() * w, r() * h, 8, Math.PI * 1.1, Math.PI * 1.9);
      c.stroke();
    }
  });
  waveTex.repeat.set(60, 60);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial({ map: waveTex }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -1.05;
  return sea;
}

export function stepWater(t) {
  if (waveTex) { waveTex.offset.x = t * 0.01; waveTex.offset.y = Math.sin(t * 0.3) * 0.02; }
}

// ------------------------------------------------------------------ 나무·꽃·덤불
export function roundTree(seed, scale = 1) {
  const r = rand(seed);
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.6, 10), toonShared('#a8743f'));
  trunk.position.y = 0.8;
  g.add(trunk);
  const greens = ['#6cc24a', '#7fd15a', '#5db544'];
  const leaves = toonShared(greens[Math.floor(r() * greens.length)]);
  for (const [x, y, z, s] of [[0, 2.1, 0, 1.05], [-0.55, 1.75, 0.2, 0.75], [0.55, 1.8, -0.15, 0.8], [0.1, 2.65, 0.1, 0.7]]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), leaves);
    b.position.set(x, y, z);
    b.scale.setScalar(s);
    g.add(b);
  }
  // 열매(동숲 과일나무 느낌)
  if (r() > 0.5) {
    const fruit = toonShared(r() > 0.5 ? '#ff7a6b' : '#ffb347');
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), fruit);
      const a = r() * Math.PI * 2;
      f.position.set(Math.cos(a) * 0.9, 1.9 + r() * 0.4, Math.sin(a) * 0.9);
      g.add(f);
    }
  }
  g.scale.setScalar(scale * (0.85 + r() * 0.3));
  g.rotation.y = r() * Math.PI * 2;
  return g; // 놀이 구역 밖이라 그림자는 생략(가볍게)
}

export function palmTree(seed) {
  const r = rand(seed);
  const g = new THREE.Group();
  const trunkMat = toonShared('#c99a5e');
  let y = 0;
  let x = 0;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.15 - i * 0.012, 0.18 - i * 0.012, 0.62, 8), trunkMat);
    x += 0.08 * i;
    seg.position.set(x, y + 0.31, 0);
    seg.rotation.z = -0.08 * i;
    g.add(seg);
    y += 0.58;
  }
  const leafMat = toonShared('#5fbf4a', { side: THREE.DoubleSide });
  for (let i = 0; i < 6; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4), leafMat);
    leaf.scale.set(1.1, 0.06, 0.32);
    const a = (i / 6) * Math.PI * 2;
    leaf.position.set(x + Math.cos(a) * 0.85, y - 0.05, Math.sin(a) * 0.85);
    leaf.rotation.y = -a;
    leaf.rotation.z = -0.35;
    g.add(leaf);
  }
  const coco = toonShared('#8a5a2b');
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), coco);
    c.position.set(x + Math.cos(i * 2.1) * 0.2, y - 0.2, Math.sin(i * 2.1) * 0.2);
    g.add(c);
  }
  g.rotation.y = r() * Math.PI * 2;
  return g;
}

export function bush(len, seed) {
  const r = rand(seed);
  const g = new THREE.Group();
  const mat = toonShared('#68bf55');
  const n = Math.max(2, Math.round(len / 0.62));
  for (let i = 0; i < n; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.46, 10, 7), mat);
    b.position.set(-len / 2 + (i + 0.5) * (len / n), 0.4 + r() * 0.08, 0);
    b.scale.set(1, 0.92, 0.9);
    g.add(b);
  }
  // 작은 꽃 몇 송이
  const fm = toonShared(r() > 0.5 ? '#ff9ec7' : '#fff07a');
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), fm);
    f.position.set(-len / 2 + r() * len, 0.75 + r() * 0.1, (r() - 0.5) * 0.5);
    g.add(f);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// 꽃밭: 위치 목록 → 인스턴스(꽃잎 4개 + 가운데 + 줄기)
export function flowers(spots, seed = 5) {
  const r = rand(seed);
  const colors = ['#ff8fb4', '#fff27a', '#ffffff', '#ff8f6b', '#b79bff'];
  const petalGeo = new THREE.SphereGeometry(0.075, 5, 4);
  const petals = new THREE.InstancedMesh(petalGeo, toon('#ffffff'), spots.length * 4);
  const centers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 5, 4), toon('#ffd23f'), spots.length);
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 4), toon('#4fa83a'), spots.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  spots.forEach(([x, y, z], i) => {
    const h = 0.22;
    m.makeTranslation(x, y + h / 2, z);
    stems.setMatrixAt(i, m);
    m.makeTranslation(x, y + h, z);
    centers.setMatrixAt(i, m);
    c.set(colors[Math.floor(r() * colors.length)]);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + r();
      m.makeTranslation(x + Math.cos(a) * 0.08, y + h, z + Math.sin(a) * 0.08);
      petals.setMatrixAt(i * 4 + k, m);
      petals.setColorAt(i * 4 + k, c);
    }
  });
  const g = new THREE.Group();
  g.add(stems, centers, petals);
  return g;
}

// 그룹 안의 메시를 재질별로 합친다(그룹 기준 좌표). 움직이는 부위(팔·다리·머리)마다 따로 부른다.
function mergeChildren(group, skip = () => false) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map();
  const victims = [];
  group.traverse((o) => {
    if (o === group || !o.isMesh || skip(o)) return;
    let p = o.parent;
    while (p && p !== group) { if (skip(p)) return; p = p.parent; }
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
    victims.push(o);
  });
  for (const v of victims) v.parent.remove(v);
  for (const [mat, geos] of byMat) {
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    let k = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, k * 3);
      nor.set(g.attributes.normal.array, k * 3);
      k += g.attributes.position.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    group.add(new THREE.Mesh(geo, mat));
  }
}

// ------------------------------------------------------------------ 동물 주민 캐릭터
// 자리마다 다른 동물(멀리서도 실루엣으로 구분). 큰 머리·둥근 몸·짧은 팔다리·큰 눈·볼터치.
export const SEAT_ANIMAL = { A: 'cat', B: 'bear', C: 'rabbit', D: 'dog', E: 'frog', F: 'penguin' };

function lighten(hex, k) {
  const c = new THREE.Color(hex);
  return c.lerp(new THREE.Color('#ffffff'), k);
}

// h: 몸 높이(AABB). mk(color) → 재질(하이라이트·그을림 처리용으로 기록된다)
export function villager(seat, color, h, mkRaw) {
  const animal = SEAT_ANIMAL[seat] || 'cat';
  // 같은 색은 같은 재질(그리기 횟수를 줄이려고 부위마다 합친다)
  const cache = new Map();
  const mk = (c) => {
    const key = new THREE.Color(c).getHexString();
    if (!cache.has(key)) cache.set(key, mkRaw(c));
    return cache.get(key);
  };
  const fur = lighten(color, 0.25);
  const furDark = new THREE.Color(color).multiplyScalar(0.85);
  const cream = new THREE.Color('#fff3df');
  const g = new THREE.Group();
  const bottom = -h / 2;

  // 다리(엉덩이에서 흔들림)
  const legs = [-0.11, 0.11].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, bottom + 0.2, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.08, 4, 8), mk(furDark));
    leg.position.y = -0.09;
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mk('#7a5536'));
    shoe.scale.set(1, 0.65, 1.35);
    shoe.position.set(0, -0.16, 0.03);
    pivot.add(leg, shoe);
    g.add(pivot);
    return pivot;
  });
  // 몸(옷)
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), mk(color));
  body.scale.set(1, 1.08, 0.92);
  body.position.y = bottom + 0.4;
  g.add(body);
  // 옷 단추·주머니 느낌의 흰 칼라
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.035, 8, 20), mk('#ffffff'));
  collar.rotation.x = Math.PI / 2;
  collar.position.y = bottom + 0.6;
  g.add(collar);
  // 팔(어깨에서 흔들림)
  const arms = [-1, 1].map((sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.21, bottom + 0.55, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.12, 4, 8), mk(color));
    arm.position.set(sx * 0.03, -0.1, 0);
    arm.rotation.z = sx * 0.35;
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), mk(fur));
    paw.position.set(sx * 0.07, -0.2, 0);
    pivot.add(arm, paw);
    g.add(pivot);
    return pivot;
  });
  // 머리(크게)
  const head = new THREE.Group();
  head.position.y = bottom + 0.88;
  g.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 14), mk(animal === 'penguin' ? '#4a4f68' : fur));
  skull.scale.set(1.08, 0.98, 1);
  head.add(skull);
  // 얼굴
  const eyeMat = new THREE.MeshBasicMaterial({ color: '#2b2321' });
  const shine = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const cheekMat = new THREE.MeshBasicMaterial({ color: '#ff9fb0', transparent: true, opacity: 0.85 });
  const eyeY = animal === 'frog' ? 0.3 : 0.03;
  const eyeZ = animal === 'frog' ? 0.12 : 0.31;
  for (const x of [-0.12, 0.12]) {
    if (animal === 'frog') {
      const bulge = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), mk(fur));
      bulge.position.set(x * 1.1, 0.27, 0.06);
      head.add(bulge);
    }
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), eyeMat);
    eye.scale.set(0.95, 1.3, 0.5);
    eye.position.set(x, eyeY, eyeZ);
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), shine);
    hl.position.set(-0.018, 0.03, 0.03);
    eye.add(hl);
    head.add(eye);
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), cheekMat);
    cheek.scale.set(1.3, 0.7, 0.35);
    cheek.position.set(x * 1.65, -0.09, 0.27);
    head.add(cheek);
  }
  if (animal === 'penguin') {
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 12), mk('#ffffff'));
    face.scale.set(1.05, 0.9, 0.55);
    face.position.set(0, -0.03, 0.17);
    head.add(face);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 10), mk('#ffb347'));
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -0.06, 0.36);
    head.add(beak);
  } else if (animal !== 'frog') {
    // 주둥이·코
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), mk(cream));
    muzzle.scale.set(1.2, 0.8, 0.7);
    muzzle.position.set(0, -0.08, 0.28);
    head.add(muzzle);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mk(animal === 'rabbit' ? '#ff8fa8' : '#5a3b2e'));
    nose.scale.set(1.3, 0.9, 0.8);
    nose.position.set(0, -0.04, 0.36);
    head.add(nose);
  } else {
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 6, 16, Math.PI), eyeMat);
    mouth.rotation.z = Math.PI;
    mouth.position.set(0, -0.06, 0.31);
    head.add(mouth);
  }
  // 귀(동물마다 다른 실루엣)
  if (animal === 'cat') {
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 4), mk(fur));
      ear.position.set(sx * 0.2, 0.3, 0);
      ear.rotation.z = -sx * 0.35;
      head.add(ear);
    }
  } else if (animal === 'bear') {
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), mk(fur));
      ear.position.set(sx * 0.24, 0.26, -0.02);
      ear.scale.set(1, 1, 0.6);
      head.add(ear);
    }
  } else if (animal === 'rabbit') {
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 4, 10), mk(fur));
      ear.position.set(sx * 0.11, 0.48, -0.03);
      ear.rotation.z = -sx * 0.12;
      const inner = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.2, 4, 8), mk('#ffc2cf'));
      inner.position.set(0, 0, 0.035);
      ear.add(inner);
      head.add(ear);
    }
  } else if (animal === 'dog') {
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), mk(furDark));
      ear.scale.set(0.55, 1.2, 0.5);
      ear.position.set(sx * 0.33, 0.02, 0);
      ear.rotation.z = sx * 0.25;
      head.add(ear);
    }
  }
  // 작은 마법사 모자(단어 마법 게임이라)
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.3, 16), mk(furDark));
  hat.position.set(animal === 'rabbit' ? 0.2 : 0.06, 0.38, -0.04);
  hat.rotation.z = -0.3;
  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.03, 6, 16), mk('#ffd95a'));
  brim.rotation.x = Math.PI / 2;
  brim.position.y = -0.13;
  hat.add(brim);
  if (animal !== 'frog') head.add(hat);
  // 부위별로 재질마다 한 덩어리로(팔·다리·머리는 따로 움직인다)
  for (const part of [...legs, ...arms, head]) mergeChildren(part);
  mergeChildren(g, (o) => legs.includes(o) || arms.includes(o) || o === head);
  return { group: g, legs, arms, head };
}

// 선물 상자(목표 짐)
export function giftBox(size, mk) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(...size), mk('#ffb3c7'));
  g.add(box);
  const rib = mk('#ffe066');
  const r1 = new THREE.Mesh(new THREE.BoxGeometry(size[0] + 0.02, size[1] + 0.02, 0.16), rib);
  const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.16, size[1] + 0.02, size[2] + 0.02), rib);
  g.add(r1, r2);
  for (const sx of [-1, 1]) {
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.045, 8, 16), rib);
    bow.position.set(sx * 0.12, size[1] / 2 + 0.1, 0);
    bow.rotation.y = Math.PI / 2;
    bow.rotation.x = sx * 0.4;
    g.add(bow);
  }
  return g;
}

// ------------------------------------------------------------------ 장식 합치기
// 움직이지 않는 장식(나무·덤불·구름)을 재질별로 한 덩어리로 합쳐 그리기 횟수를 줄인다(저사양·소프트웨어 렌더링 대비).
export function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (!byMat.has(o.material)) byMat.set(o.material, { geos: [], cast: false, recv: false });
    const e = byMat.get(o.material);
    e.geos.push(g);
    e.cast ||= o.castShadow;
    e.recv ||= o.receiveShadow;
  });
  const out = new THREE.Group();
  for (const [mat, e] of byMat) {
    let n = 0;
    for (const g of e.geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    let k = 0;
    for (const g of e.geos) {
      pos.set(g.attributes.position.array, k * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, k * 3);
      k += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = e.cast;
    m.receiveShadow = e.recv;
    out.add(m);
  }
  // 인스턴스(꽃밭)는 그대로 옮긴다
  const inst = [];
  root.traverse((o) => { if (o.isInstancedMesh) inst.push(o); });
  for (const o of inst) out.add(o);
  return out;
}
