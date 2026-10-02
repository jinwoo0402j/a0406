// v0.5 세계의 성질을 단어로: 바위 부수기 → <큰>, 모닥불·샘 당기기 → <불>·<물>, 추운 곳의 물 → 얼음,
// 섞기(<물> + <불> → <수증기>, 순서 무관), 새 효과 <물>·<불>·<수증기>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNING } from '../shared/tuning.js';
import { REASON } from '../shared/targeting.js';
import { reactionFor } from '../shared/words.js';
import { newGame, run, place, cast, bottom, assertTokenInvariant } from './helpers.js';

const CD = TUNING.castCooldown + 0.02;
let n = 0;

// 단어를 바로 쥐여 준다(효과면 손에 든다)
function give(g, pid, word) {
  const t = g.makeToken({ id: `x${n++}`, word }, pid);
  g.tokens.push(t);
  g.receiveToken(pid, t);
  return t.id;
}
function hold(g, pid, word) {
  const id = give(g, pid, word);
  assert.ok(g.handle(pid, { t: 'equip', slot: 'effect', token: id }).ok);
  return id;
}
const born = (g, word) => g.tokens.filter((t) => t.id.startsWith('n') && t.word === word);

test('조합은 놓은 순서가 아니라 종류와 개수로 정해진다', () => {
  assert.equal(reactionFor(['WATER', 'FIRE'])?.makes, 'STEAM');
  assert.equal(reactionFor(['FIRE', 'WATER'])?.makes, 'STEAM');
  assert.equal(reactionFor(['WATER', 'WATER', 'FIRE']), null, '개수가 다르면 다른 조합');
  assert.equal(reactionFor(['WATER']), null);
  assert.equal(reactionFor(['WATER', 'NOPE']), null);
  // 수식도 칸 순서와 상관없이 개수만 센다
  const g = newGame();
  const b = give(g, 'A', 'BIG');
  const s = give(g, 'A', 'STRONG');
  assert.ok(g.handle('A', { t: 'loadout', effect: 't1', mods: [b, s] }).ok);
  const one = g.modCounts('A');
  assert.ok(g.handle('A', { t: 'loadout', effect: 't1', mods: [s, b] }).ok);
  assert.deepEqual(g.modCounts('A'), one);
});

test('커다란 바위를 밀치기로 조금씩 부수면 작아지며 <큰>이 떨어지고, 다 부서지면 사라진다', () => {
  const g = newGame();
  const rock = g.body('boulder');
  place(g, 'A', [-3.2, 0, 8.6]);
  run(g, 0.3);
  const h0 = rock.half[1];
  // 밀치기는 바위를 밀지 못하고 깎는다
  const x0 = rock.pos[0];
  assert.ok(cast(g, 'A', 'boulder').ok);
  run(g, 0.3);
  assert.equal(rock.pos[0], x0, '박혀 있어 밀리지 않는다');
  assert.ok(rock.hp < TUNING.boulderHp);
  let casts = 1;
  while (g.body('boulder') && casts < 20) {
    run(g, CD);
    place(g, 'A', [g.body('boulder').pos[0] + g.body('boulder').half[0] + 1.2, 0, 8.6]);
    assert.ok(cast(g, 'A', 'boulder').ok);
    casts += 1;
    if (born(g, 'BIG').length === 1 && g.body('boulder')) assert.ok(g.body('boulder').half[1] < h0, '단계가 내려가면 작아진다');
  }
  assert.equal(g.body('boulder'), undefined, '다 부서져 사라진다');
  assert.equal(casts, Math.ceil(TUNING.boulderHp / TUNING.boulderPushHit));
  assert.equal(born(g, 'BIG').length, TUNING.boulderStages, '단계마다 <큰> 하나');
  assert.ok(g.events.some((e) => e.k === 'shatter'));
  // 떨어진 단어는 시전자 쪽으로 튀어 와 땅에 내려앉는다(닿으면 주워진다)
  run(g, 1.5);
  for (const t of born(g, 'BIG')) assert.ok(t.owner === 'A' || (t.pos && t.pos[1] < 0.05), '주웠거나 땅에 떨어졌다');
  assert.ok(born(g, 'BIG').some((t) => t.owner === 'A'), '가까이 있으면 주워진다');
  assertTokenInvariant(assert, g, g.tokens.length);
});

