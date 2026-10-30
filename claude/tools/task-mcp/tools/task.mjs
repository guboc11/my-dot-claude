import fs from 'node:fs';
import path from 'node:path';

import {
  OWNER,
  applyMode,
  findTaskFile,
  groupPath,
  listGroupIds,
  normalizeTaskRecord,
  now,
  readGroupRecord,
  readTasks,
  requireGroup,
  requireWritableGroup,
  taskFileName as legacyTaskFileName,
  withLineNumbers,
  writeGroupRecord,
} from '../lib.mjs';
import {
  KINDS,
  KIND_ROLES,
  MARK,
  STATUSES,
  assigneeRule,
  canTake,
  hasLegacyMembers,
  isBatch,
  kindsForRoles,
  memberOf,
  receivablePending,
  requireOwner,
  taskFileName,
  transitionGuard,
} from '../model.mjs';
import { markRead, report, reportNotice } from './message.mjs';

// 긴 글 칸 다섯. 통째로 주는 길은 없고 field 와 mode 로만 고친다(SPEC 4-0 · 4-5).
export const LONG_FIELDS = ['description', 'spec', 'instruction', 'memo', 'result'];
// test 와 review 는 판정하는 말이 서로 다르다(SPEC 8절).
export const OUTCOMES = { test: ['pass', 'fail'], review: ['approve', 'reject'] };
const ROLE_LABEL = { manager: '매니저', worker: '워커', tester: '테스터', reviewer: '리뷰어' };

// 태스크부터 집은 세션이 맥락으로 가는 길을 보게 하는 한 줄. 캠페인에 안 속한 그룹에는 아무것도 안 붙는다.
export function campaignHint(campaign) {
  // 파일 경로가 아니라 도구를 가리킵니다 — 경로를 주면 cat 으로 읽게 됩니다(백로그 13).
  return campaign
    ? `이 그룹은 캠페인 "${campaign}" 소속입니다. campaign_main_context_get 으로 본 맥락을 먼저 읽으십시오.\n`
    : '';
}

// 새 칸의 기본값과 표 밖 상태 처리는 lib.mjs 의 normalizeTaskRecord 가 맡는다(매니저 결정 M-7).
function readAllTasks(dir) {
  return readTasks(dir);
}

function readOneTask(dir, file, number) {
  return normalizeTaskRecord(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), file, Number(number));
}

function validateNumberList(value, label) {
  if (!Array.isArray(value) || !value.every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error(`${label}은 양의 정수 태스크 번호 배열이어야 합니다.`);
  }
  return [...new Set(value)];
}

function validatePriority(priority) {
  if (!Number.isInteger(priority)) throw new Error('priority는 정수여야 합니다.');
  return priority;
}

function requireBatch(batch) {
  if (!isBatch(batch)) {
    throw new Error(`batch 는 b 뒤에 양의 정수여야 합니다 (예: b1). 받은 값: ${batch ?? '(없음)'}`);
  }
  return batch;
}

function requireKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`kind 는 ${KINDS.join(' | ')} 중 하나여야 합니다. 받은 값: ${kind ?? '(없음)'}`);
  }
  return kind;
}

function workerList(record) {
  const workers = (record?.members || [])
    .filter((entry) => entry.roles.includes('worker'))
    .map((entry) => `${entry.name}(${entry.surface || entry.ref || '표기 없음'})`);
  return workers.length ? workers.join(', ') : '명단에 워커가 없습니다';
}

