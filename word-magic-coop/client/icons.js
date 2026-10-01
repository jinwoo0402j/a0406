// 화면 기호(아이콘). 글자 대신 쓰는 작은 SVG. 색은 currentColor를 따른다.
// 단어(밀치기·큰 …)는 게임의 내용이라 글자로 두고, 그 밖의 안내·상태·조작을 기호로 바꾼다.

const P = {
  aim: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  self: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20c0-4 3-7 7-7s7 3 7 7"/>',
  near: '<circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/>',
  push: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M3 7h4M3 17h4"/>',
  pull: '<path d="M20 12H8M12 6l-6 6 6 6"/><path d="M17 7h4M17 17h4"/>',
  lift: '<path d="M12 20V7M6 12l6-6 6 6"/><path d="M5 21h14"/>',
  fire: '<path d="M12 3c1 4 6 5 6 11a6 6 0 0 1-12 0c0-3 2-4 2-7 2 1 3 2 3 4 1-2 1-5 1-8z"/>',
  big: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  strong: '<path d="M13 2 5 13h6l-1 9 8-11h-6z"/>',
  hand: '<ellipse cx="12" cy="15" rx="5" ry="4.2"/><circle cx="6.5" cy="9" r="1.8"/><circle cx="10" cy="6.5" r="1.8"/><circle cx="14" cy="6.5" r="1.8"/><circle cx="17.5" cy="9" r="1.8"/>',
  bag: '<path d="M5 9h14l-1 11H6z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/>',
  wand: '<path d="M4 20 15 9"/><path d="M17 3l.8 2.2L20 6l-2.2.8L17 9l-.8-2.2L14 6l2.2-.8z" fill="currentColor"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M12 9v11M4 13h16"/><path d="M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0"/>',
  leaf: '<path d="M5 19C5 10 11 5 20 5c0 9-5 15-14 14z"/><path d="M5 19 14 10"/>',
  mouseL: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12"/><path d="M6.5 9.5V8a5.5 5.5 0 0 1 5.5-5v7z" fill="currentColor" stroke="none"/>',
  mouseR: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12"/><path d="M17.5 9.5V8A5.5 5.5 0 0 0 12 3v7z" fill="currentColor" stroke="none"/>',
  wheel: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 6v4"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z"/>',
  slow: '<path d="M4 17h12a4 4 0 0 0 0-8 3 3 0 0 0-3 3 2 2 0 0 0 2 2"/><path d="M16 9l1-4M19 10l2-3"/>',
  up: '<path d="M6 13l6-6 6 6M6 19l6-6 6 6"/>',
  ok: '<path d="M5 12.5 10 17l9-10"/>',
  no: '<path d="M7 7l10 10M17 7 7 17"/>',
  star: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z" fill="currentColor"/>',
  sound: '<path d="M4 10h4l5-4v12l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  walk: '<ellipse cx="8" cy="8" rx="2.4" ry="3.4"/><ellipse cx="16" cy="15" rx="2.4" ry="3.4"/>',
  throw: '<path d="M5 18c2-7 7-10 13-10"/><path d="M14 4l4 4-4 4"/>',
  jump: '<path d="M12 4v10M8 8l4-4 4 4"/><path d="M5 20h14"/>',
  release: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8" transform="rotate(45 12 12)"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
  arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  equals: '<path d="M5 9h14M5 15h14"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  half: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  people: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-4 3-6 6-6s6 2 6 6M10 20c0-4 3-6 6-6s6 2 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  restart: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  weight: '<path d="M7 10h10l2 10H5z"/><path d="M9 10a3 3 0 0 1 6 0"/>',
  wall: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 12h18M9 5v7M15 12v7"/>',
  down: '<path d="M6 11l6 6 6-6M6 5l6 6 6-6"/>',
  in: '<path d="M10 4h8v16h-8"/><path d="M3 12h10M9 8l4 4-4 4"/>',
  out: '<path d="M14 4H6v16h8"/><path d="M11 12h10M17 8l4 4-4 4"/>',
  far: '<circle cx="5" cy="12" r="2" fill="currentColor"/><path d="M9 12h2M14 12h2"/><circle cx="20" cy="12" r="2"/>',
  boom: '<path d="M12 2l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z"/>',
  rock: '<path d="M4 18l2-7 5-4 6 2 3 6-2 3z"/>',
  box: '<rect x="4" y="5" width="16" height="15" rx="1.5"/><path d="M4 5l16 15M20 5 4 20"/>',
  dummy: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1.9-1.1 1.8"/><circle cx="12" cy="17" r="1" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  split: '<path d="M3 12h6"/><path d="M9 12l9-6M9 12h9M9 12l9 6"/><circle cx="18" cy="6" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="18" r="1.4" fill="currentColor"/>',
  gather: '<circle cx="5" cy="6" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="5" cy="18" r="1.4" fill="currentColor"/><path d="M6 6l9 6M6 12h9M6 18l9-6"/><path d="M15 12h6"/>',
  dots: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  grab: '<ellipse cx="12" cy="14" rx="6" ry="5"/><path d="M8 9.5V7M11 9V6M14 9V6.5M16.5 10V8"/>',
};

export const ICON_NAMES = Object.keys(P);

// 따로 쓰는 SVG 문서(3D 표지판·손에 든 단어처럼 캔버스에 그릴 때)
export function iconSVG(name, color = '#ffffff', width = 2.4) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96" color="${color}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

// 글을 HTML에 넣을 때(호스트가 보낸 이름·이유 등)
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 키 모양
export function key(label) {
  return `<kbd class="kc">${label}</kbd>`;
}

// 사람 칩(자리 색 + 글자)
export function chip(id, color, cls = '') {
  return `<span class="pc ${esc(cls)}" style="--c:${esc(color)}">${esc(id)}</span>`;
}

export const EFFECT_ICON = { PUSH: 'push', PULL: 'pull', LIFT: 'lift', FIREBALL: 'fire', BIG: 'big', STRONG: 'strong' };
export const MODE_ICON = { AIM: 'aim', SELF: 'self', NEAR: 'near' };