test('파이어볼 폭발도 바위를 깎는다', () => {
  const g = newGame();
  hold(g, 'A', 'FIREBALL');
  place(g, 'A', [-1.5, 0, 8.6]);
  run(g, 0.3);
  assert.ok(cast(g, 'A', 'boulder').ok);
  run(g, 1);
  assert.equal(g.body('boulder').hp, TUNING.boulderHp - TUNING.fireballDamage);
});

test('모닥불을 당기면 <불>이 나오고 불이 꺼진다 · 꺼진 동안은 못 뽑고, 다시 붙으면 또 나온다', () => {
  const g = newGame();
  place(g, 'A', [3, 0, 8.6]);
  run(g, 0.3);
  hold(g, 'A', 'PULL');
  const r = cast(g, 'A', 'campfire');
  assert.ok(r.ok);
  assert.equal(born(g, 'FIRE').length, 1);
  assert.ok(g.body('campfire').empty, '꺼짐');
  assert.ok(g.events.some((e) => e.k === 'extract' && e.word === 'FIRE'));
  // 단어는 시전자 쪽으로 튀어 와서 닿으면 주워진다
  run(g, 2);
  assert.equal(born(g, 'FIRE')[0].owner, 'A', '튀어 와서 주워진다');
  run(g, CD);
  assert.equal(cast(g, 'A', 'campfire').reason, REASON.SOURCE_EMPTY);
  // <불>로 다시 붙이고 또 뽑는다
  run(g, CD);
  assert.ok(g.handle('A', { t: 'equip', slot: 'effect', token: born(g, 'FIRE')[0].id }).ok);
  assert.ok(cast(g, 'A', 'campfire').ok);
  assert.equal(g.body('campfire').empty, false, '<불>로 다시 붙는다');
  run(g, CD);
  hold(g, 'A', 'PULL');
  assert.ok(cast(g, 'A', 'campfire').ok);
  assert.equal(born(g, 'FIRE').length, 2);
  // 시간이 지나도 다시 붙는다. 한 판에 내주는 수에는 끝이 있다
  run(g, TUNING.sourceRefill + 0.1);
  assert.equal(g.body('campfire').empty, false);
  assert.ok(cast(g, 'A', 'campfire').ok);
  run(g, TUNING.sourceRefill + 0.1);
  assert.equal(cast(g, 'A', 'campfire').reason, REASON.SOURCE_EMPTY, `한 판에 ${TUNING.sourceYields}개까지`);
});

test('샘을 당기면 <물>, 물을 쏘면 모닥불이 꺼지고 빈 샘은 찬다, 본인에게 끼얹으면 그을림이 씻긴다', () => {
  const g = newGame();
  place(g, 'A', [-4.2, 0, 21]);
  run(g, 0.3);
  hold(g, 'A', 'PULL');
  assert.ok(cast(g, 'A', 'well').ok);
  assert.equal(born(g, 'WATER').length, 1);
  assert.ok(g.body('well').empty);
  // 물을 쏘면 빈 샘이 찬다
  run(g, CD);
  hold(g, 'A', 'WATER');
  assert.ok(cast(g, 'A', 'well').ok);
  run(g, 0.5);
  assert.equal(g.body('well').empty, false);
  // 모닥불 끄기(뽑지 않고 끈 것이라 단어는 안 나온다)
  place(g, 'A', [3, 0, 8.6]);
  run(g, CD);
  assert.ok(cast(g, 'A', 'campfire').ok);
  run(g, 0.5);
  assert.ok(g.body('campfire').empty, '물에 꺼진다');
  assert.equal(born(g, 'FIRE').length, 0);
  // 그을림 씻기
  g.body('A').debuffUntil = g.time + 5;
  run(g, CD);
  const r = cast(g, 'A', null, { mode: 'SELF' });
  assert.ok(r.ok && r.washed);
  assert.equal(g.body('A').debuffUntil, 0);
});

