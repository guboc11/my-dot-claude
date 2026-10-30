import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMode, rejectLegacyAppend, withLineNumbers } from '../lib.mjs';

test('G7: append는 양 끝에 빈 줄 하나를 사이에 두고 붙입니다', () => {
  assert.equal(applyMode('기존', { mode: 'append', text: '추가' }), '기존\n\n추가');
  assert.equal(applyMode('기존', { mode: 'append', at: 'start', text: '추가' }), '추가\n\n기존');
  assert.equal(applyMode('', { mode: 'append', text: '추가' }), '추가');
  assert.equal(applyMode('기존', { mode: 'append', text: '' }), '기존');
});

test('G7: append 의 gap:false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다', () => {
  const row = '| 시각 | 누가 | 무엇 |';
  const table = `| 머리 |\n|---|\n${row}`;

  // 기본은 그대로 빈 줄 하나입니다 — gap 을 안 주면 아무것도 달라지지 않습니다.
  assert.equal(applyMode('기존', { mode: 'append', text: '추가', gap: true }), '기존\n\n추가');
  // false 면 줄바꿈 하나입니다. 표에 행을 붙여도 표가 끊기지 않습니다(백로그 15).
  assert.equal(applyMode(table, { mode: 'append', text: row, gap: false }), `${table}\n${row}`);
  assert.equal(applyMode('기존', { mode: 'append', at: 'start', text: '추가', gap: false }), '추가\n기존');
  // 빈 본문과 빈 글은 gap 과 상관없이 그대로입니다 — 이을 자리가 없기 때문입니다.
  assert.equal(applyMode('', { mode: 'append', text: '추가', gap: false }), '추가');
  assert.equal(applyMode('기존', { mode: 'append', text: '', gap: false }), '기존');

  // append 가 아닌 곳에서는 거절합니다. 종류를 도구가 추측하지 않습니다.
  for (const mode of ['replace', 'edit']) {
    assert.throws(
      () => applyMode('기존', mode === 'edit'
        ? { mode, old: '기존', new: '새', gap: false }
        : { mode, text: '새', gap: false }),
      /gap 은 mode:"append" 에서만 씁니다/,
    );
  }
  assert.throws(() => applyMode('기존', { mode: 'append', text: '추가', gap: 'false' }), /gap 은 boolean 이어야 합니다/);
});

test('G7: edit는 정확한 문자열을 치환하고 나머지 본문을 보존합니다', () => {
  const source = '앞줄\n상한 50MB\n뒷줄';
  assert.equal(applyMode(source, { mode: 'edit', old: '50MB', new: '100MB' }), '앞줄\n상한 100MB\n뒷줄');
  assert.equal(applyMode('50MB / 50MB', { mode: 'edit', old: '50MB', new: '100MB', replace_all: true }), '100MB / 100MB');
  assert.equal(applyMode('앞 삭제 뒤', { mode: 'edit', old: '삭제 ', new: '' }), '앞 뒤');
  assert.equal(applyMode('기존', { mode: 'edit', old: '기존', new: '$& $1 $$' }), '$& $1 $$');
});

test('G7: edit는 본문의 첫 줄·중간·끝과 빈 본문에 삽입합니다', () => {
  const source = '첫 줄\n끝 줄';
  assert.equal(applyMode(source, { mode: 'edit', insert_after: 0, text: '앞' }), '앞\n첫 줄\n끝 줄');
  assert.equal(applyMode(source, { mode: 'edit', insert_after: 1, text: '중간\n두 줄' }), '첫 줄\n중간\n두 줄\n끝 줄');
  assert.equal(applyMode(source, { mode: 'edit', insert_after: 2, text: '뒤' }), '첫 줄\n끝 줄\n뒤');
  assert.equal(applyMode('', { mode: 'edit', insert_after: 0, text: '처음' }), '처음');
  assert.equal(applyMode(source, { mode: 'edit', insert_after: 1, text: '' }), source);
});

