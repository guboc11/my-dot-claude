import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { PROJECT_SERVER, callTool, callToolError, listToolsOutput, makeProject, mcpTaskGroupDir, removeProject } from './helpers.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';

const projects = [];
after(() => projects.forEach(removeProject));

function fixture() {
  const project = makeProject('task-mcp-g12-');
  projects.push(project);
  return project;
}

function root(project) {
  return path.join(project, '.claude', 'mcp-task-backlog');
}

function readItem(project, number) {
  const file = fs.readdirSync(root(project)).find((file) => file.startsWith(`item-${number}-`));
  const full = path.join(root(project), file);
  return { file, full, record: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

test('G12: 태그 여섯 값으로 항목을 만들고 번호·본문·시각을 저장합니다', () => {
  const project = fixture();
  const tags = ['테스트', 'QA', '도구개발', '리서치', 'audit', '문서정리'];
  for (const [index, tag] of tags.entries()) {
    const number = index + 1;
    const title = `항목 ${number}`;
    const output = callTool(PROJECT_SERVER, project, 'backlog_add', { title, tag, body: '본문\n둘째 줄' });
    assert.match(output, new RegExp(`number=${number}`));
    const { file, record } = readItem(project, number);
    assert.equal(file, `item-${number}-[${tag}]-항목-${number}.json`);
    assert.deepEqual(record, { number, title, tag, body: '본문\n둘째 줄', state: 'open', created_at: record.created_at, updated_at: record.created_at });
  }
  assert.equal(callTool(PROJECT_SERVER, project, 'backlog_list', {}).split('\n').length, 6);
  assert.equal(callTool(PROJECT_SERVER, project, 'backlog_list', { tag: 'QA' }), '#2 [QA] 항목 2 (open)');
});

test('G12: 잘못된 태그는 저장 경로를 만들기 전에 거절합니다', () => {
  const project = fixture();
  const output = callToolError(PROJECT_SERVER, project, 'backlog_add', { title: '항목', tag: 'unknown' });
  assert.match(output, /tag 는 테스트 \| QA \| 도구개발 \| 리서치 \| audit \| 문서정리 중 하나여야 합니다/);
  assert.equal(fs.existsSync(root(project)), false);
  assert.match(callToolError(PROJECT_SERVER, project, 'backlog_list', { state: 'unknown' }), /state 는/);
  assert.equal(fs.existsSync(root(project)), false);
});

test('G12: 제목·태그 변경은 파일 이름을 바꾸고 상태 필터에 반영합니다', () => {
  const project = fixture();
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '원제목', tag: '도구개발', body: '원문' });
  const before = readItem(project, 1);
  callTool(PROJECT_SERVER, project, 'backlog_update', { number: 1, title: '새 제목', tag: 'QA', body: '', state: 'done' });
  const after = readItem(project, 1);
  assert.equal(fs.existsSync(before.full), false);
  assert.equal(after.file, 'item-1-[QA]-새-제목.json');
  assert.equal(after.record.body, '');
  assert.equal(after.record.state, 'done');
  assert.equal(after.record.created_at, before.record.created_at);
  assert.notEqual(after.record.updated_at, before.record.updated_at);
  assert.doesNotMatch(callTool(PROJECT_SERVER, project, 'backlog_list', {}), /#1/);
  assert.match(callTool(PROJECT_SERVER, project, 'backlog_list', { state: 'done' }), /#1 \[QA\] 새 제목 \(done\)/);
  const snapshot = fs.readFileSync(after.full, 'utf8');
  const mtime = fs.statSync(after.full).mtimeMs;
  callToolError(PROJECT_SERVER, project, 'backlog_update', { number: 1, title: '바뀌면 안 되는 제목', tag: 'unknown' });
  assert.equal(fs.readFileSync(after.full, 'utf8'), snapshot);
  assert.equal(fs.statSync(after.full).mtimeMs, mtime);
});

test('G12: drop은 파일을 남기고 기본 목록에서만 숨깁니다', () => {
  const project = fixture();
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '제외 항목', tag: 'audit' });
  const before = readItem(project, 1);
  callTool(PROJECT_SERVER, project, 'backlog_drop', { number: 1 });
  assert.equal(fs.existsSync(before.full), true);
  assert.equal(readItem(project, 1).record.state, 'dropped');
  assert.doesNotMatch(callTool(PROJECT_SERVER, project, 'backlog_list', {}), /#1/);
  assert.match(callTool(PROJECT_SERVER, project, 'backlog_list', { state: 'all' }), /#1 .*\(dropped\)/);
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '후속 항목', tag: '리서치' });
  assert.equal(readItem(project, 2).record.state, 'open');
});