test('추운 곳에 <물>을 쏘면 얼음이 생기고, 얼음은 <불>에 녹고 추운 곳 밖에서는 저절로 녹는다', () => {
  const g = newGame();
  place(g, 'A', [-5.5, 0, 25]);
  run(g, 0.3);
  hold(g, 'A', 'WATER');
  const c = g.body('A').pos;
  // 눈밭의 앞쪽 바닥을 겨눈다
  assert.ok(g.handle('A', { t: 'cast', mode: 'AIM', origin: [...c], dir: [0, -0.35, 1] }).ok);
  run(g, 1);
  const ice = g.bodies.find((b) => b.kind === 'ice');
  assert.ok(ice, '얼음이 생긴다');
  assert.ok(ice.pos[2] > 24 && ice.pos[0] < -3, '눈밭 안');
  assert.ok(bottom(ice) < 0.05, '땅 위에');
  // 눈밭 밖에서 쏜 물은 얼지 않는다
  place(g, 'A', [0, 0, 15]);
  run(g, CD);
  const c2 = g.body('A').pos;
  assert.ok(g.handle('A', { t: 'cast', mode: 'AIM', origin: [...c2], dir: [0, -0.35, 1] }).ok);
  run(g, 1);
  assert.equal(g.bodies.filter((b) => b.kind === 'ice').length, 1);
  // <불>로 녹인다
  place(g, 'A', [ice.pos[0] + 2, 0, ice.pos[2]]);
  run(g, CD);
  hold(g, 'A', 'FIRE');
  assert.ok(cast(g, 'A', ice.id).ok);
  assert.equal(g.body(ice.id), undefined, '녹아 사라진다');
  assert.ok(g.events.some((e) => e.k === 'melt'));
  // 추운 곳 밖으로 옮기면 저절로 녹는다
  const ice2 = g.activate('ice', [0, 0, 15], 'A');
  assert.ok(ice2);
  run(g, TUNING.iceMelt - 1);
  assert.ok(g.body(ice2.id), '아직');
  run(g, 1.2);
  assert.equal(g.body(ice2.id), undefined, '녹았다');
});

test('섞기: <물> + <불> → <수증기> (순서 무관), 맞지 않으면 그대로', () => {
  const g = newGame();
  const before = g.tokens.length;
  const w = give(g, 'A', 'WATER');
  const f = give(g, 'A', 'FIRE');
  const p = give(g, 'A', 'PUSH');
  assert.equal(g.handle('A', { t: 'react', tokens: [w, p] }).ok, false, '반응 없음');
  assert.equal(g.handle('B', { t: 'react', tokens: [f, w] }).ok, false, '남의 단어');
  const r = g.handle('A', { t: 'react', tokens: [f, w] });
  assert.ok(r.ok);
  assert.equal(r.word, 'STEAM');
  assert.equal(g.token(w), undefined);
  assert.equal(g.token(f), undefined);
  assert.equal(g.token(r.token).owner, 'A');
  assert.equal(g.tokens.length, before + 2, '두 단어가 하나가 된다');
  assertTokenInvariant(assert, g, before + 2);
});

test('<수증기>: 친구를 위로 띄운다(본인 모드는 없음)', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 5]); place(g, 'B', [0, 0, 7]);
  run(g, 0.3);
  hold(g, 'A', 'STEAM');
  assert.equal(cast(g, 'A', null, { mode: 'SELF' }).ok, false);
  assert.ok(cast(g, 'A', 'B').ok);
  let top = 0;
  run(g, 1, () => { top = Math.max(top, bottom(g.body('B'))); });
  assert.ok(top > 1 && top < 1.6, `약 1.2m 뜬다 ${top.toFixed(2)}`);
  // 박힌 것(바위)은 못 띄운다
  run(g, CD);
  place(g, 'A', [-3.2, 0, 8.6]);
  run(g, 0.2);
  assert.equal(cast(g, 'A', 'boulder').reason, REASON.NOT_MOVABLE);
});

test('들기로 바위·모닥불·샘은 들 수 없다', () => {
  const g = newGame();
  place(g, 'B', [-3.2, 0, 8.6]);
  run(g, 0.3);
  assert.equal(cast(g, 'B', 'boulder').reason, REASON.NOT_LIFTABLE);
});

