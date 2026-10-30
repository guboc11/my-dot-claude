import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { normalizeMembers, parseTaskFileName } from './model.mjs';

// 태스크 상태·표식·파일 이름·명단 규칙의 원천은 model.mjs 다. 값은 재수출로만 넘긴다 —
// `const X = model.X` 로 받으면 두 파일이 서로를 부르는 자리에서 초기화 전 접근이 된다.
export { MARK, STATUSES } from './model.mjs';
export const GROUP_STATUSES = ['pending', 'in_progress', 'done'];
// owner = 태스크를 만든 패널(CMUX_SURFACE_ID). task_list 기본은 자기 owner 것만 = 패널 간 격리.
export const OWNER = process.env.CMUX_SURFACE_ID || '';

export function rejectLegacyAppend(args) {
  if (Object.hasOwn(args, 'append') || (Object.hasOwn(args, 'body') && !Object.hasOwn(args, 'field'))) {
    throw new Error('append 플래그는 없어졌습니다. mode:"append" 를 쓰십시오');
  }
}

export function withLineNumbers(text) {
  const source = String(text ?? '');
  if (!source) return '';
  return source.split('\n').map((line, index) => `${String(index + 1).padStart(4)}│ ${line}`).join('\n');
}

export function applyMode(current, args = {}) {
  rejectLegacyAppend(args);
  const { mode, text, at = 'end', old, new: replacement, replace_all, insert_after, gap } = args;
  if (mode == null) throw new Error('field 에는 mode 가 있어야 합니다 (append | edit | replace)');
  if (!['append', 'edit', 'replace'].includes(mode)) {
    throw new Error('mode 는 append | edit | replace 중 하나여야 합니다');
  }
  const source = String(current ?? '');
  const has = (key) => Object.hasOwn(args, key);
  const requireText = () => {
    if (typeof text !== 'string') throw new Error('text 는 문자열이어야 합니다');
  };

  if (has('gap') && mode !== 'append') throw new Error('gap 은 mode:"append" 에서만 씁니다');
  if (has('gap') && typeof gap !== 'boolean') throw new Error('gap 은 boolean 이어야 합니다');

  if (mode !== 'edit') {
    if (['old', 'new', 'replace_all', 'insert_after'].some(has)) {
      throw new Error('old · new · replace_all · insert_after 는 mode:"edit" 에서만 씁니다');
    }
    requireText();
    if (mode === 'replace') {
      if (has('at')) throw new Error('at 은 mode:"append" 에서만 씁니다');
      return text;
    }
    if (!['start', 'end'].includes(at)) throw new Error('at 은 start | end 중 하나여야 합니다');
    if (!source) return text;
    if (!text) return source;
    // 기본은 빈 줄 하나를 사이에 둡니다 — 문단을 잇는 자리라 그것이 맞습니다.
    // gap:false 는 줄바꿈 하나만 둡니다. 표에 행을 붙일 때 빈 줄이 표를 끊던 자리입니다(백로그 15).
    // 붙이는 글이 표 행인지 도구가 알아서 판정하지 않습니다 — 부르는 쪽이 정합니다.
    const joint = gap === false ? '\n' : '\n\n';
    return at === 'start' ? `${text}${joint}${source}` : `${source}${joint}${text}`;
  }

  if (has('at')) throw new Error('at 은 mode:"append" 에서만 씁니다');
  if (has('insert_after')) {
    if (['old', 'new', 'replace_all'].some(has)) {
      throw new Error('edit 에는 old/new 또는 insert_after/text 중 한 가지 방식만 주십시오');
    }
    requireText();
    if (!Number.isInteger(insert_after) || insert_after < 0) {
      throw new Error('insert_after 는 0 이상의 정수여야 합니다');
    }
    const lines = source ? source.split('\n') : [];
    if (insert_after > lines.length) throw new Error(`줄이 ${lines.length} 개뿐입니다`);
    if (!text) return source;
    lines.splice(insert_after, 0, text);
    return lines.join('\n');
  }

  if (has('text')) throw new Error('edit 에는 old/new 또는 insert_after/text 중 한 가지 방식만 주십시오');
  if (typeof old !== 'string' || typeof replacement !== 'string') {
    throw new Error('old 와 new 는 문자열이어야 합니다');
  }
  if (old === replacement) throw new Error('old 와 new 가 같습니다');
  if (!old) throw new Error('old 는 빈 문자열일 수 없습니다');
  if (has('replace_all') && typeof replace_all !== 'boolean') {
    throw new Error('replace_all 은 boolean 이어야 합니다');
  }
  let count = 0;
  for (let index = source.indexOf(old); index !== -1; index = source.indexOf(old, index + 1)) count += 1;
  if (!count) throw new Error('old 를 찾지 못했습니다');
  if (count > 1 && replace_all !== true) {
    throw new Error(`old 가 ${count} 군데에 있습니다. replace_all:true 로 전부 바꾸거나 old 를 더 길게 주십시오`);
  }
  return source.split(old).join(replacement);
}

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function tasksRoot() {
  return path.join(projectDir(), '.claude', 'mcp-task');
}