// 명단에 없는 패널은 쓰지 못합니다(백로그 9). task_next 만 막고 있어서 명단에서 뺀 옛 패널이
// task_add 와 task_update 로 계속 쓰고 보고까지 보내던 자리입니다.
// 옛 명단(surface 가 전부 빈 것)과 명단이 아예 없는 그룹도 똑같이 막고, 되살리는 길만 알립니다
// (매니저 결정 M1). 실물 옛 그룹을 도구가 알아서 고치지는 않습니다.
export function requireMember(record, safe) {
  requireOwner(OWNER);
  const me = memberOf(record, OWNER);
  if (me) return me;

  const members = record?.members || [];
  const why = members.length === 0
    ? '이 그룹에는 명단이 없습니다.'
    : (hasLegacyMembers(record)
      ? '이 그룹은 옛 명단이라 등록된 패널이 하나도 없습니다.'
      : '이 패널이 명단에 없습니다.');
  throw new Error(
    `이 패널(${String(OWNER).slice(0, 8)})은 그룹 "${safe}" 에 쓸 수 없습니다. ${why}`
    + ' task_group_update 의 members 에 name 과 surface 와 roles 를 넣어 등록하십시오.'
    + ' 같은 이름이면 갱신되고 없는 이름이면 추가됩니다.',
  );
}

// depends_on 에 없는 번호를 주면 그 태스크는 아무도 못 집는 채로 pending 에 남습니다(백로그 11).
// 목록에서는 여느 pending 과 똑같이 보여 매니저가 알아챌 자리가 없으므로 만들 때 막습니다.
// 파일을 쓰기 전에 던지므로 거절된 요청은 태스크도 보고도 남기지 않습니다.
export function requireExistingDependencies(numbers, tasks, safe) {
  const present = new Set(tasks.map((task) => task.number));
  const missing = numbers.filter((number) => !present.has(number));
  if (!missing.length) return numbers;

  const range = tasks.length
    ? `지금 있는 태스크는 ${tasks.length}개이고 번호는 #${Math.min(...present)} 부터 #${Math.max(...present)} 까지입니다.`
    : '이 그룹에는 아직 태스크가 없습니다.';
  throw new Error(
    `depends_on 에 그룹 "${safe}" 에 없는 번호가 있습니다: ${missing.map((number) => `#${number}`).join(', ')}. ${range}`,
  );
}

function requireAssignee(assignee, kind, record, safe) {
  if (assignee == null || assignee === '') return;
  const value = String(assignee);
  if (value !== value.trim()) {
    throw new Error(`assignee 값에 앞뒤 공백이 있습니다: "${value}"`);
  }
  if (value.startsWith('surface:')) {
    throw new Error('assignee 는 surface 번호가 아니라 UUID 로 주십시오. cmux tree --all --id-format both 로 찾습니다.');
  }
  const member = memberOf(record, assignee);
  if (!member) {
    throw new Error(`assignee ${String(assignee).slice(0, 8)} 는 그룹 "${safe}" 명단에 없습니다. task_group_update 의 members 에 name·surface·roles 를 넣어 먼저 등록하십시오.`);
  }
  if (!kindsForRoles(member.roles).includes(kind)) {
    throw new Error(`assignee ${member.name}(roles: ${member.roles.join(', ')}) 은 ${kind} 를 맡을 수 없습니다. ${kind} 는 ${KIND_ROLES[kind].join(', ')} 가 맡습니다.`);
  }
}

function requireReviewCause(number, tasks, safe) {
  if (number == null) return;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('caused_by 는 양의 정수 review 번호여야 합니다.');
  }
  const cause = tasks.find((task) => task.number === number);
  if (!cause) throw new Error(`caused_by 에 그룹 "${safe}" 에 없는 번호가 있습니다: #${number}.`);
  if (cause.kind !== 'review') throw new Error(`caused_by #${number} 은 review 가 아니라 ${cause.kind} 입니다.`);
}

function taskRecord(record) {
  const { file, legacy, ...stored } = record;
  return stored;
}

function writeTask(file, record) {
  fs.writeFileSync(file, `${JSON.stringify(taskRecord(record), null, 2)}\n`);
}

// 배치가 있으면 새 꼴, 없으면 옛 꼴 그대로 둔다 — 배치 없는 옛 태스크에 배치를 지어내지 않는다.
function fileNameFor(record) {
  return isBatch(record.batch)
    ? taskFileName(record.number, record.batch, record.kind, record.status, record.content, record.tag)
    : legacyTaskFileName(record.number, record.status, record.content, record.tag);
}

function longField(label, value) {
  const text = String(value ?? '');
  return `${label}:\n${text ? withLineNumbers(text) : '(없음)'}`;
}