test('생긴 현상 거두기: 얼음을 당기면 <차가운>(얼음은 녹음), 불에 녹은 얼음의 김을 당기면 <수증기>', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 15]);
  run(g, 0.3);
  hold(g, 'A', 'PULL');
  const ice = g.activate('ice', [2.5, 0, 15], 'A');
  assert.ok(ice);
  assert.ok(cast(g, 'A', ice.id).ok);
  assert.equal(born(g, 'COLD').length, 1, '차가움을 뽑아낸다');
  assert.equal(g.body(ice.id), undefined, '얼음은 녹는다');
  assert.ok(!g.bodies.some((b) => b.kind === 'steamcloud'), '당겨서 녹이면 김은 안 난다');
  // <불>로 녹이면 김이 피어오른다
  run(g, CD);
  const ice2 = g.activate('ice', [2.5, 0, 15], 'A');
  hold(g, 'A', 'FIRE');
  assert.ok(cast(g, 'A', ice2.id).ok);
  const cloud = g.bodies.find((b) => b.kind === 'steamcloud');
  assert.ok(cloud, '김이 생긴다');
  // 김은 부딪히지 않는다: 걸어서 지나가고, 다른 마법의 조준선도 막지 않는다
  run(g, CD);
  hold(g, 'A', 'PUSH');
  place(g, 'B', [cloud.pos[0] + 1.5, 0, 15]);
  run(g, 0.2);
  const r = cast(g, 'A', 'B');
  assert.ok(r.ok && r.targets.includes('B'), '김 너머 친구를 민다');
  // <당기기>로 거둔다
  run(g, CD);
  hold(g, 'A', 'PULL');
  place(g, 'B', [0, 0, 18]);
  run(g, 0.2);
  assert.ok(cast(g, 'A', cloud.id).ok);
  assert.equal(born(g, 'STEAM').length, 1);
  assert.equal(g.body(cloud.id), undefined);
});

test('김은 잠깐 뒤 흩어지고, 물에 꺼진 모닥불에서도 피어오른다', () => {
  const g = newGame();
  place(g, 'A', [3, 0, 8.6]);
  run(g, 0.3);
  hold(g, 'A', 'WATER');
  assert.ok(cast(g, 'A', 'campfire').ok);
  run(g, 0.5);
  const cloud = g.bodies.find((b) => b.kind === 'steamcloud');
  assert.ok(cloud && cloud.pos[1] > 0.5, '모닥불 위에 김');
  run(g, TUNING.steamLife);
  assert.ok(!g.bodies.some((b) => b.kind === 'steamcloud'), '흩어졌다');
});

test('<차가운>을 붙인 <물>은 추운 곳이 아니어도 언다', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 15]);
  run(g, 0.3);
  hold(g, 'A', 'WATER');
  const c = give(g, 'A', 'COLD');
  assert.ok(g.handle('A', { t: 'loadout', effect: g.players.A.slots.effect, mods: [c] }).ok);
  const p = g.body('A').pos;
  assert.ok(g.handle('A', { t: 'cast', mode: 'AIM', origin: [...p], dir: [0, -0.35, 1] }).ok);
  run(g, 1);
  const ice = g.bodies.find((b) => b.kind === 'ice');
  assert.ok(ice && ice.pos[2] > 15 && ice.pos[2] < 20, '앞 바닥에 얼음');
  run(g, TUNING.iceMelt + 0.2);
  assert.equal(g.body(ice.id), undefined, '추운 곳 밖이라 곧 녹는다');
});

test('수식이 들어간 반응: <큰> + <불> → <파이어볼>, <수증기> + <차가운> → <물>', () => {
  const g = newGame();
  const r1 = g.handle('A', { t: 'react', tokens: [give(g, 'A', 'BIG'), give(g, 'A', 'FIRE')] });
  assert.equal(r1.word, 'FIREBALL');
  const r2 = g.handle('A', { t: 'react', tokens: [give(g, 'A', 'COLD'), give(g, 'A', 'STEAM')] });
  assert.equal(r2.word, 'WATER');
  assert.equal(reactionFor(['BIG', 'BIG', 'FIRE']), null, '개수가 다르면 반응 없음');
});

test('얼음·김에서 거두는 단어도 한 판에 정한 수까지', () => {
  const g = newGame();
  place(g, 'A', [0, 0, 15]);
  run(g, 0.3);
  hold(g, 'A', 'PULL');
  for (let i = 0; i < TUNING.sourceYields; i++) {
    const ice = g.activate('ice', [2.5, 0, 15], 'A');
    assert.ok(cast(g, 'A', ice.id).ok);
    run(g, CD);
  }
  // 더는 안 나오고, 얼음은 보통 물체처럼 끌려온다
  const ice = g.activate('ice', [2.5, 0, 15], 'A');
  assert.ok(cast(g, 'A', ice.id).ok);
  assert.equal(born(g, 'COLD').length, TUNING.sourceYields);
  assert.ok(g.body(ice.id) && ice.ext[0] < 0, '끌려온다');
});
