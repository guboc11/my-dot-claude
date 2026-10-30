import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { parseMarkdownRecord, renderMarkdownRecord, withLineNumbers } from '../lib.mjs';
import {
  PROJECT_SERVER, callTool, callToolError, listTools, listToolsOutput,
  makeProject, mcpTaskGroupDir, legacyTaskGroupDir, removeProject,
} from './helpers.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const projects = [];
after(() => projects.forEach(removeProject));

function fixture() {
  const project = makeProject('task-mcp-g14-');
  projects.push(project);
  return project;
}

function addGroup(project, campaign) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '그룹 맥락', campaign }, MANAGER);
  return /group_id="([^"]+)"/.exec(output)[1];
}

function contextDir(project, groupId, campaign) {
  return campaign
    ? path.join(project, '.claude', 'mcp-task-campaign', campaign, groupId, 'context')
    : path.join(mcpTaskGroupDir(project, groupId), 'context');
}

function readContext(project, groupId, number = 1, campaign) {
  const dir = contextDir(project, groupId, campaign);
  const file = fs.readdirSync(dir).find((name) => new RegExp(`^context-${number}-.+\\.md$`).test(name));
  const full = path.join(dir, file);
  const text = fs.readFileSync(full, 'utf8');
  return { file, full, text, ...parseMarkdownRecord(text) };
}

test('G14: text로 추가하고 앞머리·줄 번호·목록을 읽으며 명단 밖 작성자도 기록합니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  const output = callTool(PROJECT_SERVER, project, 'task_group_context_add', {
    group_id: groupId, title: '이름 결정', text: '관리자 배경\n둘째 줄',
  }, 'surface:author');
  assert.match(output, /number=1, file="context\/context-1-이름-결정.md"/);
  const context = readContext(project, groupId);
  assert.deepEqual(context.metadata, {
    number: '1', title: '이름 결정', author: 'surface:author',
    created_at: context.metadata.created_at, updated_at: context.metadata.created_at,
  });
  assert.equal(context.body, '관리자 배경\n둘째 줄');
  const get = callTool(PROJECT_SERVER, project, 'task_group_context_get', { group_id: groupId, number: 1 });
  assert.deepEqual(parseMarkdownRecord(`${get}\n`).metadata, context.metadata);
  assert.ok(get.endsWith(withLineNumbers(context.body)));
  const list = callTool(PROJECT_SERVER, project, 'task_group_context_list', { group_id: groupId });
  assert.ok(list.includes(`#1 이름 결정 · 작성 surface:author · 생성 ${context.metadata.created_at} · 수정 ${context.metadata.updated_at}`));
  assert.deepEqual(fs.readdirSync(contextDir(project, groupId)), [context.file]);
});

test('G14: append와 제목 변경은 작성자·생성 시각을 보존하고 파일 이름을 바꿉니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '처음', text: '첫 본문' }, 'surface:author');
  const before = readContext(project, groupId);
  callTool(PROJECT_SERVER, project, 'task_group_context_update', {
    group_id: groupId, number: 1, title: '새 이름', field: 'body', mode: 'append', text: '뒤 본문',
  }, 'surface:other');
  const changed = readContext(project, groupId);
  assert.equal(changed.file, 'context-1-새-이름.md');
  assert.equal(fs.existsSync(before.full), false);
  assert.equal(changed.metadata.title, '새 이름');
  assert.equal(changed.metadata.author, before.metadata.author);
  assert.equal(changed.metadata.created_at, before.metadata.created_at);
  assert.notEqual(changed.metadata.updated_at, before.metadata.updated_at);
  assert.equal(changed.body, '첫 본문\n\n뒤 본문');
});

test('G14: 편집 모드·줄 삽입·gap과 제목 단독 변경을 공통 계약대로 적용합니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '제목', text: '첫 줄\n끝 줄' });
  const update = (args) => callTool(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, field: 'body', ...args });
  update({ mode: 'append', at: 'start', gap: false, text: '머리말' });
  update({ mode: 'edit', old: '첫 줄', new: '수정한 줄' });
  update({ mode: 'edit', insert_after: 2, text: '삽입한 줄' });
  assert.equal(readContext(project, groupId).body, '머리말\n수정한 줄\n삽입한 줄\n끝 줄');
  const before = readContext(project, groupId);
  callTool(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, title: '단독 제목 변경' });
  assert.equal(readContext(project, groupId).body, before.body);
  update({ mode: 'replace', text: '동일 동일' });
  update({ mode: 'edit', old: '동일', new: '새값', replace_all: true });
  assert.equal(readContext(project, groupId).body, '새값 새값');
  update({ mode: 'replace', text: '' });
  assert.equal(readContext(project, groupId).body, '');
});