test('G7: replace는 빈 문자열을 포함한 새 본문 전체로 교체합니다', () => {
  assert.equal(applyMode('기존', { mode: 'replace', text: '  새 본문\n' }), '  새 본문\n');
  assert.equal(applyMode('기존', { mode: 'replace', text: '' }), '');
});

const failures = [
  ['mode 누락', '기존', { field: 'body', text: '추가' }, 'field 에는 mode 가 있어야 합니다 (append | edit | replace)'],
  ['old 없음', '기존', { mode: 'edit', old: '없는 글', new: '수정' }, 'old 를 찾지 못했습니다'],
  ['old 중복', '기존 기존', { mode: 'edit', old: '기존', new: '수정' }, 'old 가 2 군데에 있습니다. replace_all:true 로 전부 바꾸거나 old 를 더 길게 주십시오'],
  ['동일한 치환', '기존', { mode: 'edit', old: '기존', new: '기존' }, 'old 와 new 가 같습니다'],
  ['줄 범위 초과', '첫 줄\n끝 줄', { mode: 'edit', insert_after: 3, text: '추가' }, '줄이 2 개뿐입니다'],
  ['옛 append', '기존', { append: true, body: '추가' }, 'append 플래그는 없어졌습니다. mode:"append" 를 쓰십시오'],
];
for (const [label, source, args, message] of failures) {
  test(`G7: 실패 규칙 ${label}의 문구가 계약과 같습니다`, () => {
    assert.throws(() => applyMode(source, args), { message });
  });
}

test('G7: 잘못된 편집 인자를 조용히 무시하지 않습니다', () => {
  for (const args of [
    { mode: 'unknown' },
    { mode: 'append' },
    { mode: 'replace', text: null },
    { mode: 'append', text: '추가', at: 'middle' },
    { mode: 'replace', text: '새 본문', old: '기존', new: '수정' },
    { mode: 'edit', old: '', new: '수정' },
    { mode: 'edit', old: '기존' },
    { mode: 'edit', old: '기존', new: '수정', replace_all: 'true' },
    { mode: 'edit', old: '기존', new: '수정', text: '추가' },
    { mode: 'edit', old: '기존', new: '수정', insert_after: 0, text: '추가' },
    { mode: 'edit', insert_after: -1, text: '추가' },
    { mode: 'edit', insert_after: 0.5, text: '추가' },
    { mode: 'edit', insert_after: '1', text: '추가' },
  ]) assert.throws(() => applyMode('기존', args), Error);
  assert.throws(() => applyMode('', { mode: 'edit', insert_after: 1, text: '추가' }), { message: '줄이 0 개뿐입니다' });
  assert.throws(() => applyMode('aaa', { mode: 'edit', old: 'aa', new: 'b' }), /old 가 2 군데/);
});

test('G7: 옛 인자와 새 인자를 함께 보내도 옛 인자를 거절합니다', () => {
  for (const args of [{ append: false }, { body: '' }, { append: true, field: 'body', mode: 'append', text: '새 글' }]) {
    assert.throws(() => rejectLegacyAppend(args), { message: 'append 플래그는 없어졌습니다. mode:"append" 를 쓰십시오' });
  }
  assert.doesNotThrow(() => rejectLegacyAppend({ field: 'body', mode: 'append', text: '새 글' }));
});

test('G7: 줄 번호는 네 자리 오른쪽 정렬이며 빈 줄과 마지막 줄도 유지합니다', () => {
  assert.equal(withLineNumbers(''), '');
  assert.equal(withLineNumbers('첫 줄\n\n끝 줄\n'), '   1│ 첫 줄\n   2│ \n   3│ 끝 줄\n   4│ ');
  const lines = Array.from({ length: 12 }, (_, index) => `줄 ${index + 1}`).join('\n');
  assert.equal(withLineNumbers(lines).split('\n')[11], '  12│ 줄 12');
});
