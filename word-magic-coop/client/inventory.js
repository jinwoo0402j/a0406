// 마인크래프트식 가방(플레이어 인벤토리).
// - 가방 27칸 + 핫바 9칸(칸 번호 0~8이 핫바). 효과 단어는 한 칸에 하나, 수식 단어는 같은 단어끼리 한 칸에 겹친다.
// - 위쪽 주문 칸: [손] = 선택한 핫바 칸의 효과 단어, [수식 칸 5개] = 주문에 붙일 수식(갑옷 칸처럼 한 칸에 하나).
// - 주운 단어는 같은 묶음 → 핫바 빈칸 → 가방 빈칸 순서로 들어간다. 수식은 자동으로 붙지 않는다.
// 칸 배치는 이 화면(본인)만의 것이다. 서버에는 "손에 든 효과 + 수식 칸 단어들"(loadout)과 던지기만 보낸다.

import { WORDS, KIND } from '../shared/words.js';

export const HOTBAR = 9;
export const MAIN = 27;

const isMod = (w) => WORDS[w]?.kind === KIND.MOD;
const isEffect = (w) => WORDS[w]?.kind === KIND.EFFECT;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);


export class Inventory {
  constructor(modSlots) {
    this.modSlots = modSlots;
    this.slots = Array(HOTBAR + MAIN).fill(null); // { word, tokens: [] }
    this.sel = 0; // 선택한 핫바 칸(손)
    this.cursor = null; // 마우스에 든 단어 묶음 { word, tokens }
    this.mods = []; // 수식 칸(앞에서부터 채움)
    this.pendingMods = null; // 서버 반영을 기다리는 수식 칸 { mods, until }
    this.hidden = new Map(); // 던져서 서버 반영을 기다리는 단어 id → until
    this.lastSent = '';
    this.lastSentAt = 0;
  }

