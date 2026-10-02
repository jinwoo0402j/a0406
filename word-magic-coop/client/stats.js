// 판 요약: 플레이테스트에서 기억 대신 기록으로 본다
// (v0.2 08: 친구·사물에 고루 쓰는지, 교환하는지, 사고가 나는지 / v0.5: 세계에서 단어를 얻고 섞는지).
// 호스트가 보낸 이벤트만 보고 센다(판정에는 쓰지 않는다).
import { SEAT_IDS } from '../shared/level.js';
import { WORDS, MODE_LABEL } from '../shared/words.js';
import { icon } from './icons.js';

const now = () => performance.now();

export class PlayStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.start = now();
    this.per = {};
    this.colift = 0;
    this.friendFire = 0;
    this.enemyHit = 0;
    this.release = 0;
    this.fall = 0;
    this.clearedAt = null;
  }

  of(pid) {
    if (!this.per[pid]) this.per[pid] = { casts: {}, friend: 0, object: 0, self: 0, pickup: 0, give: 0, world: 0, mix: 0 };
    return this.per[pid];
  }

  countTargets(st, by, ids) {
    for (const id of ids || []) {
      if (id === by) st.self += 1;
      else if (SEAT_IDS.includes(id)) st.friend += 1;
      else st.object += 1;
    }
  }

  record(e) {
    switch (e.k) {
      case 'cast': {
        const st = this.of(e.by);
        const name = `${WORDS[e.effect].label}${e.mode !== 'AIM' ? `(${MODE_LABEL[e.mode]})` : ''}`;
        st.casts[name] = (st.casts[name] || 0) + 1;
        this.countTargets(st, e.by, e.targets);
        break;
      }
      case 'liftStart': {
        const st = this.of(e.by);
        const name = `들기${e.mode && e.mode !== 'AIM' ? `(${MODE_LABEL[e.mode]})` : ''}`;
        st.casts[name] = (st.casts[name] || 0) + 1;
        this.countTargets(st, e.by, e.targets || [e.target]);
        this.colift += (e.joined || []).length;
        break;
      }
      case 'boom':
        for (const h of e.hits) {
          if (h.effects.includes('debuff')) this.friendFire += 1;
          if (h.effects.includes('damage')) this.enemyHit += 1;
          if (e.by && h.id !== e.by) this.countTargets(this.of(e.by), e.by, [h.id]);
        }
        break;
      case 'pickup':
        this.of(e.by).pickup += 1;
        if (e.from) this.of(e.from).give += 1; // 던진 단어를 친구가 주움 = 건네줌
        break;
      // 세계에서 얻은 단어(뽑아내기·부수기)와 섞기
      case 'extract': this.of(e.by).world += 1; break;
      case 'chip': if (e.by && e.words?.length) this.of(e.by).world += e.words.length; break;
      case 'react': this.of(e.by).mix += 1; break;
      case 'release': this.release += 1; break;
      case 'recover': if (SEAT_IDS.includes(e.id)) this.fall += 1; break;
      case 'clear': if (!this.clearedAt) this.clearedAt = now(); break;
      case 'restart': this.reset(); break;
      default: break;
    }
  }

  seconds() {
    return Math.round(((this.clearedAt || now()) - this.start) / 1000);
  }

  // 복사해서 전하는 글 요약
  text() {
    const sec = this.seconds();
    const lines = [`${this.clearedAt ? '도착까지' : '지금까지'} ${Math.floor(sec / 60)}분 ${sec % 60}초`];
    for (const pid of SEAT_IDS) {
      const st = this.per[pid];
      if (!st) continue;
      const total = Object.values(st.casts).reduce((a, b) => a + b, 0);
      const kinds = Object.entries(st.casts).map(([k, n]) => `${k} ${n}`).join(', ');
      lines.push(`${pid}: 주문 ${total}번${kinds ? ` (${kinds})` : ''} · 친구에게 ${st.friend} · 물건·적에게 ${st.object} · 나에게 ${st.self} · 단어 줍기 ${st.pickup} · 건네준 단어 ${st.give} · 세계에서 얻은 단어 ${st.world} · 섞기 ${st.mix}`);
    }
    lines.push(`같이 들기 ${this.colift}번 · 친구가 파이어볼에 맞음 ${this.friendFire}번 · 적 명중 ${this.enemyHit}번 · R로 풀기 ${this.release}번 · 떨어짐 ${this.fall}번`);
    return lines.join('\n');
  }

  // 도착 화면: 사람마다 기호 + 숫자. pc(pid) = 사람 칩
  html(pc) {
    const sec = this.seconds();
    const n = (ic, v, title) => `<span title="${title}">${[].concat(ic).map((x) => icon(x)).join('')}${v}</span>`;
    const rows = [`<div class="cs-time">${icon('clock')} ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}</div>`];
    for (const pid of SEAT_IDS) {
      const st = this.per[pid];
      if (!st) continue;
      const total = Object.values(st.casts).reduce((a, b) => a + b, 0);
      rows.push(`<div class="cs-row">${pc(pid)}${n('wand', total, '주문')}${n('people', st.friend, '친구에게')}${n('box', st.object, '물건·적에게')}${n('self', st.self, '나에게')}${n('leaf', st.pickup, '줍기')}${n('throw', st.give, '건네준 단어')}${n(['pull', 'star'], st.world, '세계에서 얻은 단어')}${n('mix', st.mix, '섞기')}</div>`);
    }
    rows.push(`<div class="cs-row all">${n(['lift', 'people'], this.colift, '같이 들기')}${n(['fire', 'people'], this.friendFire, '친구가 파이어볼에 맞음')}${n('dummy', this.enemyHit, '적 명중')}${n('release', this.release, 'R로 풀기')}${n('down', this.fall, '떨어짐')}</div>`);
    return rows.join('');
  }
}