function renderTask(id, task, campaign) {
  const dependencies = task.depends_on.length ? task.depends_on.map((number) => `#${number}`).join(', ') : '(없음)';
  const list = (value) => (value.length ? value.map((number) => `#${number}`).join(', ') : '(없음)');
  return `${campaignHint(campaign)}[${id}] #${task.number} ${MARK[task.status] || '[ ]'} ${task.kind} (${task.status})${task.tag ? ` [${task.tag}]` : ''}\n` +
    `제목: ${task.content}\n` +
    `activeForm: ${task.activeForm}\n` +
    `배치: ${task.batch || '(없음)'}\n` +
    `owner: ${task.owner || '(없음)'}\n` +
    `assignee: ${task.assignee || '(없음)'}\n` +
    `priority: ${task.priority}\n` +
    `depends_on: ${dependencies}\n` +
    `target: ${list(task.target)}\n` +
    `caused_by: ${task.caused_by == null ? '(없음)' : `#${task.caused_by}`}\n` +
    `outcome: ${task.outcome || '(없음)'}\n` +
    `rejected: ${list(task.rejected)}\n\n` +
    `${longField('스펙', task.spec)}\n\n` +
    `${longField('지시', task.instruction)}\n\n` +
    `${longField('설명', task.description)}\n\n` +
    `${longField('메모', task.memo)}\n\n` +
    `${longField('결과', task.result)}`;
}

// 배치별로 접어 보인다. 배치 없는 옛 태스크는 마지막에 한 묶음으로 모은다.
export function renderGroup(id, tasks, showOwner = false) {
  if (!tasks.length) return `[${id}] (비어 있음)`;
  const rows = tasks;
  const batches = [...new Set(rows.map((task) => task.batch || ''))]
    .sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return Number(a.slice(1)) - Number(b.slice(1));
    });
  const lines = [];
  for (const batch of batches) {
    lines.push(`  ${batch || '(배치 없음)'}`);
    for (const task of rows.filter((entry) => (entry.batch || '') === batch)) {
      // 담당자를 보입니다. @ 가 만든 사람인 줄 모르고 병행 워커를 가리지 못하던 자리입니다(백로그 14).
      const who = showOwner
        ? `  담당 ${task.assignee ? String(task.assignee).slice(0, 8) : '없음'}`
        : '';
      lines.push(`    ${MARK[task.status] || '[ ]'} ${task.number}. ${task.kind} ${task.tag ? `[${task.tag}] ` : ''}${task.content} (${task.status})${task.description || task.spec ? '  +상세' : ''}${who}`);
    }
  }
  const done = rows.filter((task) => task.status === 'completed').length;
  return `[${id}]  ${done}/${rows.length} 완료\n${lines.join('\n')}`;
}

function markGroupInProgress(dir) {
  const group = readGroupRecord(dir);
  if (!group || group.status !== 'pending') return;
  group.status = 'in_progress';
  group.updated_at = now();
  writeGroupRecord(dir, group);
}

// 같은 배치에 **이미 있는** 것이 기본 선행이다(SPEC 5-5). test 는 work·feedback 을 기다리고,
// review 는 거기에 test 까지 기다린다 — 검증이 끝나기 전에 판정이 열리던 자리다(백로그 10).
// 나중에 생기는 태스크는 따라가지 않는다. review 를 test 보다 먼저 만들면 기본값에 test 가 없으므로
// 매니저가 depends_on 을 손으로 이어야 한다.
const DEFAULT_DEPENDS_KINDS = {
  test: ['work', 'feedback'],
  review: ['work', 'feedback', 'test'],
};

function defaultDependsOn(kind, batch, tasks) {
  const wanted = DEFAULT_DEPENDS_KINDS[kind];
  if (!wanted) return [];
  return tasks
    .filter((task) => (task.batch || '') === batch && wanted.includes(task.kind))
    .map((task) => task.number);
}

