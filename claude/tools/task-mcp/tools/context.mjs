import fs from 'node:fs';
import path from 'node:path';

import {
  OWNER,
  applyMode,
  markdownRecordFileName,
  now,
  numberedMarkdownFiles,
  parseMarkdownRecord,
  renderMarkdownRecord,
  rejectLegacyAppend,
  requireGroup,
  requireWritableGroup,
  withLineNumbers,
} from '../lib.mjs';

const PREFIX = 'context';

function contextsDir(groupDir) {
  return path.join(groupDir, 'context');
}

// 목록·번호·대시보드가 같은 파일만 봅니다. 번호 없는 자료와 하위 폴더는 제외합니다.
export function contextFiles(groupDir) {
  const dir = contextsDir(groupDir);
  return numberedMarkdownFiles(dir, PREFIX)
    .filter((entry) => fs.lstatSync(path.join(dir, entry.file)).isFile());
}

function contextMetadata(number, title, author, createdAt, updatedAt) {
  return { number, title, author, created_at: createdAt, updated_at: updatedAt };
}

function readContext(groupDir, number) {
  if (!Number.isInteger(number) || number < 1) throw new Error('number는 양의 정수여야 합니다.');
  const entry = contextFiles(groupDir).find((candidate) => candidate.number === number);
  if (!entry) throw new Error(`context-${number} 를 찾지 못했습니다.`);
  const full = path.join(contextsDir(groupDir), entry.file);
  const text = fs.readFileSync(full, 'utf8');
  return { ...entry, full, text, ...parseMarkdownRecord(text) };
}

export function toolGroupContextAdd({ group_id, title, text }) {
  if (!group_id || !title || text == null) throw new Error('group_id, title, text는 필수입니다.');
  const readable = requireGroup(group_id);
  const number = contextFiles(readable.dir).reduce((max, context) => Math.max(max, context.number), 0) + 1;
  const timestamp = now();
  const metadata = contextMetadata(number, String(title), OWNER, timestamp, timestamp);
  const record = renderMarkdownRecord(metadata, text);
  const file = markdownRecordFileName(PREFIX, number, title);
  const found = requireWritableGroup(group_id);
  const dir = contextsDir(found.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), record, { flag: 'wx' });
  return `맥락 문서 추가: group_id="${found.safe}", number=${number}, file="context/${file}".`;
}

export function toolGroupContextUpdate(args) {
  const { group_id, number, title, field } = args;
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  rejectLegacyAppend(args);
  if (Object.hasOwn(args, 'body')) rejectLegacyAppend({ body: args.body });
  if (field != null && field !== 'body') throw new Error('field 는 body 여야 합니다');
  if (field == null && ['mode', 'text', 'at', 'old', 'new', 'replace_all', 'insert_after'].some((key) => Object.hasOwn(args, key))) {
    throw new Error('본문을 고치려면 field:"body" 를 주십시오');
  }
  if (title == null && field == null) throw new Error('바꿀 값(title 또는 field)이 필요합니다');
  const readable = requireGroup(group_id);
  const context = readContext(readable.dir, number);
  const nextTitle = title == null ? context.metadata.title : String(title);
  const nextBody = field == null ? context.body : applyMode(context.body, args);
  const metadata = contextMetadata(number, nextTitle, context.metadata.author, context.metadata.created_at, now());
  const nextFile = markdownRecordFileName(PREFIX, number, nextTitle);
  const nextText = renderMarkdownRecord(metadata, nextBody);
  const found = requireWritableGroup(group_id);
  const full = path.join(contextsDir(found.dir), context.file);
  fs.writeFileSync(full, nextText);
  if (nextFile !== context.file) fs.renameSync(full, path.join(contextsDir(found.dir), nextFile));
  return `맥락 문서를 수정했습니다: group_id="${found.safe}", number=${number}, file="context/${nextFile}".`;
}

export function toolGroupContextGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const found = requireGroup(group_id);
  const context = readContext(found.dir, number);
  const headerEnd = context.text.indexOf('\n---\n', 4) + 5;
  return `${context.text.slice(0, headerEnd)}\n${withLineNumbers(context.body)}\n`;
}

export function toolGroupContextList({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  const found = requireGroup(group_id);
  const lines = contextFiles(found.dir).map((entry) => {
    const context = readContext(found.dir, entry.number);
    return `#${entry.number} ${context.metadata.title} · 작성 ${context.metadata.author || '(없음)'} · 생성 ${context.metadata.created_at} · 수정 ${context.metadata.updated_at}`;
  });
  if (!lines.length) return `맥락 문서 없음: group_id="${found.safe}".`;
  return `[${found.safe}] 맥락 문서 목록\n${lines.join('\n')}`;
}
