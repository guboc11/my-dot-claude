import fs from 'node:fs';
import path from 'node:path';

import {
  OWNER,
  applyMode,
  campaignContextDir,
  campaignDir,
  campaignGroupIds,
  campaignNotesDir,
  createIfAbsent,
  datedName,
  listCampaignNames,
  markdownRecordFileName,
  now,
  numberedMarkdownFiles,
  parseMarkdownRecord,
  projectDir,
  readGroupRecord,
  readTasks,
  readTextOr,
  rejectLegacyAppend,
  renderMarkdownRecord,
  requireCampaign,
  slug,
  subDirNames,
  withLineNumbers,
} from '../lib.mjs';
import { groupDocuments } from './group.mjs';
import { renderGroup } from './task.mjs';

function readIndex(file) {
  const lines = readTextOr(file).split('\n').filter((line) => line.startsWith('- '));
  const entries = lines.flatMap((line) => {
    const match = /^- \[.*\]\(([^)]+)\)/.exec(line);
    return match ? [match[1].replace(/^\.\//, '')] : [];
  });
  return { lines, entries };
}

function currentIndex(name) {
  return readIndex(path.join(campaignContextDir(name), 'INDEX.md'));
}

function campaignStatus(name) {
  const current = readTextOr(path.join(campaignContextDir(name), 'MAIN_CONTEXT.md'));
  const m = current.match(/^상태:[ \t]*(.+)$/m);
  return m ? m[1].trim() : '';
}

function contextView(name) {
  const docs = numberedMarkdownFiles(campaignContextDir(name), 'context').map((entry) => entry.file);
  const topics = subDirNames(campaignNotesDir(name)).sort().map((topic) => `../campaign-notes/${topic}/`);
  const current = currentIndex(name);
  const normalized = current.entries.map((entry) => entry.replace(/\/+$/, ''));
  const actual = [...docs, ...topics];
  const notIndexed = actual.filter((entry) => !normalized.includes(entry.replace(/\/+$/, '')));
  const actualNormalized = actual.map((entry) => entry.replace(/\/+$/, ''));
  const ghosts = current.entries.filter((entry) => !actualNormalized.includes(entry.replace(/\/+$/, '')));
  return { lines: current.lines, notIndexed, ghosts };
}

function dateNotice(strippedDates) {
  return strippedDates.length
    ? `(주제 앞머리의 날짜 ${strippedDates.join(', ')} 를 뗐습니다)\n`
    : '';
}

function ensureCurrentStructure(name) {
  const context = campaignContextDir(name);
  fs.mkdirSync(context, { recursive: true });
  fs.mkdirSync(campaignNotesDir(name), { recursive: true });
  createIfAbsent(path.join(context, 'INDEX.md'), `# ${name} — campaign-main-context 차례\n\n`);
}

function registerTopic(name, topic) {
  const index = path.join(campaignContextDir(name), 'INDEX.md');
  const target = `../campaign-notes/${topic}/`;
  const registered = currentIndex(name).entries.some((entry) => entry.replace(/\/+$/, '') === target.slice(0, -1));
  if (registered) return false;
  fs.appendFileSync(index, `- [${topic}](${target})\n`);
  return true;
}

export function toolCampaignAdd({ name, about }) {
  if (!name) throw new Error('name은 필수입니다.');
  const named = datedName(name);
  if (fs.existsSync(campaignDir(named.id))) throw new Error(`이미 있는 캠페인입니다: ${named.id}`);
  // 새 캠페인은 항상 새 루트에 만듭니다. 기존 캠페인 읽기에는 루트 폴백을 유지합니다.
  fs.mkdirSync(path.join(projectDir(), '.claude', 'mcp-task-campaign'), { recursive: true });
  ensureCurrentStructure(named.id);
  createIfAbsent(path.join(campaignContextDir(named.id), 'MAIN_CONTEXT.md'),
    `# ${named.id}\n\n상태: 진행 중\n\n${about || '(설명이 없습니다. 이 일의 목적과 범위를 적으십시오.)'}\n`);
  return `${dateNotice(named.strippedDates)}캠페인 생성: ${named.id}\n` +
    `- .claude/mcp-task-campaign/${named.id}/campaign-main-context/MAIN_CONTEXT.md\n\n` +
    `태스크 그룹은 task_group_add, 맥락은 campaign_context_add로 추가하고 campaign_read로 읽으십시오.`;
}

export function toolCampaignRead({ name, full } = {}) {
  const id = requireCampaign(name);
  const currentMain = readTextOr(path.join(campaignContextDir(id), 'MAIN_CONTEXT.md'));
  const out = [(currentMain || '(MAIN_CONTEXT 없음)').trim()];

  // 차례 — 도구가 관리한다
  const context = contextView(id);
  out.push(`## 차례 (campaign-main-context)\n${context.lines.length
    ? context.lines.join('\n')
    : '(빈 차례)'}`);

  // 실물과 차례가 어긋나면 알리기만 한다. 빠진 게 실수인지 일부러인지 도구는 알 수 없다.
  if (context.notIndexed.length || context.ghosts.length) {
    out.push(`! 차례와 실물이 어긋납니다 (자동으로 고치지 않습니다)\n` +
      `  차례에 없는 문서·폴더: ${context.notIndexed.length ? context.notIndexed.join(', ') : '없음'}\n` +
      `  실물이 없는 등재: ${context.ghosts.length ? context.ghosts.join(', ') : '없음'}`);
  }

  // 그룹 — 기본은 진행 중인 것만
  const gids = campaignGroupIds(id);
  const blocks = [];
  let hidden = 0;
  for (const g of gids) {
    const dir = path.join(campaignDir(id), g);
    const tasks = readTasks(dir);
    if (!full && readGroupRecord(dir)?.status === 'done') { hidden += 1; continue; }
    const { notes, plans: groupPlans, researches } = groupDocuments(dir);
    blocks.push(`${renderGroup(g, tasks, true)}\n  노트 ${notes.length}개 · 계획서 ${groupPlans.length}개 · 조사 ${researches.length}개`);
  }
  // 머리는 전체를 세고 몸은 진행 중만 보이던 자리라 두 수를 함께 적습니다(백로그 14).
  const heading = full
    ? `## 태스크 그룹 ${gids.length}개`
    : `## 태스크 그룹 — 진행 중 ${blocks.length}개 / 전체 ${gids.length}개`;
  out.push(`${heading}\n${blocks.join('\n\n') || '(진행 중인 그룹 없음)'}` +
    (hidden ? `\n\n(완료 그룹 ${hidden}개를 숨겼습니다. full:true로 전부 볼 수 있습니다.)` : ''));

  return out.join('\n\n');
}

function oneLine(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${label} 은 비어 있지 않은 한 줄 문자열이어야 합니다`);
  }
}

function documentLocation(name, topic) {
  const id = requireCampaign(name);
  if (topic != null) oneLine(topic, 'topic');
  const topicId = topic == null ? null : slug(topic);
  return {
    id, topicId,
    prefix: topicId ? 'note' : 'context',
    dir: topicId ? path.join(campaignNotesDir(id), topicId) : campaignContextDir(id),
  };
}

function indexLabel(title) {
  return title.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
}

export function toolCampaignContextAdd({ name, title, text, topic }) {
  oneLine(title, 'title');
  if (typeof text !== 'string') throw new Error('text 는 문자열이어야 합니다');
  const location = documentLocation(name, topic);
  const { id, topicId, prefix, dir } = location;
  const existing = numberedMarkdownFiles(dir, prefix);
  const number = existing.reduce((max, note) => Math.max(max, note.number), 0) + 1;
  const timestamp = now();
  const file = markdownRecordFileName(prefix, number, title);
  const record = renderMarkdownRecord({
    number,
    title: String(title),
    author: OWNER,
    created_at: timestamp,
    updated_at: timestamp,
  }, text);
  ensureCurrentStructure(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), record, { flag: 'wx' });
  if (topicId) registerTopic(id, topicId);
  else fs.appendFileSync(path.join(campaignContextDir(id), 'INDEX.md'), `- [${indexLabel(title)}](${file})\n`);
  return `캠페인 맥락 문서를 추가했습니다: name="${id}", number=${number}, file="${path.relative(campaignDir(id), path.join(dir, file))}".`;
}

function validateBodyUpdate(args, valueField) {
  rejectLegacyAppend(args);
  if (Object.hasOwn(args, 'body')) rejectLegacyAppend({ body: args.body });
  if (args.field != null && args.field !== 'body') throw new Error('field 는 body 여야 합니다');
  if (args.field == null && ['mode', 'text', 'at', 'old', 'new', 'replace_all', 'insert_after'].some((key) => Object.hasOwn(args, key))) {
    throw new Error('본문을 고치려면 field:"body" 를 주십시오');
  }
  if (args[valueField] == null && args.field == null) throw new Error(`바꿀 값(${valueField} 또는 field)이 필요합니다`);
  if (args[valueField] != null) oneLine(args[valueField], valueField);
}

function mainContextFile(name) {
  const id = requireCampaign(name);
  const full = path.join(campaignContextDir(id), 'MAIN_CONTEXT.md');
  if (!fs.existsSync(full)) throw new Error('MAIN_CONTEXT.md 를 찾지 못했습니다');
  return { id, full, text: fs.readFileSync(full, 'utf8') };
}

export function toolCampaignMainContextGet({ name }) {
  return withLineNumbers(mainContextFile(name).text);
}

export function toolCampaignMainContextUpdate(args) {
  validateBodyUpdate(args, 'status');
  const main = mainContextFile(args.name);
  let text = args.field == null ? main.text : applyMode(main.text, args);
  if (args.status != null) {
    const statusLine = `상태: ${args.status}`;
    if (/^상태:/m.test(text)) text = text.replace(/^상태:[^\r\n]*/m, () => statusLine);
    else {
      const lines = text ? text.split('\n') : [];
      const heading = lines.findIndex((line) => /^# /.test(line));
      let at = heading < 0 ? 0 : heading + 1;
      if (heading >= 0) {
        if (lines[at] === '') at += 1;
        else { lines.splice(at, 0, ''); at += 1; }
      }
      lines.splice(at, 0, statusLine, '');
      text = lines.join('\n');
    }
  }
  fs.writeFileSync(main.full, text);
  return `캠페인 본 맥락을 수정했습니다: name="${main.id}", file="campaign-main-context/MAIN_CONTEXT.md".`;
}

function readContext(name, number, topic) {
  if (!Number.isInteger(number) || number < 1) throw new Error('number 는 양의 정수여야 합니다');
  const location = documentLocation(name, topic);
  const entry = numberedMarkdownFiles(location.dir, location.prefix).find((entry) => entry.number === number);
  if (!entry) throw new Error(`${location.prefix}-${number} 를 찾지 못했습니다`);
  const full = path.join(location.dir, entry.file);
  const text = fs.readFileSync(full, 'utf8');
  return { ...location, ...entry, full, text, ...parseMarkdownRecord(text) };
}

export function toolCampaignContextGet({ name, number, topic }) {
  const doc = readContext(name, number, topic);
  const headerEnd = doc.text.indexOf('\n---\n', 4) + 5;
  return `${doc.text.slice(0, headerEnd)}\n${withLineNumbers(doc.body)}\n`;
}

export function toolCampaignContextUpdate(args) {
  validateBodyUpdate(args, 'title');
  const doc = readContext(args.name, args.number, args.topic);
  const title = args.title ?? doc.metadata.title;
  const body = args.field == null ? doc.body : applyMode(doc.body, args);
  const file = markdownRecordFileName(doc.prefix, doc.number, title);
  const full = path.join(doc.dir, file);
  const text = renderMarkdownRecord({ ...doc.metadata, title, updated_at: now() }, body);
  if (full !== doc.full && fs.existsSync(full)) throw new Error(`이미 있는 맥락 문서입니다: ${file}`);
  const index = path.join(campaignContextDir(doc.id), 'INDEX.md');
  const previousIndex = doc.topicId ? '' : readTextOr(index);
  const nextIndex = previousIndex.split('\n').map((line) => {
    const match = /^- \[.*\]\(([^)]+)\)/.exec(line);
    if (!match || match[1].replace(/^\.\//, '') !== doc.file) return line;
    return `- [${indexLabel(title)}](${file})${line.slice(match[0].length)}`;
  }).join('\n');
  // 편집·앞머리·개명 검사를 모두 마친 뒤에만 문서와 차례를 씁니다.
  fs.writeFileSync(doc.full, text);
  if (file !== doc.file) fs.renameSync(doc.full, full);
  if (previousIndex !== nextIndex) fs.writeFileSync(index, nextIndex);
  return `캠페인 맥락 문서를 수정했습니다: name="${doc.id}", number=${doc.number}, file="${path.relative(campaignDir(doc.id), full)}".`;
}

export function toolCampaignList() {
  const names = listCampaignNames();
  if (!names.length) return '캠페인 없음. campaign_add로 시작하세요.';
  const rows = names.map((n) => {
    const gids = campaignGroupIds(n);
    let open = 0, total = 0;
    for (const g of gids) {
      const ts = readTasks(path.join(campaignDir(n), g));
      total += ts.length;
      open += ts.filter((t) => t.status !== 'completed').length;
    }
    return `- ${n} — ${campaignStatus(n) || '상태 미표기'} · 그룹 ${gids.length}개 · 남은 태스크 ${open}/${total}개`;
  });
  return `${rows.join('\n')}\n\n(펼쳐보기: campaign_read{name:"…"})`;
}