test('G14: 편집 실패는 본문·제목·파일 이름·수정 시각을 보존합니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '원제목', text: '기존 기존\n끝' });
  const before = readContext(project, groupId);
  const mtime = fs.statSync(before.full).mtimeMs;
  for (const args of [
    { field: 'body', text: '추가' },
    { field: 'body', mode: 'edit', old: '없음', new: '수정' },
    { field: 'body', mode: 'edit', old: '기존', new: '수정' },
    { field: 'body', mode: 'edit', old: '기존', new: '기존' },
    { field: 'body', mode: 'edit', insert_after: 3, text: '추가' },
    { append: true, body: '옛 쓰기' },
    { body: '옛 교체' },
    { field: 'body', mode: 'replace', text: '새 글', body: '옛 글' },
    { field: 'outside', mode: 'replace', text: '잘못된 칸' },
    { mode: 'replace', text: 'field 누락' },
    { field: 'body', mode: 'edit', old: '기존', new: '수정', gap: false },
    { title: '앞머리\n잘못된 제목' },
  ]) {
    callToolError(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, title: '바뀌면 안 됨', ...args });
    assert.deepEqual(readContext(project, groupId), before);
    assert.equal(fs.statSync(before.full).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(contextDir(project, groupId)), [before.file]);
  }
});

test('G14: 번호 없는 파일과 하위 폴더는 읽거나 세지 않고 번호는 context에서만 이어집니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  const dir = contextDir(project, groupId);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CONTEXT.md'), '앞머리 없는 옛 자료');
  fs.mkdirSync(path.join(dir, 'context-99-폴더.md'));
  fs.writeFileSync(path.join(dir, 'context-99-폴더.md', 'context-100-내부.md'), '읽으면 오류');
  const seed = renderMarkdownRecord({ number: 7, title: '기존 맥락', author: 'seed', created_at: '당시', updated_at: '당시' }, '기존 본문');
  fs.writeFileSync(path.join(dir, 'context-7-기존-맥락.md'), seed);
  const notes = path.join(mcpTaskGroupDir(project, groupId), 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'note-88-노트.md'), '다른 번호');
  const added = callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '새 맥락', text: '새 본문' });
  assert.match(added, /number=8/);
  const list = callTool(PROJECT_SERVER, project, 'task_group_context_list', { group_id: groupId });
  assert.ok(list.includes('#7 기존 맥락'));
  assert.ok(list.includes('#8 새 맥락'));
  assert.doesNotMatch(list, /CONTEXT|폴더|내부|#99|#100/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_context_get', { group_id: groupId, number: 99 }), /context-99 를 찾지 못했습니다/);
  const get = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId });
  assert.equal(get.split('\n')[3], '  노트 1개 · 맥락 2개 · 계획서 0개 · 조사 0개');
  assert.doesNotMatch(get, /CONTEXT|폴더|내부/);
  assert.equal(fs.readFileSync(path.join(dir, 'CONTEXT.md'), 'utf8'), '앞머리 없는 옛 자료');
});

test('G14: get·list·update 대시보드의 네 문서 수와 맥락 절 순서를 유지합니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  callTool(PROJECT_SERVER, project, 'task_group_note_add', { group_id: groupId, title: '노트', body: '본문' });
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '배경', text: '본문' });
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '결정', text: '본문' });
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '계획' });
  callTool(PROJECT_SERVER, project, 'task_group_research', { group_id: groupId, topic: '조사' });
  const expected = '  노트 1개 · 맥락 2개 · 계획서 1개 · 조사 1개';
  const get = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId });
  assert.equal(get.split('\n')[3], expected);
  assert.equal(callTool(PROJECT_SERVER, project, 'task_group_list', { all: true }).split('\n')[3], expected);
  assert.equal(callTool(PROJECT_SERVER, project, 'task_group_update', { group_id: groupId, about: '설명 변경' }).split('\n')[4], expected);
  assert.match(get, /## 노트\n[\s\S]*?\n\n## 맥락\ncontext-1-배경.md\ncontext-2-결정.md\n\n## 계획서/);
});

