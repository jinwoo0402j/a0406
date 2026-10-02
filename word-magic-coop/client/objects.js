// 사물 종류별 3D 모양(동숲 느낌). 판정은 하지 않고 그리기만 한다.
// 새 사물 종류를 더할 때는 여기에 kind 이름으로 함수를 하나 더한다(없으면 선물 상자 모양).
// 함수: (d: 사물 정의, std: 강조 표시가 되는 툰 재질 만들기, group: 이름표 등을 붙일 묶음, h: 높이) → 모양
import * as THREE from 'three';
import { makeLabel, iconPlate } from './labels.js';
import { giftBox, toon, villager, woodTexture } from './look.js';

const VISUAL = {
  player(d, std, group, h) {
    let visual;
    // 동물 주민 같은 캐릭터: 자리마다 다른 동물, 큰 머리·둥근 몸·짧은 팔다리
    const col = d.color;
    const v = villager(d.id, col, h, (c) => std(c));
    visual = v.group;
    group.userData.rig = v;
    const tag = makeLabel(d.id, { bg: col, size: 44, height: 0.34, border: '#ffffff' });
    tag.position.y = h / 2 + 0.55;
    group.add(tag);
    group.userData.tag = tag;
    return visual;
  },
  rock(d, std, group, h) {
    let visual;
    // 동글동글한 바위
    visual = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), std('#b9b6c4', { flatShading: true }));
    visual.scale.set(1, 0.8, 0.95);
    return visual;
  },
  box(d, std, group, h) {
    let visual;
    // 나무 상자
    visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#ffffff', { map: woodTexture('#e8b276') }));
    return visual;
  },
  heavy(d, std, group, h) {
    let visual;
    // 무거운 상자: <세게> 없이는 들 수 없다
    // 무거운 돌 상자(쇠띠 두른 큰 상자)
    visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#ffffff', { map: woodTexture('#8f96a8') }));
    for (const y of [-0.25, 0.25]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(d.size[0] + 0.03, 0.09, d.size[2] + 0.03), std('#5d6475'));
      band.position.y = y;
      visual.add(band);
    }
    const tag = iconPlate(['weight'], { bg: '#7d859a', round: true, height: 0.34, border: '#ffffff' }); // 무거운 상자
    tag.position.y = h / 2 + 0.35;
    group.add(tag);
    return visual;
  },
  boulder(d, std, group, h) {
    let visual;
    // 커다란 바위: 울퉁불퉁한 큰 돌. 부서지며 작아진다(스냅숏의 sc)
    visual = new THREE.Group();
    const main = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), std('#a9a4b6', { flatShading: true }));
    main.scale.set(d.size[0] * 1.05, d.size[1] * 1.05, d.size[2] * 1.05);
    visual.add(main);
    for (const [x, y, z, k] of [[0.5, -0.35, 0.4, 0.45], [-0.55, -0.4, -0.2, 0.4], [0.1, 0.45, -0.3, 0.35]]) {
      const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(k, 0), std('#bdb8c9', { flatShading: true }));
      lump.position.set(x * d.size[0] * 0.6, y * d.size[1] * 0.6, z * d.size[2] * 0.6);
      visual.add(lump);
    }
    const tag = iconPlate(['big'], { bg: '#a98bff', round: true, height: 0.36, border: '#ffffff' }); // 이 바위에서 <큰>이 나온다
    tag.position.y = h / 2 + 0.45;
    group.add(tag);
    group.userData.tag = tag;
    return visual;
  },
  campfire(d, std, group, h) {
    let visual;
    // 모닥불: 통나무 + 불꽃(꺼지면 불꽃이 사라진다)
    visual = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.8, 8), std('#9a6a3e'));
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i / 4) * Math.PI;
      log.position.y = -h / 2 + 0.1;
      visual.add(log);
    }
    for (let i = 0; i < 7; i++) {
      const st = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), std('#c9c3b6'));
      const a = (i / 7) * Math.PI * 2;
      st.position.set(Math.cos(a) * 0.42, -h / 2 + 0.05, Math.sin(a) * 0.42);
      visual.add(st);
    }
    const flame = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 10), toon('#ff8a3d', { emissive: '#ff6a00', emissiveIntensity: 0.6 }));
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.38, 10), toon('#ffe27a', { emissive: '#ffb347', emissiveIntensity: 0.8 }));
    outer.position.y = 0.3;
    inner.position.y = 0.22;
    flame.add(outer, inner);
    flame.position.y = -h / 2 + 0.1;
    visual.add(flame);
    group.userData.flame = flame;
    const tag = iconPlate(['flame'], { bg: '#ff9f6e', round: true, height: 0.34, border: '#ffffff' });
    tag.position.y = h / 2 + 0.9;
    group.add(tag);
    group.userData.tag = tag;
    return visual;
  },
  well(d, std, group, h) {
    let visual;
    // 샘: 둥근 돌 우물 + 물(비면 물이 사라진다)
    visual = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(d.size[0] / 2, d.size[0] / 2 + 0.05, h, 16, 1, true), std('#cfc8b8', { side: THREE.DoubleSide }));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(d.size[0] / 2, 0.07, 8, 24), std('#bdb5a3'));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h / 2;
    const pool = new THREE.Mesh(new THREE.CircleGeometry(d.size[0] / 2 - 0.04, 20), toon('#7fd0ff', { emissive: '#3aa0e0', emissiveIntensity: 0.25 }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = h / 2 - 0.12;
    visual.add(ring, rim, pool);
    group.userData.pool = pool;
    const tag = iconPlate(['water'], { bg: '#5fb8ff', round: true, height: 0.34, border: '#ffffff' });
    tag.position.y = h / 2 + 0.45;
    group.add(tag);
    group.userData.tag = tag;
    return visual;
  },
  steamcloud(d, std, group, h) {
    let visual;
    // 김: 뭉게뭉게 반투명 구름(부딪히지 않음). <당기기>로 거두면 <수증기>
    visual = new THREE.Group();
    for (const [x, y, z, r] of [[0, 0, 0, 0.42], [0.32, -0.1, 0.1, 0.3], [-0.3, -0.05, -0.1, 0.32], [0.05, 0.28, -0.05, 0.28], [0, -0.2, 0.3, 0.26]]) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), std('#ffffff', { transparent: true, opacity: 0.7, depthWrite: false }));
      puff.position.set(x, y, z);
      visual.add(puff);
    }
    group.userData.cloud = true;
    const tag = iconPlate(['steam'], { bg: '#9fb4c4', round: true, height: 0.3, border: '#ffffff' });
    tag.position.y = h / 2 + 0.45;
    group.add(tag);
    group.userData.tag = tag;
    return visual;
  },
  ice(d, std, group, h) {
    let visual;
    // 얼음 덩이: 반투명 하늘색 상자
    visual = new THREE.Mesh(new THREE.BoxGeometry(...d.size), std('#d6f2ff', { transparent: true, opacity: 0.85, emissive: '#bfe9ff', emissiveIntensity: 0.25 }));
    return visual;
  },
  dummy(d, std, group, h) {
    let visual;
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
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.08), new THREE.MeshBasicMaterial({ color: '#ff9f6e', depthWrite: false }));
    fill.position.z = 0.001;
    bar.add(bg, fill);
    bar.position.y = h / 2 + 0.3;
    group.add(bar);
    group.userData.hpBar = { bar, fill };
    const tag = iconPlate(['dummy'], { bg: '#c99a5e', round: true, height: 0.34, border: '#ffffff' }); // 허수아비(적)
    tag.position.y = h / 2 + 0.6;
    group.add(tag);
    return visual;
  },
  cargo(d, std, group, h) {
    let visual;
    // 목표 짐: 리본 단 선물 상자 + 반짝이는 별
    visual = giftBox(d.size, (c) => std(c));
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), std('#ffd95a', { emissive: '#ffb347', emissiveIntensity: 0.35 }));
    star.position.y = d.size[1] / 2 + 0.55;
    visual.add(star);
    group.userData.star = star;
    const tag = iconPlate(['flag'], { bg: '#ff9fb4', round: true, height: 0.36, border: '#ffffff' }); // 짐: 도착 깃발로 가져갈 것
    tag.position.y = h / 2 + 0.9;
    group.add(tag);
    return visual;
  },
};

export function objectVisual(d, std, group) {
  return (VISUAL[d.kind] || VISUAL.cargo)(d, std, group, d.size[1]);
}
