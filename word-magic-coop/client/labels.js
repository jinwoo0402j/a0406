// 캔버스로 한글 라벨 텍스처를 만든다(단어 카드, 이름표, 구역 이름).
import * as THREE from 'three';
import { iconSVG } from './icons.js';

export const FONT_STACK = "'Jua', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', 'WenQuanYi Zen Hei', sans-serif";

export function makeLabel(text, { bg = '#6c5ce7', fg = '#fff', size = 48, padX = 22, padY = 12, radius = 22, border = null, height = 0.5 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${size}px ${FONT_STACK}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + padX * 2);
  const h = Math.ceil(size * 1.25 + padY * 2);
  c.width = w;
  c.height = h;
  ctx.font = font;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, radius);
    ctx.fill();
    if (border) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = border;
      ctx.stroke();
    }
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!bg) {
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(text, w / 2, h / 2 + 2);
  }
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((height * w) / h, height, 1);
  return sprite;
}

// 글자 대신 기호를 그린 표(3D 표지판·이름표·손에 든 단어). 기호 그림은 불러온 뒤에 그려 넣는다.
// names: 기호 이름 목록(가로로 나란히), round: 동그란 배지
export function iconPlate(names, { bg = '#6c5ce7', fg = '#ffffff', border = null, height = 0.4, round = false, sprite = true } = {}) {
  const S = 96; // 기호 하나 크기(px)
  const pad = round ? 18 : 22;
  const c = document.createElement('canvas');
  c.width = round ? S + pad * 2 : names.length * S + (names.length - 1) * 12 + pad * 2;
  c.height = S + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (round) ctx.arc(c.width / 2, c.height / 2, c.width / 2 - 3, 0, Math.PI * 2);
  else ctx.roundRect(3, 3, c.width - 6, c.height - 6, c.height / 2.6);
  ctx.fill();
  if (border) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = border;
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  names.forEach((name, i) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, pad + i * (S + 12), pad, S, S);
      tex.needsUpdate = true;
    };
    img.src = `data:image/svg+xml,${encodeURIComponent(iconSVG(name, fg))}`;
  });
  const w = (height * c.width) / c.height;
  if (!sprite) return { texture: tex, width: w, height };
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(w, height, 1);
  return sp;
}
