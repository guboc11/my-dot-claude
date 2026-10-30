import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { parseMarkdownRecord } from '../lib.mjs';
import {
  PROJECT_SERVER,
  callTool,
  callToolError,
  listTools,
  listToolsOutput,
  makeProject,
  mcpTaskGroupDir,
  removeProject,
} from './helpers.mjs';

const EMPTY = '<!-- 비어 있음 -->';
const SECTION_TITLES = ['왜', '스펙', '합의', '단계', '검증', '미결'];
const projects = [];

after(() => {
  for (const project of projects) removeProject(project);
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addGroup(project, topic) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic }, '11111111-1111-4111-8111-111111111111');
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function groupDir(project, groupId) {
  return mcpTaskGroupDir(project, groupId);
}

function plansDir(project, groupId) {
  return path.join(groupDir(project, groupId), 'plans');
}

function planFile(project, groupId, number) {
  return fs.readdirSync(plansDir(project, groupId))
    .find((file) => new RegExp(`^plan-${number}-.+\\.md$`).test(file));
}

function parseSections(body) {
  const match = /^## 왜\n([\s\S]*?)\n\n## 스펙\n([\s\S]*?)\n\n## 합의\n([\s\S]*?)\n\n## 단계\n([\s\S]*?)\n\n## 검증\n([\s\S]*?)\n\n## 미결\n([\s\S]*)$/.exec(body);
  assert.ok(match, '여섯 고정 칸의 제목과 순서가 유지되어야 합니다.');
  return Object.fromEntries(SECTION_TITLES.map((title, index) => [title, match[index + 1]]));
}

function readPlan(project, groupId, number) {
  const file = planFile(project, groupId, number);
  const full = path.join(plansDir(project, groupId), file);
  const text = fs.readFileSync(full, 'utf8');
  const parsed = parseMarkdownRecord(text);
  return { file, full, text, ...parsed, sections: parseSections(parsed.body) };
}

function getEmptySummary(project, groupId, number) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_plan_get', { group_id: groupId, number });
  const match = /안 채운 칸 (\d+)개: ([^\n]+)$/.exec(output);
  assert.ok(match, 'plan_get 꼬리에 빈칸 요약이 있어야 합니다.');
  return { output, count: Number(match[1]), names: match[2] };
}

function listEmptyCount(project, groupId, number) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_plan_list', { group_id: groupId });
  const match = new RegExp(`#${number} [^\\n]+ · 빈칸 (\\d+)개`).exec(output);
  assert.ok(match, 'plan_list에 계획서별 빈칸 수가 있어야 합니다.');
  return { output, count: Number(match[1]) };
}

test('G5: 새 계획서는 여섯 고정 칸과 빈칸 표시 6개로 시작한다', () => {
  const project = fixture('task-mcp-g5-template-');
  const groupId = addGroup(project, '계획서 틀');
  const addOutput = callTool(PROJECT_SERVER, project, 'task_group_plan_add', {
    group_id: groupId,
    title: '스펙 누락 방지 계획',
  }, 'surface:author');
  assert.match(addOutput, /number=1/);
  assert.match(addOutput, /안 채운 칸 6개: 왜, 스펙, 합의, 단계, 검증, 미결/);

  const plan = readPlan(project, groupId, 1);
  assert.equal(plan.file, 'plan-1-스펙-누락-방지-계획.md');
  assert.deepEqual(plan.metadata, {
    number: '1',
    title: '스펙 누락 방지 계획',
    author: 'surface:author',
    created_at: plan.metadata.created_at,
    updated_at: plan.metadata.updated_at,
  });
  assert.equal(plan.metadata.created_at, plan.metadata.updated_at);
  assert.deepEqual(Object.keys(plan.sections), SECTION_TITLES);
  assert.ok(Object.values(plan.sections).every((body) => body === EMPTY));
  assert.equal((plan.body.match(/<!-- 비어 있음 -->/g) || []).length, 6);

  const get = getEmptySummary(project, groupId, 1);
  const list = listEmptyCount(project, groupId, 1);
  assert.equal(get.count, 6);
  assert.equal(get.names, '왜, 스펙, 합의, 단계, 검증, 미결');
  assert.equal(list.count, get.count);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }), /노트 0개 · 맥락 0개 · 계획서 1개/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_list', { all: true }), /노트 0개 · 맥락 0개 · 계획서 1개/);
  console.log('fresh_plan_empty_sections=6');
  console.log('fixed_section_titles=왜,스펙,합의,단계,검증,미결');
  console.log('group_plan_count=1');
});