export function legacyTasksRoot() {
  return path.join(projectDir(), '.claude', 'tasks');
}

// 보고 기록. 한 줄이 한 보고이고 뒤에 붙이기만 한다(대본 4절).
export function queuePath(groupDir) {
  return path.join(groupDir, 'MANAGER_MESSAGE_QUEUE.jsonl');
}

// 새 경로를 우선하며, 아직 이관하지 않은 프로젝트에서는 옛 루트를 읽고 씁니다.
export function campaignsRoot() {
  const current = path.join(projectDir(), '.claude', 'mcp-task-campaign');
  return fs.existsSync(current) ? current : path.join(projectDir(), '.claude', 'campaigns');
}

export function backlogRoot() {
  return path.join(projectDir(), '.claude', 'mcp-task-backlog');
}

export function safeName(name) {
  return String(name ?? '').replace(/[\\/]/g, '').trim();
}

export function campaignDir(name) {
  return path.join(campaignsRoot(), safeName(name));
}

export function campaignContextDir(name) {
  return path.join(campaignDir(name), 'campaign-main-context');
}

export function campaignNotesDir(name) {
  return path.join(campaignDir(name), 'campaign-notes');
}

export function subDirNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

export function listCampaignNames() {
  return subDirNames(campaignsRoot()).sort();
}

export function slug(s, max = 60) {
  return (String(s ?? '').trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '')) || 'task';
}

// 파일명: task-{번호}-{status}-[태그]-{제목}.json  (태그 없으면 [태그] 생략)
export function taskFileName(number, status, content, tag) {
  const t = tag ? `-[${slug(tag, 20)}]` : '';
  return `task-${number}-${status}${t}-${slug(content, 40)}.json`;
}

