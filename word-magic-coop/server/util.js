// 서버 모듈이 같이 쓰는 작은 도우미

export const r3 = (v) => Math.round(v * 1000) / 1000;
export const validVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