export function toolAdd({
  group_id, content, batch, kind, tag, description, spec, instruction,
  depends_on, priority, assignee, target, caused_by, activeForm, status,
}) {
  if (!group_id || !content) throw new Error('group_id, content는 필수입니다.');
  requireOwner(OWNER);
  requireBatch(batch);
  const taskKind = requireKind(kind == null ? 'work' : kind);
  if (status != null && !['draft', 'pending'].includes(status)) {
    throw new Error('task_add 의 status 는 draft | pending 중 하나입니다. 나머지 상태는 task_next 와 task_update 가 옮깁니다.');
  }

  // 검사는 읽기 자리에서 합니다. requireWritableGroup 은 옛 자리에만 있는 그룹을 새 자리로
  // 복사하므로 그것을 먼저 부르면 거절된 요청도 그룹 사본을 남깁니다(리뷰 29).
  const readable = requireGroup(group_id);
  const record = readGroupRecord(readable.dir);
  requireMember(record, readable.safe);
  const existing = readAllTasks(readable.dir);
  const number = (existing.reduce((max, task) => Math.max(max, task.number), 0)) + 1;
  const dependencies = depends_on == null
    ? defaultDependsOn(taskKind, batch, existing)
    : requireExistingDependencies(validateNumberList(depends_on, 'depends_on'), existing, readable.safe);
  requireReviewCause(caused_by, existing, readable.safe);

  const specText = spec || '';
  const assigneeValue = assignee ?? '';
  requireAssignee(assigneeValue, taskKind, record, readable.safe);
  const notices = [];
  if (assignee === '' && assigneeRule(taskKind) === 'mine') {
    notices.push('assignee 가 비어 아무도 집을 수 없습니다');
  }
  let taskStatus = status === 'draft' ? 'draft' : 'pending';
  if (!specText.trim()) {
    taskStatus = 'draft';
    notices.push('spec 이 비어 draft 로 만들었습니다.');
  }
  if (assigneeRule(taskKind) === 'mine' && !assigneeValue.trim()) {
    taskStatus = 'draft';
    notices.push(`assignee 가 없어 draft 로 만들었습니다. members 의 worker: ${workerList(record)}`);
  }

  const rec = {
    number,
    content,
    tag: tag || '',
    batch,
    kind: taskKind,
    status: taskStatus,
    description: description || '',
    spec: specText,
    instruction: instruction || '',
    memo: '',
    result: '',
    outcome: null,
    rejected: [],
    target: target == null ? [] : validateNumberList(target, 'target'),
    caused_by: caused_by == null ? null : caused_by,
    depends_on: dependencies,
    priority: priority == null ? 0 : validatePriority(priority),
    activeForm: activeForm || content,
    owner: OWNER,
    assignee: assigneeValue,
    group_id: readable.safe,
    created_at: now(),
    updated_at: now(),
  };

  // 레코드를 다 만들고 나서야 승격합니다. target·priority 같은 인자 검사가 이 위에 있어
  // 거절된 요청이 옛 그룹 사본을 남기던 자리입니다(리뷰 28).
  const { safe: id, dir, campaign: camp } = requireWritableGroup(group_id);
  rec.group_id = id;
  writeTask(path.join(dir, fileNameFor(rec)), rec);
  const head = `추가됨: group_id="${id}", number=${number}, batch=${batch}, kind=${taskKind}, status=${taskStatus}.`;
  return `${head}${notices.length ? `\n${notices.join('\n')}` : ''}\n${campaignHint(camp)}${renderGroup(id, readAllTasks(dir))}`;
}