export function today() {
  // KST 기준 날짜. toISOString은 UTC라 KST 00:00~08:59에 그룹 폴더가 어제 날짜로 찍힌다 (2026-07-30 발견).
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function now() {
  return new Date().toISOString();
}

export function datedName(topic) {
  const raw = String(topic ?? '').trim();
  const dates = [];
  let rest = raw;
  while (/^\d{4}-\d{2}-\d{2}-/.test(rest)) {
    dates.push(rest.slice(0, 10));
    rest = rest.slice(11);
  }
  return { id: `${today()}-${slug(rest)}`, topic: rest, strippedDates: dates };
}

export function groupPath(groupId) {
  // groupId = 폴더명 "{date}-{slug}". 하위경로 이탈 방지.
  // 그룹은 새·옛 독립 자리 또는 캠페인 한 겹 아래에 산다.
  // 어느 쪽에 있든 이름은 여전히 폴더명 하나다 — 경로로 바꾸면 기존 group_id 표기가 전부 어긋난다.
  const safe = safeName(groupId);
  const top = path.join(tasksRoot(), safe);
  if (fs.existsSync(top)) return { safe, dir: top, campaign: null };
  const legacy = path.join(legacyTasksRoot(), safe);
  if (fs.existsSync(legacy)) return { safe, dir: legacy, campaign: null };
  // 호출자가 옛 ID를 줘도 접두사가 붙은 실물 그룹을 찾습니다. 자료 폴더는 읽지 않습니다.
  const campaignId = safe.startsWith('task-group-') ? safe : `task-group-${safe}`;
  for (const c of listCampaignNames()) {
    const inCampaign = path.join(campaignsRoot(), c, campaignId);
    if (fs.existsSync(inCampaign)) return { safe: campaignId, dir: inCampaign, campaign: c };
  }
  // 없는 그룹이면 기존과 같은 경로를 돌려준다(오류 메시지가 이전과 같게).
  return { safe, dir: top, campaign: null };
}

export function campaignGroupIds(name) {
  return subDirNames(campaignDir(name))
    .filter((groupId) => groupId.startsWith('task-group-'))
    .sort();
}

export function listGroupIds() {
  // 새·옛 독립 자리와 캠페인을 함께 훑는다. 돌려주는 것은 예전처럼 그룹 이름뿐 —
  // 실제 경로는 호출부가 groupPath()로 푼다.
  const out = subDirNames(tasksRoot());
  out.push(...subDirNames(legacyTasksRoot()));
  for (const c of listCampaignNames()) {
    out.push(...campaignGroupIds(c));
  }
  return [...new Set(out)].sort();
}

export function requireGroup(groupId) {
  const found = groupPath(groupId);
  if (!found.safe || !fs.existsSync(found.dir)) {
    throw new Error(`그룹 "${found.safe}" 없음. task_group_add로 먼저 만드세요.`);
  }
  return found;
}

export function requireWritableGroup(groupId) {
  const found = requireGroup(groupId);
  if (found.campaign) return found;

  const destination = path.join(tasksRoot(), found.safe);
  if (found.dir === destination) return found;
  if (fs.existsSync(destination)) return { safe: found.safe, dir: destination, campaign: null };

  fs.mkdirSync(tasksRoot(), { recursive: true });
  const temporary = path.join(
    path.dirname(tasksRoot()),
    `.mcp-task-promote-${found.safe}-${process.pid}-${randomUUID()}`,
  );

  // 이 레포에서는 tasks 호환 symlink 뒤 이 분기가 거의 안 돈다. 이동하지 않은 다른 레포의
  // 실물 .claude/tasks 그룹을 전역 서버가 처음 수정할 때 필요한 경로이므로 제거하지 않는다.
  try {
    fs.cpSync(found.dir, temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    try {
      fs.renameSync(temporary, destination);
    } catch (cause) {
      if (!fs.existsSync(destination)) throw cause;
    }
  } catch (cause) {
    if (!fs.existsSync(destination)) throw cause;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }

  return { safe: found.safe, dir: destination, campaign: null };
}

// 레코드 파일 이름은 TASK_GROUP.json 이 정본이다. 옛 이름(GROUP.json)은 읽기만 하고,
// 쓰기가 닿으면 새 이름으로 옮기며 옛 파일을 지운다(SPEC 3-1 · 5-7).
export function groupRecordPath(dir) {
  return path.join(dir, 'TASK_GROUP.json');
}

export function legacyGroupRecordPath(dir) {
  return path.join(dir, 'GROUP.json');
}

export function readGroupRecord(dir) {
  const current = groupRecordPath(dir);
  const legacy = legacyGroupRecordPath(dir);
  const file = (fs.existsSync(current) && current) || (fs.existsSync(legacy) && legacy) || null;
  if (!file) return null;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${path.basename(file)} 파싱 실패: ${cause.message}`);
  }
  // 옛 두 칸(worker · manager)은 메모리에서 members 로 바꿔 읽는다. 파일은 그대로 둔다.
  record.members = normalizeMembers(record);
  delete record.worker;
  delete record.manager;
  return record;
}

export function writeGroupRecord(dir, record) {
  fs.writeFileSync(groupRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`);
  const legacy = legacyGroupRecordPath(dir);
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
}

export function taskStatusFromFile(file) {
  return parseTaskFileName(file)?.status || null;
}

// 파일 이름이 정본이고, 표 밖 상태(예: 2026-07-31 의 cancelled 10개)는 레코드의 status 로 물러선다.
// 그런 태스크는 옛 꼴(kind work · 배치 없음)로 읽되 바꿀 수 없는 것으로 다룬다(매니저 결정 M-7).
export function normalizeTaskRecord(data, file, number) {
  const parsed = parseTaskFileName(file);
  return {
    ...data,
    number,
    activeForm: data.activeForm ?? data.content ?? '',
    instruction: data.instruction ?? '',
    depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
    priority: Number.isInteger(data.priority) ? data.priority : 0,
    assignee: data.assignee ?? data.owner ?? '',
    status: parsed?.status || data.status,
    batch: parsed?.batch || data.batch || '',
    kind: parsed?.kind || data.kind || 'work',
    spec: data.spec ?? '',
    memo: data.memo ?? '',
    result: data.result ?? '',
    outcome: data.outcome ?? null,
    rejected: Array.isArray(data.rejected) ? data.rejected : [],
    target: Array.isArray(data.target) ? data.target : [],
    caused_by: data.caused_by ?? null,
    legacy: parsed ? parsed.legacy : true,
    file,
  };
}

export function readTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^task-(\d+)-.+\.json$/);
    if (!m) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push(normalizeTaskRecord(data, f, Number(m[1])));
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.number - b.number);
}

