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

const PREFIX = 'note';

function notesDir(groupDir) {
  return path.join(groupDir, 'notes');
}

function requireNumber(number) {
  if (!Number.isInteger(number) || number < 1) throw new Error('number는 양의 정수여야 합니다.');
}

function noteMetadata(number, title, author, createdAt, updatedAt) {
  return {
    number,
    title,
    author,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function readNote(groupDir, number) {
  requireNumber(number);
  const entry = numberedMarkdownFiles(notesDir(groupDir), PREFIX)
    .find((candidate) => candidate.number === number);
  if (!entry) throw new Error(`note-${number} 를 찾지 못했습니다.`);
  const full = path.join(notesDir(groupDir), entry.file);
  const text = fs.readFileSync(full, 'utf8');
  const parsed = parseMarkdownRecord(text);
  return { ...entry, full, text, ...parsed };
}

export function toolGroupNoteAdd({ group_id, title, body }) {
  if (!group_id || !title || body == null) throw new Error('group_id, title, body는 필수입니다.');
  const found = requireWritableGroup(group_id);
  const dir = notesDir(found.dir);
  const existing = numberedMarkdownFiles(dir, PREFIX);
  const number = existing.reduce((max, note) => Math.max(max, note.number), 0) + 1;
  const timestamp = now();
  const metadata = noteMetadata(number, String(title), OWNER, timestamp, timestamp);
  const text = renderMarkdownRecord(metadata, body);
  const file = markdownRecordFileName(PREFIX, number, title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text, { flag: 'wx' });
  return `노트 추가: group_id="${found.safe}", number=${number}, file="notes/${file}".`;
}

export function toolGroupNoteUpdate(args) {
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
  const note = readNote(readable.dir, number);
  const nextTitle = title == null ? note.metadata.title : String(title);
  const nextBody = field == null ? note.body : applyMode(note.body, args);
  const metadata = noteMetadata(
    number,
    nextTitle,
    note.metadata.author,
    note.metadata.created_at,
    now(),
  );
  const nextFile = markdownRecordFileName(PREFIX, number, nextTitle);
  const nextText = renderMarkdownRecord(metadata, nextBody);
  const found = requireWritableGroup(group_id);
  const full = path.join(notesDir(found.dir), note.file);
  fs.writeFileSync(full, nextText);
  if (nextFile !== note.file) fs.renameSync(full, path.join(notesDir(found.dir), nextFile));
  return `노트를 수정했습니다: group_id="${found.safe}", number=${number}, file="notes/${nextFile}".`;
}

export function toolGroupNoteGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const found = requireGroup(group_id);
  const note = readNote(found.dir, number);
  const headerEnd = note.text.indexOf('\n---\n', 4) + 5;
  return `${note.text.slice(0, headerEnd)}\n${withLineNumbers(note.body)}\n`;
}

export function toolGroupNoteList({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  const found = requireGroup(group_id);
  const lines = [];
  for (const entry of numberedMarkdownFiles(notesDir(found.dir), PREFIX)) {
    const note = readNote(found.dir, entry.number);
    lines.push(`#${entry.number} ${note.metadata.title} · 작성 ${note.metadata.author || '(없음)'} · 생성 ${note.metadata.created_at} · 수정 ${note.metadata.updated_at}`);
  }
  if (!lines.length) return `노트 없음: group_id="${found.safe}".`;
  return `[${found.safe}] 노트 목록\n${lines.join('\n')}`;
}
