import fs from 'node:fs';
import path from 'node:path';

import {
  GROUP_STATUSES,
  OWNER,
  campaignDir,
  datedName,
  groupPath,
  listGroupIds,
  now,
  projectDir,
  readGroupRecord,
  readTasks,
  requireCampaign,
  requireGroup,
  requireWritableGroup,
  safeName,
  subDirNames,
  tasksRoot,
  writeGroupRecord,
} from '../lib.mjs';
import {
  ROLES,
  assertSingleManager,
  receivablePending,
  resolveSurface,
  validateMembers,
} from '../model.mjs';
import { renderGroup } from './task.mjs';
import { contextFiles } from './context.mjs';

const GROUP_STATUS_LABEL = { pending: '대기', in_progress: '진행 중', done: '완료' };
const ROLE_LABEL = { manager: '매니저', worker: '워커', tester: '테스터', reviewer: '리뷰어' };

function dateNotice(strippedDates) {
  return strippedDates.length
    ? `(주제 앞머리의 날짜 ${strippedDates.join(', ')} 를 뗐습니다)\n`
    : '';
}

function inferLegacyStatus(tasks) {
  if (tasks.length && tasks.every((task) => task.status === 'completed')) return 'done';
  if (tasks.some((task) => task.status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function resolveEntry(entry) {
  const { surface, ref } = resolveSurface(entry.surface);
  return {
    name: String(entry.name),
    surface,
    ref: ref ?? entry.ref ?? null,
    roles: [...entry.roles],
    scope: entry.scope ?? '',
    session: entry.session ?? null,
  };
}

// 넘어온 members 를 빼는 것과 넣거나 고치는 것으로 나눈다. surface:N 은 여기서 UUID 가 된다.
function readIncomingMembers(members) {
  if (!Array.isArray(members)) throw new Error('members 는 배열이어야 합니다.');
  const removals = [];
  const upserts = [];
  for (const entry of members) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('members 항목은 { name, surface, roles } 형식이어야 합니다.');
    }
    if (entry.remove === true) {
      if (!String(entry.name ?? '').trim()) throw new Error('members 에서 뺄 항목에도 name 이 필요합니다.');
      removals.push(String(entry.name));
      continue;
    }
    upserts.push(entry);
  }
  validateMembers(upserts);
  return { removals, upserts: upserts.map(resolveEntry) };
}

// 갱신은 이름으로 맞춰 그 사람만 바꾼다. 없는 이름은 더하고, remove:true 항목은 뺀다(SPEC 3-1).
function mergeMembers(existing, members) {
  const { removals, upserts } = readIncomingMembers(members);
  const out = existing.filter((entry) => !removals.includes(entry.name));
  for (const entry of upserts) {
    const at = out.findIndex((member) => member.name === entry.name);
    if (at >= 0) out[at] = { ...out[at], ...entry };
    else out.push(entry);
  }
  return assertSingleManager(out);
}

// members 를 안 주면 부른 패널이 매니저로 들어간다 — 그룹을 만드는 쪽이 매니저이기 때문이다(SPEC 3-1).
function callerAsManager() {
  if (!String(OWNER || '').trim()) {
    throw new Error('cmux 패널 밖에서는 정체를 알 수 없어 거절합니다. members 를 직접 주십시오.');
  }
  return [{
    name: String(OWNER).slice(0, 8),
    surface: OWNER,
    ref: null,
    roles: ['manager'],
    scope: '',
    session: null,
  }];
}

function groupView(found) {
  const record = readGroupRecord(found.dir);
  if (record) return { ...record, campaign: record.campaign ?? found.campaign, legacy: false };
  const tasks = readTasks(found.dir);
  return {
    id: found.safe,
    title: found.safe,
    about: '',
    status: inferLegacyStatus(tasks),
    campaign: found.campaign,
    members: [],
    created_at: null,
    updated_at: null,
    legacy: true,
  };
}

function markdownFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch { return []; }
}

export function groupDocuments(dir) {
  const notes = markdownFiles(path.join(dir, 'notes'));
  const contexts = contextFiles(dir).map((entry) => entry.file);
  const plans = markdownFiles(path.join(dir, 'plans'));
  const researches = subDirNames(path.join(dir, 'researches')).sort();
  return { notes, contexts, plans, researches };
}

function membersLabel(members) {
  const list = Array.isArray(members) ? members : [];
  return ROLES.map((role) => {
    const names = list
      .filter((entry) => Array.isArray(entry.roles) && entry.roles.includes(role))
      .map((entry) => entry.name || '(이름 없음)');
    return `${ROLE_LABEL[role]} ${names.length ? names.join(', ') : '(없음)'}`;
  }).join(' · ');
}

function dashboardBlock(group, tasks, notes, contexts, plans, researches = []) {
  const done = tasks.filter((task) => task.status === 'completed').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const drafts = tasks.filter((task) => task.status === 'draft').length;
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const next = receivablePending(tasks)[0];
  const campaign = group.campaign ? `  ·  캠페인 ${group.campaign}` : '';
  const nextLabel = next
    ? `#${next.number} ${next.tag ? `[${next.tag}] ` : ''}${next.content}`
    : (pending ? `없음 (선행 대기 ${pending}개)` : '없음');
  return `[${group.id}]  ${GROUP_STATUS_LABEL[group.status] || group.status}${campaign}${group.legacy ? '  ·  옛 그룹' : ''}\n` +
    `  ${membersLabel(group.members)}\n` +
    `  태스크 ${done}/${tasks.length} 완료 · 진행 중 ${inProgress}개 · 다음 → ${nextLabel} · draft ${drafts}개\n` +
    `  노트 ${notes.length}개 · 맥락 ${contexts.length}개 · 계획서 ${plans.length}개 · 조사 ${researches.length}개`;
}