test('G5: 세 칸을 채우면 나머지 다섯 칸을 훼손하지 않고 빈칸 3개를 정확히 보고한다', () => {
  const project = fixture('task-mcp-g5-three-sections-');
  const groupId = addGroup(project, '세 칸 수정');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', {
    group_id: groupId,
    title: '세 칸 계획',
  }, 'surface:author');
  const initial = readPlan(project, groupId, 1);

  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'why',
    mode: 'replace', text: '문제와 배경',
  });
  const afterWhy = readPlan(project, groupId, 1);
  assert.equal(afterWhy.sections['왜'], '문제와 배경');
  for (const title of SECTION_TITLES.slice(1)) {
    assert.equal(afterWhy.sections[title], initial.sections[title], `${title} 칸이 함께 바뀌면 안 됩니다.`);
  }
  assert.deepEqual(Object.keys(afterWhy.sections), SECTION_TITLES);

  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'agreement',
    mode: 'replace', text: '정한 것과 하지 않을 것',
  });
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'steps',
    mode: 'replace', text: '구현 순서',
  });
  const finalPlan = readPlan(project, groupId, 1);
  assert.equal(finalPlan.metadata.author, initial.metadata.author);
  assert.equal(finalPlan.metadata.created_at, initial.metadata.created_at);
  assert.notEqual(finalPlan.metadata.updated_at, initial.metadata.updated_at);
  assert.equal(finalPlan.sections['스펙'], EMPTY);
  assert.equal(finalPlan.sections['검증'], EMPTY);
  assert.equal(finalPlan.sections['미결'], EMPTY);

  const get = getEmptySummary(project, groupId, 1);
  const list = listEmptyCount(project, groupId, 1);
  assert.equal(get.count, 3);
  assert.equal(get.names, '스펙, 검증, 미결');
  assert.equal(list.count, get.count);
  console.log('filled_sections=왜,합의,단계');
  console.log('remaining_sections=스펙,검증,미결');
  console.log('get_list_empty_count=3,3');
});

test('G5: append는 지정한 한 칸 안에서만 이어붙는다', () => {
  const project = fixture('task-mcp-g5-append-');
  const groupId = addGroup(project, '칸 내부 이어붙이기');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', {
    group_id: groupId,
    title: '이어붙이기 계획',
  });
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'spec',
    mode: 'replace', text: '입출력 계약',
  });
  const beforeAppend = readPlan(project, groupId, 1);
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'spec',
    mode: 'append', text: '화면 계약',
  });
  const afterAppend = readPlan(project, groupId, 1);
  assert.equal(afterAppend.sections['스펙'], '입출력 계약\n\n화면 계약');
  for (const title of SECTION_TITLES.filter((title) => title !== '스펙')) {
    assert.equal(afterAppend.sections[title], beforeAppend.sections[title], `${title} 칸으로 본문이 새면 안 됩니다.`);
    assert.doesNotMatch(afterAppend.sections[title], /입출력 계약|화면 계약/);
  }
  assert.equal(getEmptySummary(project, groupId, 1).count, 5);
  assert.equal(listEmptyCount(project, groupId, 1).count, 5);
  console.log('append_target_section=스펙');
  console.log('append_leaked_sections=0');
});

test('G5: 허용 목록 밖 section은 계획서 파일을 건드리지 않고 거부한다', () => {
  const project = fixture('task-mcp-g5-invalid-section-');
  const groupId = addGroup(project, '잘못된 칸 거부');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', {
    group_id: groupId,
    title: '거부 검증 계획',
  });
  const plan = readPlan(project, groupId, 1);
  const before = fs.readFileSync(plan.full, 'utf8');
  const beforeMtime = fs.statSync(plan.full).mtimeMs;
  const error = callToolError(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'outside',
    mode: 'replace', text: '틀 밖에 쓰면 안 되는 본문',
  });
  assert.match(error, /section은 why \| spec \| agreement \| steps \| verification \| open 중 하나/);
  assert.equal(fs.readFileSync(plan.full, 'utf8'), before);
  assert.equal(fs.statSync(plan.full).mtimeMs, beforeMtime);
  console.log('invalid_section_rejected=true');
  console.log('invalid_section_file_writes=0');
});