export function findTaskFile(dir, number) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  return files.find((f) => new RegExp(`^task-${number}-.+\\.json$`).test(f)) || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function numberedMarkdownFiles(dir, prefix) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)-.+\\.md$`);
  return files.flatMap((file) => {
    const match = pattern.exec(file);
    return match ? [{ file, number: Number(match[1]) }] : [];
  }).sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
}

export function markdownRecordFileName(prefix, number, title) {
  return `${prefix}-${number}-${slug(title, 60)}.md`;
}

export function renderMarkdownRecord(metadata, body) {
  const header = Object.entries(metadata).map(([key, value]) => {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) throw new Error(`앞머리 ${key} 값에는 줄바꿈을 넣을 수 없습니다.`);
    return `${key}: ${text}`;
  });
  return `---\n${header.join('\n')}\n---\n\n${String(body ?? '')}\n`;
}

export function parseMarkdownRecord(text) {
  const source = String(text);
  if (!source.startsWith('---\n')) throw new Error('Markdown 앞머리가 없습니다.');
  const end = source.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Markdown 앞머리가 닫히지 않았습니다.');
  const metadata = {};
  for (const line of source.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Markdown 앞머리 줄을 읽을 수 없습니다: ${line}`);
    metadata[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, '');
  }
  let body = source.slice(end + 5);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { metadata, body };
}

// 파일 만들기는 exclusive create('ax')로 한다 — writeFileSync는 자르기라
// 두 패널이 동시에 첫 글을 적으면 한쪽 내용이 사라진다. 이어붙이기는 항상 append.
export function createIfAbsent(p, header) {
  try { fs.writeFileSync(p, header, { flag: 'ax' }); } catch { /* 이미 있음 */ }
}

export function readTextOr(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

export function requireCampaign(name) {
  const id = safeName(name);
  if (!id || !fs.existsSync(campaignDir(id))) {
    throw new Error(`캠페인 "${id}" 없음. campaign_list로 확인하거나 campaign_add로 만드세요.`);
  }
  return id;
}
