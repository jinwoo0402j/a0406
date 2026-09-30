// 캔버스로 한글 라벨 텍스처를 만든다(단어 카드, 이름표, 구역 이름).
import * as THREE from 'three';

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
