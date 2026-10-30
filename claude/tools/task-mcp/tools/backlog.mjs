import fs from 'node:fs';
import path from 'node:path';

import { OWNER, backlogRoot, now, slug } from '../lib.mjs';
import { isBatch, requireOwner } from '../model.mjs';
import { toolGroupAdd } from './group.mjs';
import { toolAdd } from './task.mjs';

export const BACKLOG_TAGS = ['테스트', 'QA', '도구개발', '리서치', 'audit', '문서정리'];
export const BACKLOG_STATES = ['open', 'done', 'promoted', 'dropped'];

function itemFileName(number, tag, title) {
  return `item-${number}-[${slug(tag, 20)}]-${slug(title, 40)}.json`;
}

function itemFiles() {
  let files;
  try { files = fs.readdirSync(backlogRoot()); } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
  return files.flatMap((file) => {
    const match = /^item-(\d+)-\[[^\]]+\]-.+\.json$/.exec(file);
    return match ? [{ file, number: Number(match[1]) }] : [];
  }).sort((a, b) => a.number - b.number);
}

function readItem(entry) {
  const full = path.join(backlogRoot(), entry.file);
  const record = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (record.number !== entry.number) throw new Error(`백로그 파일과 레코드의 번호가 다릅니다: ${entry.file}`);
  return { full, file: entry.file, record };
}

function requireItem(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('number 는 양의 정수여야 합니다');
  const entries = itemFiles().filter((entry) => entry.number === number);
  if (!entries.length) throw new Error(`백로그 ${number}번을 찾지 못했습니다`);
  if (entries.length > 1) throw new Error(`백로그 ${number}번 파일이 ${entries.length}개입니다`);
  return readItem(entries[0]);
}

function validateTag(tag) {
  if (!BACKLOG_TAGS.includes(tag)) throw new Error(`tag 는 ${BACKLOG_TAGS.join(' | ')} 중 하나여야 합니다`);
}

function validateState(state, all = false) {
  const states = all ? [...BACKLOG_STATES, 'all'] : BACKLOG_STATES;
  if (!states.includes(state)) throw new Error(`state 는 ${states.join(' | ')} 중 하나여야 합니다`);
}

function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) {
    throw new Error('title 은 비어 있지 않은 한 줄 문자열이어야 합니다');
  }
}

function validateBody(body) {
  if (typeof body !== 'string') throw new Error('body 는 문자열이어야 합니다');
}

function writeItem(item, record) {
  const file = itemFileName(record.number, record.tag, record.title);
  fs.writeFileSync(item.full, `${JSON.stringify(record, null, 2)}\n`);
  if (file !== item.file) fs.renameSync(item.full, path.join(backlogRoot(), file));
  return file;
}

export function toolBacklogAdd({ title, tag, body = '' }) {
  validateTitle(title);
  validateTag(tag);
  validateBody(body);
  const number = itemFiles().reduce((max, item) => Math.max(max, item.number), 0) + 1;
  const timestamp = now();
  const record = { number, title, tag, body, state: 'open', created_at: timestamp, updated_at: timestamp };
  const file = itemFileName(number, tag, title);
  fs.mkdirSync(backlogRoot(), { recursive: true });
  fs.writeFileSync(path.join(backlogRoot(), file), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return `백로그를 추가했습니다: number=${number}, file="${file}".`;
}

export function toolBacklogList({ tag, state = 'open' } = {}) {
  if (tag != null) validateTag(tag);
  validateState(state, true);
  const records = itemFiles().map((entry) => readItem(entry).record)
    .filter((record) => (tag == null || record.tag === tag) && (state === 'all' || record.state === state));
  if (!records.length) return '조건에 맞는 백로그가 없습니다.';
  return records.map((record) => `#${record.number} [${record.tag}] ${record.title} (${record.state})`).join('\n');
}

export function toolBacklogUpdate(args) {
  const { number, title, tag, body, state } = args;
  if (!['title', 'tag', 'body', 'state'].some((key) => Object.hasOwn(args, key))) {
    throw new Error('바꿀 값(title · tag · body · state)이 필요합니다');
  }
  if (Object.hasOwn(args, 'title')) validateTitle(title);
  if (Object.hasOwn(args, 'tag')) validateTag(tag);
  if (Object.hasOwn(args, 'body')) validateBody(body);
  if (Object.hasOwn(args, 'state')) validateState(state);
  const item = requireItem(number);
  const record = { ...item.record, updated_at: now() };
  for (const key of ['title', 'tag', 'body', 'state']) {
    if (Object.hasOwn(args, key)) record[key] = args[key];
  }
  const file = writeItem(item, record);
  return `백로그를 수정했습니다: number=${number}, file="${file}", state=${record.state}.`;
}

export function toolBacklogDrop({ number }) {
  const item = requireItem(number);
  writeItem(item, { ...item.record, state: 'dropped', updated_at: now() });
  return `백로그 ${number}번을 dropped로 바꿨습니다. 파일은 보존했습니다.`;
}

export function toolBacklogPromote({ number, group_id, topic, batch = 'b1', assignee }) {
  if (!group_id && !topic) throw new Error('group_id 또는 topic 이 필요합니다');
  if (group_id != null && (typeof group_id !== 'string' || !group_id.trim())) {
    throw new Error('group_id 는 비어 있지 않은 문자열이어야 합니다');
  }
  if (topic != null && (typeof topic !== 'string' || !topic.trim())) {
    throw new Error('topic 은 비어 있지 않은 문자열이어야 합니다');
  }
  if (!isBatch(batch)) throw new Error(`batch 는 b 뒤에 양의 정수여야 합니다 (예: b1). 받은 값: ${batch ?? '(없음)'}`);
  if (assignee != null && typeof assignee !== 'string') throw new Error('assignee 는 문자열이어야 합니다');
  if (!group_id && assignee != null && assignee !== '') {
    throw new Error('topic 으로 만드는 새 그룹에는 명단이 없어 assignee 를 받을 수 없습니다. 그룹을 먼저 만들어 members 를 등록한 뒤 group_id 로 승격하거나, assignee 없이 draft 로 승격하십시오.');
  }
  requireOwner(OWNER);
  const item = requireItem(number);
  let groupOutput = '';
  let groupId = group_id;
  if (!groupId) {
    groupOutput = toolGroupAdd({ topic });
    groupId = /group_id="([^"]+)"/.exec(groupOutput)[1];
  }
  // M-9: 담당자·spec이 비었을 때의 draft 판정과 안내는 toolAdd가 맡습니다.
  const taskOutput = toolAdd({
    group_id: groupId,
    content: item.record.title,
    tag: item.record.tag,
    kind: 'work',
    batch,
    spec: item.record.body,
    ...(assignee == null ? {} : { assignee }),
  });
  writeItem(item, { ...item.record, state: 'promoted', updated_at: now() });
  return `백로그 ${number}번을 태스크로 승격했습니다.\n${groupOutput ? `${groupOutput}\n` : ''}${taskOutput}`;
}