// review 가 거절하면 그 번호마다 feedback 태스크가 draft 로 선다(SPEC 5-4).
function createFeedbackTasks(dir, groupId, review, rejected, tasks) {
  const created = [];
  const notices = [];
  let number = tasks.reduce((max, task) => Math.max(max, task.number), 0);
  for (const target of rejected) {
    const origin = tasks.find((task) => task.number === target);
    if (!origin) {
      notices.push(`#${target} 를 찾지 못해 feedback 을 만들지 않았습니다.`);
      continue;
    }
    // 같은 review 가 같은 번호를 두 번 거절해도 feedback 은 한 번만 만든다.
    const already = tasks.some((task) => task.kind === 'feedback'
      && task.caused_by === review.number
      && task.target.includes(target));
    if (already) continue;

    number += 1;
    const rec = {
      number,
      content: `${origin.content} 수정`,
      tag: origin.tag || '',
      batch: review.batch || origin.batch || '',
      kind: 'feedback',
      status: 'draft',
      description: review.result || '',
      spec: '',
      instruction: '',
      memo: '',
      result: '',
      outcome: null,
      rejected: [],
      target: [target],
      caused_by: review.number,
      depends_on: [],
      priority: 0,
      activeForm: `${origin.content} 수정`,
      owner: OWNER,
      assignee: origin.assignee || '',
      group_id: groupId,
      created_at: now(),
      updated_at: now(),
    };
    writeTask(path.join(dir, fileNameFor(rec)), rec);
    created.push(number);
    if (!rec.assignee) {
      notices.push(`#${number} 는 assignee 가 비어 있어 매니저가 채워야 pending 이 됩니다.`);
    }
  }
  return { created, notices };
}

