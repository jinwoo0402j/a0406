// 화면 기호(client/icons.js): 호스트가 보낸 글이 HTML로 해석되지 않게
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, chip, icon } from '../client/icons.js';

test('esc: HTML 특수 문자를 글자로 바꾼다', () => {
  assert.equal(esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
});

test('chip: 이름·색에 HTML이 들어와도 태그가 생기지 않는다', () => {
  const html = chip('<b>x</b>', 'red;"><script>');
  assert.ok(!html.includes('<b>') && !html.includes('<script>'), html);
});

test('icon: 없는 이름이어도 빈 그림만 만든다', () => {
  assert.match(icon('없는그림'), /^<svg class="ic "[^>]*><\/svg>$/);
});