test('G14: 캠페인 소속 그룹도 자체 context를 쓰고 캠페인 차례는 그대로 둡니다', () => {
  const project = fixture();
  const campaignOutput = callTool(PROJECT_SERVER, project, 'campaign_add', { name: '맥락 캠페인' });
  const campaign = /캠페인 생성: ([^\n]+)/.exec(campaignOutput)[1];
  const groupId = addGroup(project, campaign);
  const index = path.join(project, '.claude', 'mcp-task-campaign', campaign, 'campaign-main-context', 'INDEX.md');
  const before = fs.readFileSync(index, 'utf8');
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '그룹 배경', text: '그룹만의 배경' });
  callTool(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, field: 'body', mode: 'append', text: '결정' });
  assert.equal(readContext(project, groupId, 1, campaign).body, '그룹만의 배경\n\n결정');
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_context_get', { group_id: groupId, number: 1 }), /   3│ 결정/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_context_list', { group_id: groupId }), /#1 그룹 배경/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }), /맥락 1개/);
  assert.equal(fs.readFileSync(index, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(contextDir(project, groupId, campaign)), ['context-1-그룹-배경.md']);
});

test('G14: 옛 경로 읽기와 편집 실패는 승격하지 않고 성공한 편집만 새 자리에 씁니다', () => {
  const project = fixture();
  const groupId = '2026-08-01-옛-맥락';
  const dir = path.join(legacyTaskGroupDir(project, groupId), 'context');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'context-1-옛-제목.md');
  const raw = renderMarkdownRecord({ number: 1, title: '옛 제목', author: '옛 작성자', created_at: '당시', updated_at: '당시' }, '옛 본문');
  fs.writeFileSync(file, raw);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_context_get', { group_id: groupId, number: 1 }), /   1│ 옛 본문/);
  callToolError(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, field: 'body', mode: 'edit', old: '없음', new: '수정' });
  callToolError(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '오류\n제목', text: '본문' });
  assert.equal(fs.existsSync(mcpTaskGroupDir(project, groupId)), false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  callTool(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, field: 'body', mode: 'append', text: '새 본문' });
  assert.equal(readContext(project, groupId).body, '옛 본문\n\n새 본문');
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('G14: 긴 제목은 앞머리에 보존하고 파일 이름의 제목만 60자로 자릅니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  const title = '가'.repeat(61);
  callTool(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title, text: '' });
  assert.equal(readContext(project, groupId).metadata.title, title);
  assert.equal(readContext(project, groupId).file, `context-1-${'가'.repeat(60)}.md`);
  const updated = '나'.repeat(70);
  callTool(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number: 1, title: updated });
  assert.equal(readContext(project, groupId).metadata.title, updated);
  assert.equal(readContext(project, groupId).file, `context-1-${'나'.repeat(60)}.md`);
});

test('G14: 없는 문서·잘못된 번호·필수 입력 누락은 파일을 만들지 않습니다', () => {
  const project = fixture();
  const groupId = addGroup(project);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_context_list', { group_id: groupId }), /맥락 문서 없음/);
  for (const number of [0, -1, '1', 99]) {
    callToolError(PROJECT_SERVER, project, 'task_group_context_get', { group_id: groupId, number });
    callToolError(PROJECT_SERVER, project, 'task_group_context_update', { group_id: groupId, number, title: '제목' });
  }
  callToolError(PROJECT_SERVER, project, 'task_group_context_add', { group_id: groupId, title: '제목', body: '잘못된 인자' });
  assert.equal(fs.existsSync(contextDir(project, groupId)), false);
});

test('G14: 전체 36개 도구와 맥락 도구 네 개의 순서·인자가 매뉴얼 표와 같습니다', () => {
  const project = fixture();
  const tools = listTools(PROJECT_SERVER, project);
  assert.equal(tools.length, 36);
  const start = tools.indexOf('task_group_note_list') + 1;
  assert.deepEqual(tools.slice(start, start + 4), [
    'task_group_context_add', 'task_group_context_update', 'task_group_context_get', 'task_group_context_list',
  ]);
  const output = listToolsOutput(PROJECT_SERVER, project);
  const signatures = output.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(' — ')[0]);
  const manual = fs.readFileSync(path.join(path.dirname(PROJECT_SERVER), 'MANUAL.md'), 'utf8');
  const documented = [...manual.matchAll(/^\| `([a-z_]+\([^`]*\))` \|/gm)].map((match) => match[1]);
  assert.equal(signatures.length, 36);
  assert.deepEqual([...signatures].sort(), [...documented].sort());
});