function groupTasks(project, groupId) {
  const dir = mcpTaskGroupDir(project, groupId);
  return fs.readdirSync(dir).filter((file) => file.startsWith('task-'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

test('G12: 백로그 다섯 도구의 필수 인자를 공개합니다', () => {
  const output = listToolsOutput(PROJECT_SERVER, fixture());
  const lines = output.split('\n').filter((line) => line.startsWith('- backlog_'));
  assert.equal(lines.length, 5);
  assert.match(output, /- backlog_add\(title, tag, body\?\)/);
  assert.match(output, /- backlog_promote\(number, group_id\?, topic\?, batch\?, assignee\?\)/);
});

test('G12: 기존 그룹으로 승격하면 본문·태그·배치·담당자를 work 태스크에 넘깁니다', () => {
  const project = fixture();
  const groupOutput = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '승격 대상', members: [
      { name: 'MNGR', surface: MANAGER, roles: ['manager'] },
      { name: 'WRKR', surface: WORKER, roles: ['worker'] },
    ],
  }, MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(groupOutput)[1];
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '승격 항목', tag: 'QA', body: '작업 명세\n다음 줄' });
  const before = readItem(project, 1);
  const output = callTool(PROJECT_SERVER, project, 'backlog_promote', { number: 1, group_id: groupId, batch: 'b3', assignee: WORKER }, MANAGER);
  const [task] = groupTasks(project, groupId);
  assert.equal(task.content, '승격 항목');
  assert.equal(task.spec, '작업 명세\n다음 줄');
  assert.equal(task.tag, 'QA');
  assert.equal(task.kind, 'work');
  assert.equal(task.batch, 'b3');
  assert.equal(task.assignee, WORKER);
  assert.equal(task.status, 'pending');
  assert.match(output, /kind=work, status=pending/);
  const after = readItem(project, 1);
  assert.equal(after.file, before.file);
  assert.equal(after.record.state, 'promoted');
  assert.equal(after.record.created_at, before.record.created_at);
  assert.deepEqual(Object.keys(after.record).sort(), ['number', 'title', 'tag', 'body', 'state', 'created_at', 'updated_at'].sort());
  assert.doesNotMatch(callTool(PROJECT_SERVER, project, 'backlog_list', {}), /#1/);
});

test('G12: 담당자를 생략한 승격은 b1 draft를 만들고 toolAdd 안내를 보존합니다', () => {
  const project = fixture();
  const groupOutput = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '담당자 없는 승격' }, MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(groupOutput)[1];
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '배정 전 항목', tag: '도구개발', body: '구현 명세' });
  const output = callTool(PROJECT_SERVER, project, 'backlog_promote', { number: 1, group_id: groupId }, MANAGER);
  const [task] = groupTasks(project, groupId);
  assert.equal(task.batch, 'b1');
  assert.equal(task.assignee, '');
  assert.equal(task.status, 'draft');
  assert.equal(task.spec, '구현 명세');
  assert.match(output, /assignee 가 없어 draft 로 만들었습니다/);
  assert.equal(readItem(project, 1).record.state, 'promoted');
});