export function toolUpdate(args) {
  const {
    group_id, number, status, tag, content, activeForm, batch, kind,
    depends_on, priority, assignee, target, caused_by, outcome, rejected, field,
  } = args;
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  requireOwner(OWNER);

  const legacyLong = LONG_FIELDS.filter((name) => Object.hasOwn(args, name));
  if (legacyLong.length) {
    throw new Error('description · instruction · spec · memo · result 는 field 와 mode 로 고칩니다 (예: field:"description", mode:"append", text:…)');
  }
  if (field != null && !LONG_FIELDS.includes(field)) {
    throw new Error(`field 는 ${LONG_FIELDS.join(' | ')} 중 하나여야 합니다.`);
  }

  const valueGiven = [status, tag, content, activeForm, batch, kind, depends_on, priority, assignee, target, caused_by, outcome, rejected]
    .some((value) => value != null);
  if (!valueGiven && field == null) {
    throw new Error('바꿀 값(status / tag / content / activeForm / batch / kind / depends_on / priority / assignee / target / caused_by / outcome / rejected) 또는 field 와 mode 가 필요합니다.');
  }

  // 거절할 까닭은 전부 읽기 자리에서 봅니다. requireWritableGroup 은 옛 자리에만 있는 그룹을
  // 새 자리로 복사하므로 그것을 먼저 부르면 거절된 요청도 그룹 사본을 남깁니다(리뷰 29).
  const readable = requireGroup(group_id);
  const readableFile = findTaskFile(readable.dir, number);
  if (!readableFile) throw new Error(`task-${number} 를 group "${readable.safe}" 에서 못 찾음.`);
  const record = readGroupRecord(readable.dir);
  requireMember(record, readable.safe);

  const before = readOneTask(readable.dir, readableFile, number);
  // 끝난 일을 다시 건드리는 길은 새 태스크를 쌓는 것뿐이라 그 다음 행동을 함께 알립니다(백로그 13).
  if (before.status === 'completed') {
    throw new Error('completed 태스크는 바꿀 수 없습니다. 고칠 것이 있으면 task_add 로 feedback 태스크를 새로 만드십시오.');
  }
  if (!STATUSES.includes(before.status)) {
    throw new Error(`상태가 ${before.status} 인 옛 태스크는 바꿀 수 없습니다. 지금 상태 값은 ${STATUSES.join(' | ')} 넷뿐입니다.`);
  }
  const existing = depends_on != null || caused_by != null ? readAllTasks(readable.dir) : [];
  if (depends_on != null) {
    requireExistingDependencies(
      validateNumberList(depends_on, 'depends_on'),
      existing,
      readable.safe,
    );
  }
  requireReviewCause(caused_by, existing, readable.safe);

  // 값을 넣고 편집·전이까지 읽기 사본 위에서 끝냅니다. 여기서 던지면 아무것도 안 바뀝니다.
  const rec = readOneTask(readable.dir, readableFile, number);

  const notices = [];
  if (content != null) rec.content = content;
  if (activeForm != null) rec.activeForm = activeForm;
  if (tag != null) rec.tag = tag;
  if (batch != null) rec.batch = requireBatch(batch);
  if (kind != null) rec.kind = requireKind(kind);
  // 번호가 있는지는 위 읽기 자리에서 이미 봤습니다. 여기서는 값만 넣습니다.
  if (depends_on != null) rec.depends_on = validateNumberList(depends_on, 'depends_on');
  if (target != null) rec.target = validateNumberList(target, 'target');
  if (caused_by != null) rec.caused_by = caused_by;
  if (priority != null) rec.priority = validatePriority(priority);
  if (assignee != null) rec.assignee = assignee;
  if (rejected != null) rec.rejected = validateNumberList(rejected, 'rejected');
  if (outcome != null) {
    const allowed = OUTCOMES[rec.kind];
    if (!allowed) throw new Error(`outcome 은 test 와 review 에만 적습니다. 이 태스크의 kind 는 ${rec.kind} 입니다.`);
    if (!allowed.includes(outcome)) {
      throw new Error(`${rec.kind} 의 outcome 은 ${allowed.join(' | ')} 중 하나여야 합니다. 받은 값: ${outcome}`);
    }
    rec.outcome = outcome;
  }
  if (field != null) rec[field] = applyMode(rec[field], args);
  if (status != null) {
    if (!STATUSES.includes(status)) throw new Error(`status는 ${STATUSES.join(' | ')} 중 하나여야 합니다.`);
    // 저장돼 있던 담당자를 함께 넘깁니다. rec.assignee 는 이번 호출이 이미 바꿨을 수 있어
    // 그 값으로 권한을 보면 남이 자기 UUID 를 실어 남의 일을 반환할 수 있습니다(리뷰 29).
    transitionGuard({
      from: rec.status, to: status, task: rec, caller: OWNER, record, storedAssignee: before.assignee,
    });
    rec.status = status;
  }
  // 반환 호출은 저장된 담당자와 먼저 비교합니다. 기존 반환 거절 문구를 유지합니다.
  if (assignee != null || (kind != null && rec.assignee)) {
    requireAssignee(rec.assignee, rec.kind, record, readable.safe);
  }
  if (assignee === '' && assigneeRule(rec.kind) === 'mine') {
    notices.push('assignee 가 비어 아무도 집을 수 없습니다');
  }
  rec.updated_at = now();

  // 여기부터는 거절할 까닭이 없습니다. 이제 승격하고 그 자리에 씁니다.
  const { safe, dir } = requireWritableGroup(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const full = path.join(dir, cur);
  rec.group_id = safe;

  let feedback = { created: [], notices: [] };
  if (rec.outcome === 'reject' && outcome === 'reject') {
    feedback = createFeedbackTasks(dir, safe, rec, rec.rejected, readAllTasks(dir));
    if (feedback.created.length) {
      notices.push(`거절에 따라 feedback 태스크 ${feedback.created.map((n) => `#${n}`).join(', ')} 를 draft 로 만들었습니다.`);
    }
    notices.push(...feedback.notices);
  }

  const next = path.join(dir, fileNameFor(rec));
  writeTask(full, rec);
  if (path.basename(full) !== path.basename(next)) fs.renameSync(full, next);

  // result 쓰기 · completed · outcome 이 곧 매니저 보고다. 한 호출에 여럿이 와도 줄은 하나다.
  // 요약은 이번 호출이 result 에 적은 글을 먼저 본다 — append 로 붙였어도 새 글이 요약이 되게 하려는 것이다(대본 3절).
  const event = status === 'completed' ? 'completed' : (outcome != null ? 'outcome' : (field === 'result' ? 'result' : null));
  const sent = event
    ? report({
      groupDir: dir,
      groupId: safe,
      record,
      task: rec,
      event,
      outcome: rec.outcome ?? null,
      fromSurface: OWNER,
      summarySource: field === 'result' ? args.text : '',
    })
    : null;

  const head = `업데이트됨: ${safe}/task-${number}${status != null ? ` -> ${status}` : ' (내용 수정)'}.`;
  return `${head}${notices.length ? `\n${notices.join('\n')}` : ''}${reportNotice(sent)}\n${renderGroup(safe, readAllTasks(dir))}`;
}

export function toolGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const { safe, dir, campaign } = groupPath(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  // 받는 쪽이 그 태스크를 여는 것이 곧 읽음 표시다(note-5 §3-2 (8)).
  markRead(dir, Number(number), OWNER);
  return renderTask(safe, readOneTask(dir, cur, number), campaign);
}

export function toolList({ group_id, all } = {}) {
  // 기본: 내 패널에 배정된 것만. all=true면 다른 패널 포함 전체(오버사이트).
  // group_id 를 줘도 이 필터가 걸린다 — 목록과 task_next 가 어긋나던 자리다(note-3 §5 결함 2).
  const mine = (tasks) => (all ? tasks : tasks.filter((task) => (task.assignee || '') === OWNER));
  if (group_id) {
    const { safe, dir, campaign } = groupPath(group_id);
    const tasks = mine(readAllTasks(dir));
    if (!tasks.length) {
      return all
        ? campaignHint(campaign) + renderGroup(safe, [])
        : `내 태스크 없음: ${safe} (다른 패널 것 보려면 all:true).`;
    }
    return campaignHint(campaign) + renderGroup(safe, tasks, !!all);
  }
  const blocks = [];
  for (const id of listGroupIds()) {
    const { dir, campaign } = groupPath(id);
    const tasks = mine(readAllTasks(dir));
    if (tasks.length) blocks.push(campaignHint(campaign) + renderGroup(id, tasks, !!all));
  }
  if (!blocks.length) return all ? '태스크 없음. task_add로 시작하세요.' : '내 태스크 없음(다른 패널 것 보려면 all:true).';
  return blocks.join('\n\n');
}

function noCandidateMessage(safe, tasks, pending, myKinds, roles) {
  if (!pending.length) {
    if (tasks.length && tasks.every((task) => task.status === 'completed')) {
      return `모든 태스크가 완료되었습니다: ${safe}.`;
    }
    return `가져갈 태스크가 없습니다: ${safe}.`;
  }
  const mineKind = pending.filter((task) => myKinds.includes(task.kind));
  if (!mineKind.length) {
    const others = {};
    for (const task of pending) others[task.kind] = (others[task.kind] || 0) + 1;
    const summary = Object.entries(others).map(([kind, count]) => `${kind} ${count}개`).join(' · ');
    const roleNames = roles.map((role) => ROLE_LABEL[role] || role).join(', ');
    return `내 역할(${roleNames})이 맡는 태스크가 없습니다: ${safe}.\n남은 pending — ${summary}`;
  }
  const takeable = mineKind.filter((task) => canTake(task.kind, task.assignee, OWNER));
  if (!takeable.length) {
    return `내 역할이 맡는 pending ${mineKind.length}개가 모두 다른 패널에 배정되어 있습니다: ${safe}.`;
  }
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.number));
  const waits = takeable.map((task) => {
    const unresolved = task.depends_on.filter((dependency) => !completed.has(dependency));
    return `#${task.number} → ${unresolved.map((dependency) => `#${dependency}`).join(', ')}`;
  });
  return `선행 태스크가 끝나지 않아 모두 막혀 있습니다: ${safe}.\n${waits.join('\n')}`;
}