export function toolGroupAdd({ topic, campaign, about, title, members }) {
  if (!topic) throw new Error('topic은 필수입니다.');
  const named = datedName(topic);
  const c = campaign ? requireCampaign(campaign) : null;
  const id = c ? `task-group-${named.id}` : named.id;
  const dir = c ? path.join(campaignDir(c), id) : path.join(tasksRoot(), id);
  const found = groupPath(named.id);
  if (fs.existsSync(found.dir)) {
    throw new Error(`이미 있는 그룹입니다: ${named.id}${found.campaign ? ` (캠페인 ${found.campaign})` : ''}`);
  }

  const roster = members == null ? callerAsManager() : mergeMembers([], members);

  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now();
  const record = {
    id,
    title: title || named.topic || 'task',
    about: about || '',
    status: 'pending',
    campaign: c,
    members: roster,
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeGroupRecord(dir, record);
  return `${dateNotice(named.strippedDates)}그룹 생성: group_id="${id}".\n${dashboardBlock(record, [], [], [], [])}`;
}

export function toolGroupUpdate({ group_id, title, about, status, members }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  if (title == null && about == null && status == null && members == null) {
    throw new Error('바꿀 값(title / about / status / members 중 하나 이상)이 필요합니다.');
  }
  if (status != null && !GROUP_STATUSES.includes(status)) {
    throw new Error(`status는 ${GROUP_STATUSES.join(' | ')} 중 하나여야 합니다.`);
  }

  const readable = requireGroup(group_id);
  readGroupRecord(readable.dir);
  const found = requireWritableGroup(group_id);
  const timestamp = now();
  const existing = readGroupRecord(found.dir);
  const record = existing || {
    id: found.safe,
    title: found.safe,
    about: '',
    status: inferLegacyStatus(readTasks(found.dir)),
    campaign: found.campaign,
    members: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (title != null) record.title = title;
  if (about != null) record.about = about;
  if (status != null) record.status = status;
  if (members != null) record.members = mergeMembers(record.members || [], members);
  record.updated_at = timestamp;
  writeGroupRecord(found.dir, record);
  return `그룹 업데이트: ${found.safe}.\n${dashboardBlock(record, readTasks(found.dir), ...Object.values(groupDocuments(found.dir)))}`;
}

export function toolGroupGet({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  const found = requireGroup(group_id);
  const group = groupView(found);
  const tasks = readTasks(found.dir);
  const { notes, contexts, plans, researches } = groupDocuments(found.dir);
  return `${dashboardBlock(group, tasks, notes, contexts, plans, researches)}\n\n` +
    `제목: ${group.title}\n설명: ${group.about || '(없음)'}\n` +
    `생성: ${group.created_at || '(옛 그룹 — 기록 없음)'}\n수정: ${group.updated_at || '(옛 그룹 — 기록 없음)'}\n\n` +
    `## 태스크\n${renderGroup(group.id, tasks)}\n\n` +
    `## 노트\n${notes.join('\n') || '(없음)'}\n\n` +
    `## 맥락\n${contexts.join('\n') || '(없음)'}\n\n` +
    `## 계획서\n${plans.join('\n') || '(없음)'}\n\n` +
    `## 조사\n${researches.map((name) => `researches/${name}/`).join('\n') || '(없음)'}`;
}

export function toolGroupList({ campaign, all } = {}) {
  const campaignFilter = campaign == null ? null : safeName(campaign);
  const blocks = [];
  for (const groupId of listGroupIds()) {
    const found = groupPath(groupId);
    if (campaignFilter != null && found.campaign !== campaignFilter) continue;
    const group = groupView(found);
    const tasks = readTasks(found.dir);
    if (!tasks.length && group.legacy) continue;
    if (!all && group.status === 'done') continue;
    const { notes, contexts, plans, researches } = groupDocuments(found.dir);
    blocks.push(dashboardBlock(group, tasks, notes, contexts, plans, researches));
  }
  if (!blocks.length) return '태스크 그룹 없음. task_group_add로 시작하세요.';
  return blocks.join('\n\n');
}

export function toolGroupResearch({ group_id, topic }) {
  if (!group_id || typeof topic !== 'string' || !topic.trim()) throw new Error('group_id, topic은 필수입니다.');
  const found = requireGroup(group_id);
  const named = datedName(topic);
  const folder = `research-${named.id}`;
  if (fs.existsSync(path.join(found.dir, 'researches', folder))) throw new Error(`이미 있는 조사 폴더입니다: ${folder}`);
  const writable = requireWritableGroup(group_id);
  const dir = path.join(writable.dir, 'researches', folder);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  return `${dateNotice(named.strippedDates)}조사 폴더를 만들었습니다: ${path.relative(projectDir(), dir)}/`;
}