test('G12: topic으로 새 그룹을 만든 뒤 승격하고 빈 명세의 draft 안내를 보존합니다', () => {
  const project = fixture();
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '새 그룹 항목', tag: '리서치' });
  const output = callTool(PROJECT_SERVER, project, 'backlog_promote', { number: 1, topic: '새 승격 그룹' }, MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)[1];
  const [task] = groupTasks(project, groupId);
  assert.equal(task.kind, 'work');
  assert.equal(task.status, 'draft');
  assert.equal(task.spec, '');
  assert.equal(task.assignee, '');
  assert.equal(task.batch, 'b1');
  assert.match(output, /spec 이 비어 draft 로 만들었습니다/);
  assert.match(output, /assignee 가 없어 draft 로 만들었습니다/);
  assert.equal(readItem(project, 1).record.state, 'promoted');
  const group = JSON.parse(fs.readFileSync(path.join(mcpTaskGroupDir(project, groupId), 'TASK_GROUP.json'), 'utf8'));
  assert.equal(group.members[0].surface, MANAGER);
});

test('G12: 승격 대상·배치·정체 오류는 항목을 보존하고 새 그룹을 만들지 않습니다', () => {
  const project = fixture();
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '보존 항목', tag: '테스트', body: '명세' });
  const item = readItem(project, 1);
  const snapshot = fs.readFileSync(item.full, 'utf8');
  const mtime = fs.statSync(item.full).mtimeMs;
  for (const args of [
    { number: 1 },
    { number: 1, group_id: '없는-그룹' },
    { number: 1, topic: '실패 그룹', batch: 'b0' },
    { number: 1, topic: '실패 그룹', assignee: 123 },
    { number: 999, topic: '실패 그룹' },
  ]) callToolError(PROJECT_SERVER, project, 'backlog_promote', args, MANAGER);
  callToolError(PROJECT_SERVER, project, 'backlog_promote', { number: 1, topic: '정체 없는 그룹' }, '');
  assert.equal(fs.readFileSync(item.full, 'utf8'), snapshot);
  assert.equal(fs.statSync(item.full).mtimeMs, mtime);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'mcp-task')), false);
});

test('G12: 기존 그룹에 미등록 assignee로 승격하면 항목과 태스크를 보존합니다', () => {
  const project = fixture();
  const groupOutput = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '배정 거절' }, MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(groupOutput)[1];
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '미등록 배정 항목', tag: '도구개발', body: '명세' });
  const item = readItem(project, 1);
  const before = fs.readFileSync(item.full, 'utf8');
  const mtime = fs.statSync(item.full).mtimeMs;
  const output = callToolError(PROJECT_SERVER, project, 'backlog_promote', { number: 1, group_id: groupId, assignee: WORKER }, MANAGER);
  assert.ok(output.includes(`assignee 22222222 는 그룹 "${groupId}" 명단에 없습니다.`));
  assert.equal(fs.readFileSync(item.full, 'utf8'), before);
  assert.equal(fs.statSync(item.full).mtimeMs, mtime);
  assert.equal(readItem(project, 1).record.state, 'open');
  assert.deepEqual(groupTasks(project, groupId), []);
});

test('G12: topic과 assignee를 함께 주면 그룹을 만들기 전에 거절합니다', () => {
  const project = fixture();
  callTool(PROJECT_SERVER, project, 'backlog_add', { title: '새 그룹 배정 항목', tag: '도구개발', body: '명세' });
  const item = readItem(project, 1);
  const before = fs.readFileSync(item.full, 'utf8');
  const mtime = fs.statSync(item.full).mtimeMs;
  const output = callToolError(PROJECT_SERVER, project, 'backlog_promote', { number: 1, topic: '생기면 안 되는 그룹', assignee: WORKER }, MANAGER);
  assert.ok(output.includes('topic 으로 만드는 새 그룹에는 명단이 없어 assignee 를 받을 수 없습니다. 그룹을 먼저 만들어 members 를 등록한 뒤 group_id 로 승격하거나, assignee 없이 draft 로 승격하십시오.'));
  assert.equal(fs.existsSync(path.join(project, '.claude', 'mcp-task')), false);
  assert.equal(fs.readFileSync(item.full, 'utf8'), before);
  assert.equal(fs.statSync(item.full).mtimeMs, mtime);
  assert.equal(readItem(project, 1).record.state, 'open');
});