  // ------------------------------------------------------------ 서버 상태와 맞추기
  // ps: { e, m, inv }(서버), word(id): 단어 종류, now: 초
  sync(ps, word, now) {
    this._word = word;
    const owned = new Set(ps.inv);
    for (const [id, until] of this.hidden) if (!owned.has(id) || now > until) this.hidden.delete(id);
    if (this.pendingMods && (now > this.pendingMods.until || sameList(ps.m, this.pendingMods.mods))) this.pendingMods = null;
    this.mods = (this.pendingMods ? this.pendingMods.mods : ps.m).filter((id) => owned.has(id) && isMod(word(id)));
    const inMods = new Set(this.mods);
    const keep = (id) => owned.has(id) && !inMods.has(id) && !this.hidden.has(id);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      s.tokens = s.tokens.filter(keep);
      if (!s.tokens.length) this.slots[i] = null;
    }
    if (this.cursor) {
      this.cursor.tokens = this.cursor.tokens.filter(keep);
      if (!this.cursor.tokens.length) this.cursor = null;
    }
    const placed = new Set([...inMods, ...this.hidden.keys(), ...(this.cursor?.tokens || [])]);
    for (const s of this.slots) for (const id of s?.tokens || []) placed.add(id);
    for (const id of ps.inv) if (!placed.has(id)) this.add(id, word(id));
  }

  // 새 단어 넣기: 같은 수식 묶음 → 핫바 빈칸 → 가방 빈칸
  add(id, w) {
    if (isMod(w)) {
      const i = this.slots.findIndex((s) => s && s.word === w);
      if (i >= 0) { this.slots[i].tokens.push(id); return; }
    }
    const e = this.slots.findIndex((s) => !s);
    if (e >= 0) this.slots[e] = { word: w, tokens: [id] };
  }

  hand() {
    const s = this.slots[this.sel];
    return s && isEffect(s.word) ? s.tokens[0] : null;
  }

  // 서버에 보낼 장착(손 + 수식 칸). 서버와 다르면 반환
  wanted(ps, now) {
    const want = { effect: this.hand(), mods: [...this.mods] };
    const same = want.effect === (ps.e || null) && sameList(want.mods, ps.m);
    if (same) return null;
    const key = JSON.stringify(want);
    if (key === this.lastSent && now - this.lastSentAt < 0.4) return null;
    this.lastSent = key;
    this.lastSentAt = now;
    return want;
  }

  setMods(list, now) {
    this.mods = list;
    this.pendingMods = { mods: [...list], until: now + 1.5 };
  }

  // ------------------------------------------------------------ 핫바
  select(i) {
    this.sel = ((i % HOTBAR) + HOTBAR) % HOTBAR;
  }

  // 칸 i에서 하나(all이면 전부) 꺼내 던질 단어 id들. 서버 반영 전까지 숨긴다.
  takeForThrow(i, all, now) {
    const s = this.slots[i];
    if (!s) return [];
    const ids = all ? s.tokens.splice(0) : s.tokens.splice(s.tokens.length - 1, 1);
    if (!s.tokens.length) this.slots[i] = null;
    for (const id of ids) this.hidden.set(id, now + 1.5);
    return ids;
  }

  takeModForThrow(j, now) {
    const id = this.mods[j];
    if (!id) return [];
    this.setMods(this.mods.filter((x) => x !== id), now);
    this.hidden.set(id, now + 1.5);
    return [id];
  }

  takeCursorForThrow(all, now) {
    if (!this.cursor) return [];
    const ids = all ? this.cursor.tokens.splice(0) : this.cursor.tokens.splice(this.cursor.tokens.length - 1, 1);
    if (!this.cursor.tokens.length) this.cursor = null;
    for (const id of ids) this.hidden.set(id, now + 1.5);
    return ids;
  }

  // 창을 닫을 때 커서에 든 단어는 가방으로 돌려놓는다
  returnCursor() {
    if (!this.cursor) return;
    const { word, tokens } = this.cursor;
    this.cursor = null;
    for (const id of tokens) this.add(id, word);
  }

  // ------------------------------------------------------------ 클릭 규칙(마인크래프트)
  // 가방·핫바 칸: 좌클릭 = 집기 / 놓기·합치기 / 바꾸기, 우클릭 = 반 집기 / 하나 놓기, Shift+좌클릭 = 빠른 이동
  clickSlot(i, button, shift, now) {
    const s = this.slots[i];
    const c = this.cursor;
    if (shift && button === 0 && !c) return this.quickMove(i, now);
    if (!c) {
      if (!s) return false;
      if (button === 2 && s.tokens.length > 1) {
        const n = Math.ceil(s.tokens.length / 2); // 큰 쪽 반을 집는다
        this.cursor = { word: s.word, tokens: s.tokens.splice(s.tokens.length - n, n) };
      } else {
        this.cursor = s;
        this.slots[i] = null;
      }
      return true;
    }
    const stackable = s && s.word === c.word && isMod(c.word);
    if (button === 2) {
      if (!s || stackable) {
        const one = c.tokens.pop();
        if (s) s.tokens.push(one);
        else this.slots[i] = { word: c.word, tokens: [one] };
        if (!c.tokens.length) this.cursor = null;
        return true;
      }
    } else if (!s) {
      this.slots[i] = c;
      this.cursor = null;
      return true;
    } else if (stackable) {
      s.tokens.push(...c.tokens);
      this.cursor = null;
      return true;
    }
    // 다른 단어면 바꾼다
    this.slots[i] = c;
    this.cursor = s;
    return true;
  }

  // Shift+클릭: 수식은 빈 수식 칸으로, 그 밖에는 핫바 ↔ 가방
  quickMove(i, now) {
    const s = this.slots[i];
    if (!s) return false;
    if (isMod(s.word) && this.mods.length < this.modSlots) {
      const room = this.modSlots - this.mods.length;
      const moved = s.tokens.splice(0, room);
      if (!s.tokens.length) this.slots[i] = null;
      this.setMods([...this.mods, ...moved], now);
      return true;
    }
    const [from, to] = i < HOTBAR ? [HOTBAR, HOTBAR + MAIN] : [0, HOTBAR];
    if (isMod(s.word)) {
      for (let k = from; k < to; k++) {
        if (this.slots[k]?.word === s.word) { this.slots[k].tokens.push(...s.tokens); this.slots[i] = null; return true; }
      }
    }
    for (let k = from; k < to; k++) {
      if (!this.slots[k]) { this.slots[k] = s; this.slots[i] = null; return true; }
    }
    return false;
  }

  // 수식 칸 j: 한 칸에 하나. 수식 단어만 들어간다.
  clickMod(j, button, shift, now) {
    const id = this.mods[j];
    const c = this.cursor;
    if (!c) {
      if (!id) return false;
      const w = this.wordOf(id);
      this.setMods(this.mods.filter((x) => x !== id), now);
      if (shift) this.add(id, w);
      else this.cursor = { word: w, tokens: [id] };
      return true;
    }
    if (!isMod(c.word)) return 'reject';
    if (!id) {
      if (this.mods.length >= this.modSlots) return 'reject';
      const one = c.tokens.pop();
      if (!c.tokens.length) this.cursor = null;
      this.setMods([...this.mods, one], now);
      return true;
    }
    if (c.tokens.length !== 1) return 'reject';
    const w = this.wordOf(id);
    this.setMods(this.mods.map((x) => (x === id ? c.tokens[0] : x)), now);
    this.cursor = { word: w, tokens: [id] };
    return true;
  }

  // 손 칸: 선택한 핫바 칸과 같은 칸. 효과 단어만 들어간다.
  clickHand(button, shift, now) {
    const c = this.cursor;
    if (c && !isEffect(c.word)) return 'reject';
    const s = this.slots[this.sel];
    if (!c && s && !isEffect(s.word)) return 'reject';
    return this.clickSlot(this.sel, button, shift, now);
  }

  // ------------------------------------------------------------ 끌기·두 번 클릭(마인크래프트)
  // 커서에 든 묶음을 끌어서 놓을 수 있는 칸: 가방·핫바의 빈칸이나 같은 수식 묶음, 빈 수식 칸(수식만)
  canDrag(area, i) {
    const c = this.cursor;
    if (!c) return false;
    if (area === 'mod') return isMod(c.word) && i >= this.mods.length && i < this.modSlots;
    if (area !== 'inv') return false;
    const s = this.slots[i];
    return !s || (s.word === c.word && isMod(c.word));
  }

  // 끌어서 나눠 놓기: 좌클릭으로 끌면 고르게 나누고(남는 건 커서에), 우클릭으로 끌면 칸마다 하나.
  // 커서에 든 개수보다 많은 칸은 무시한다. 수식 칸은 한 칸에 하나.
  dragPlace(targets, button, now) {
    const c = this.cursor;
    if (!c) return false;
    const seen = new Set();
    const list = targets.filter((t) => {
      const k = `${t.area}:${t.i}`;
      if (seen.has(k) || !this.canDrag(t.area, t.i)) return false;
      seen.add(k);
      return true;
    }).slice(0, c.tokens.length);
    if (!list.length) return false;
    const per = button === 2 ? 1 : Math.floor(c.tokens.length / list.length);
    const mods = [...this.mods];
    for (const t of list) {
      const n = t.area === 'mod' ? Math.min(per, 1) : per;
      if (n < 1) continue;
      const ids = c.tokens.splice(c.tokens.length - n, n);
      if (t.area === 'mod') mods.push(...ids);
      else if (this.slots[t.i]) this.slots[t.i].tokens.push(...ids);
      else this.slots[t.i] = { word: c.word, tokens: ids };
    }
    if (mods.length !== this.mods.length) this.setMods(mods, now);
    if (!c.tokens.length) this.cursor = null;
    return true;
  }

  // 두 번 클릭: 커서에 든 수식과 같은 단어를 가방·핫바에서 모두 모은다(수식 칸에 붙인 것은 그대로)
  collect() {
    const c = this.cursor;
    if (!c || !isMod(c.word)) return false;
    let got = false;
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[k];
      if (s && s.word === c.word) {
        c.tokens.push(...s.tokens);
        this.slots[k] = null;
        got = true;
      }
    }
    return got;
  }

  // 칸 위에서 숫자키: 그 칸과 핫바 n번 칸을 바꾼다
  swapWithHotbar(i, n) {
    if (i === n) return false;
    const t = this.slots[i];
    this.slots[i] = this.slots[n];
    this.slots[n] = t;
    return true;
  }

  wordOf(id) {
    return this._word?.(id);
  }
}