// 번호를 지정해 집을 때 왜 못 집는지 한 가지로 답한다(백로그 12). 자동 선택과 같은 조건을 보되,
// 후보에서 조용히 빠지는 대신 그 번호가 걸린 까닭을 짚는다.
function refuseNumbered(task, number, safe, myKinds, roles, completed) {
  if (!task) return `#${number} 를 그룹 "${safe}" 에서 못 찾았습니다.`;
  if (task.status !== 'pending') {
    return task.status === 'in_progress'
      ? `#${number} 는 다른 패널이 진행 중입니다.`
      : `#${number} 는 ${task.status} 라 집을 수 없습니다. 집을 수 있는 것은 pending 입니다.`;
  }
  if (!myKinds.includes(task.kind)) {
    const roleNames = roles.map((role) => ROLE_LABEL[role] || role).join(', ');
    return `#${number} 는 ${task.kind} 라 내 역할(${roleNames})이 맡지 않습니다.`;
  }
  if (!canTake(task.kind, task.assignee, OWNER)) {
    return `#${number} 는 다른 패널에 배정되어 있습니다.`;
  }
  const unresolved = task.depends_on.filter((dependency) => !completed.has(dependency));
  if (unresolved.length) {
    return `#${number} 는 선행 태스크가 끝나지 않았습니다: ${unresolved.map((dependency) => `#${dependency}`).join(', ')}.`;
  }
  return null;
}