test('G5: 계획서 도구 스키마는 section과 mode로 편집합니다', () => {
  const project = fixture('task-mcp-g5-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  assert.deepEqual(tools.filter((name) => name.startsWith('task_group_plan_')), [
    'task_group_plan_add',
    'task_group_plan_update',
    'task_group_plan_get',
    'task_group_plan_list',
  ]);
  const signature = listToolsOutput(PROJECT_SERVER, project).split('\n')
    .find((line) => line.startsWith('- task_group_plan_update('));
  assert.equal(signature, '- task_group_plan_update(group_id, number, section, mode, text?, at?, gap?, old?, new?, replace_all?, insert_after?)');
  assert.doesNotMatch(signature, /document|content|title/);
  console.log(`plan_update_signature=${signature}`);
  console.log('whole_document_argument=false');
  console.log('g5_plan_tool_count=4');
  console.log(`visible_tool_count=${tools.length}`);
});

test('G5: 빈 칸을 채운 뒤 앞에 붙이기와 문자열·줄 편집을 적용합니다', () => {
  const project = fixture('task-mcp-g5-modes-');
  const groupId = addGroup(project, '계획서 편집');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '계획' });
  const update = (args) => callTool(PROJECT_SERVER, project, 'task_group_plan_update', { group_id: groupId, number: 1, section: 'spec', ...args });
  update({ mode: 'append', text: '첫 줄\n끝 줄' });
  update({ mode: 'append', at: 'start', text: '머리말' });
  update({ mode: 'edit', old: '첫 줄', new: '수정한 줄' });
  update({ mode: 'edit', insert_after: 3, text: '삽입한 줄' });
  const plan = readPlan(project, groupId, 1);
  assert.equal(plan.sections['스펙'], '머리말\n\n수정한 줄\n삽입한 줄\n끝 줄');
  for (const title of SECTION_TITLES.filter((title) => title !== '스펙')) assert.equal(plan.sections[title], EMPTY);
  const output = getEmptySummary(project, groupId, 1).output;
  assert.match(output, /   1│ ## 왜/);
  assert.match(output, /   4│ ## 스펙\n   5│ 머리말/);
  assert.match(output, /위 번호는 전체 본문 번호입니다/);
  update({ mode: 'replace', text: '' });
  assert.equal(getEmptySummary(project, groupId, 1).count, 6);
});

test('G5: 실패한 편집은 모든 칸과 파일 시각을 보존합니다', () => {
  const project = fixture('task-mcp-g5-atomic-');
  const groupId = addGroup(project, '계획서 실패 보존');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '계획' });
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', { group_id: groupId, number: 1, section: 'why', mode: 'replace', text: '기존 기존\n끝' });
  const before = readPlan(project, groupId, 1);
  const mtime = fs.statSync(before.full).mtimeMs;
  for (const args of [
    { text: 'mode 누락' },
    { mode: 'edit', old: '없음', new: '수정' },
    { mode: 'edit', old: '기존', new: '수정' },
    { mode: 'edit', old: '기존', new: '기존' },
    { mode: 'edit', insert_after: 3, text: '추가' },
    { append: true, body: '옛 쓰기' },
    { body: '옛 교체' },
    { mode: 'replace', text: '앞\n\n## 스펙\n다른 칸 침범' },
  ]) {
    callToolError(PROJECT_SERVER, project, 'task_group_plan_update', { group_id: groupId, number: 1, section: 'why', ...args });
    assert.deepEqual(readPlan(project, groupId, 1), before);
    assert.equal(fs.statSync(before.full).mtimeMs, mtime);
  }
});

test('G5: 옛 그룹 계획서의 실패한 편집은 새 그룹 사본을 만들지 않습니다', () => {
  const project = fixture('task-mcp-g5-legacy-edit-');
  const groupId = addGroup(project, '옛 계획서');
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '계획' });
  const source = mcpTaskGroupDir(project, groupId);
  const legacyRoot = path.join(project, '.claude', 'tasks');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.renameSync(source, path.join(legacyRoot, groupId));
  callToolError(PROJECT_SERVER, project, 'task_group_plan_update', { group_id: groupId, number: 1, section: 'why', mode: 'edit', old: '없음', new: '수정' });
  assert.equal(fs.existsSync(source), false);
});