export function toolNext({ group_id, number }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  requireOwner(OWNER);
  if (number != null && (!Number.isInteger(number) || number <= 0)) {
    throw new Error('number 는 양의 정수 태스크 번호여야 합니다.');
  }

  // 두 호출이 같은 pending 파일을 골라도 rename에 성공한 한쪽만 상태를 쓴다.
  // 늦은 호출은 처음부터 다시 읽어 이미 in_progress가 된 태스크를 돌려준다.
  while (true) {
    const { safe, dir, campaign } = requireGroup(group_id);
    const record = readGroupRecord(dir);
    const me = memberOf(record, OWNER);
    // 거절 문구는 쓰기 쪽과 같은 함수를 씁니다 — 같은 뜻을 두 번 말하던 자리입니다(백로그 13).
    if (!me) requireMember(record, safe);

    const tasks = readAllTasks(dir);
    // 남의 in_progress 는 보지 않는다(note-3 §5 결함 1).
    const current = tasks.find((task) => task.status === 'in_progress' && (task.assignee || '') === OWNER);
    if (current) {
      // 지금 잡은 것을 다시 부르면 그대로 돌려준다. 다른 번호를 부르면 둘을 한꺼번에 잡지 않게 막는다.
      if (number != null && current.number !== number) {
        throw new Error(
          `#${current.number} 를 진행 중이라 #${number} 를 집을 수 없습니다.`
          + ` 먼저 끝내거나 task_update 로 #${current.number} 를 pending 으로 되돌리십시오.`,
        );
      }
      return `이미 진행 중인 태스크입니다.\n${renderTask(safe, current, campaign)}`;
    }

    const myKinds = kindsForRoles(me.roles);
    const pending = tasks.filter((task) => task.status === 'pending');
    const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.number));

    let selected;
    if (number != null) {
      const wanted = tasks.find((task) => task.number === number);
      const refusal = refuseNumbered(wanted, number, safe, myKinds, me.roles, completed);
      if (refusal) throw new Error(refusal);
      selected = wanted;
    } else {
      const eligible = receivablePending(tasks)
        .filter((task) => myKinds.includes(task.kind))
        .filter((task) => canTake(task.kind, task.assignee, OWNER));

      if (!eligible.length) return noCandidateMessage(safe, tasks, pending, myKinds, me.roles);
      selected = eligible[0];
    }
    const writable = requireWritableGroup(group_id);
    if (writable.dir !== dir) continue;
    selected.status = 'in_progress';
    // 집는 순간 빈 assignee 를 부른 패널로 채운다 — 5-2 의 「내 in_progress」 판정과 task_list 가
    // 같은 값을 보게 하려는 것이다(매니저 결정 M-1).
    if (!String(selected.assignee || '').trim()) selected.assignee = OWNER;
    const source = path.join(dir, selected.file);
    const target = path.join(dir, fileNameFor(selected));
    try {
      fs.renameSync(source, target);
    } catch (cause) {
      if (cause.code === 'ENOENT') continue;
      throw cause;
    }

    selected.updated_at = now();
    writeTask(target, selected);
    markGroupInProgress(dir);
    return `다음 태스크를 시작합니다.\n${renderTask(safe, selected, campaign)}`;
  }
}
