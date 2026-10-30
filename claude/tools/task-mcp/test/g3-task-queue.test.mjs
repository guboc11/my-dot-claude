import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  PROJECT_SERVER,
  callTool,
  callToolAsync,
  callToolError,
  legacyTaskGroupDir,
  listTools,
  makeProject,
  mcpTaskGroupDir,
  removeProject,
} from './helpers.mjs';

// 명단의 surface 는 UUID 가 정본이라 시험 패널도 UUID 를 쓴다(SPEC 3-1).
const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
// 둘째 워커입니다. 남에게 배정된 태스크가 선행으로 막는 모습을 만들 때 씁니다.
const OTHER_WORKER = '44444444-4444-4444-8444-444444444444';

const projects = [];
// 이 파일의 task_update 는 completed 를 적으므로 보고가 나갑니다. 가짜 어댑터를 켜지 않으면
// 실제 cmux send 로 나가 다른 패널에 시험 보고를 보낼 수 있습니다(노트 1 의 검증 격리 계약).
// 원래 값은 담아 두었다가 되돌립니다.
let savedFakeCmux;

before(() => {
  savedFakeCmux = process.env.TASK_MCP_FAKE_CMUX;
  process.env.TASK_MCP_FAKE_CMUX = '1';
});

after(() => {
  for (const project of projects) removeProject(project);
  if (savedFakeCmux === undefined) delete process.env.TASK_MCP_FAKE_CMUX;
  else process.env.TASK_MCP_FAKE_CMUX = savedFakeCmux;
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addGroup(project, topic, worker = WORKER) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic,
    members: [
      { name: 'MNGR3', surface: MANAGER, roles: ['manager'] },
      { name: 'WRKR3', surface: worker, roles: ['worker'] },
      { name: 'WRKR4', surface: OTHER_WORKER, roles: ['worker'] },
    ],
  }, MANAGER);
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function groupDir(project, groupId) {
  return mcpTaskGroupDir(project, groupId);
}

function readGroup(project, groupId) {
  return JSON.parse(fs.readFileSync(path.join(groupDir(project, groupId), 'TASK_GROUP.json'), 'utf8'));
}

function taskFile(project, groupId, number) {
  return fs.readdirSync(groupDir(project, groupId))
    .find((file) => new RegExp(`^task-${number}-.+\\.json$`).test(file));
}

function readTask(project, groupId, number) {
  const file = taskFile(project, groupId, number);
  return { file, record: JSON.parse(fs.readFileSync(path.join(groupDir(project, groupId), file), 'utf8')) };
}

// 바로 집을 수 있는 work 를 만든다 — spec 과 assignee 가 차 있어야 pending 이다.
function addWork(project, groupId, content, extra = {}) {
  return callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content,
    batch: 'b1',
    spec: `${content} 받아들임 조건`,
    assignee: WORKER,
    ...extra,
  }, MANAGER);
}

test('G3: owner와 assignee를 나누고 목록은 group_id를 줘도 assignee를 기준으로 거른다', () => {
  const project = fixture('task-mcp-g3-assignee-');
  const groupId = addGroup(project, '담당자 기본값');
  assert.equal(readGroup(project, groupId).status, 'pending');

  addWork(project, groupId, '매니저가 넣은 워커 태스크');
  const task = readTask(project, groupId, 1).record;
  assert.equal(task.owner, MANAGER);
  assert.equal(task.assignee, WORKER);
  assert.equal(task.batch, 'b1');
  assert.equal(task.kind, 'work');
  assert.equal(task.status, 'pending');
  assert.equal(task.instruction, '');
  assert.deepEqual(task.depends_on, []);
  assert.equal(task.priority, 0);
  assert.match(taskFile(project, groupId, 1), /^task-1-b1-work-pending-/);

  assert.match(callTool(PROJECT_SERVER, project, 'task_list', {}, WORKER), /매니저가 넣은 워커 태스크/);
  assert.doesNotMatch(callTool(PROJECT_SERVER, project, 'task_list', {}, MANAGER), /매니저가 넣은 워커 태스크/);
  // group_id 를 줘도 mine 필터가 걸린다(note-3 §5 결함 2).
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId }, WORKER), /매니저가 넣은 워커 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId }, 'surface:other'), /내 태스크 없음/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId, all: true }, 'surface:other'), /매니저가 넣은 워커 태스크/);
  console.log('new_group_default_status=pending');
  console.log('owner_assignee_separated=true');
  console.log('list_filters_with_group_id=true');
});

test('G3: spec이나 assignee가 비면 draft로 만들고 까닭을 답에 붙인다', () => {
  const project = fixture('task-mcp-g3-draft-');
  const groupId = addGroup(project, 'draft 규칙');

  const noSpec = callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'spec 없는 일', batch: 'b1', assignee: WORKER,
  }, MANAGER);
  assert.match(noSpec, /spec 이 비어 draft 로 만들었습니다\./);
  assert.equal(readTask(project, groupId, 1).record.status, 'draft');

  const noAssignee = callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'assignee 없는 일', batch: 'b1', spec: '받아들임 조건',
  }, MANAGER);
  assert.match(noAssignee, /assignee 가 없어 draft 로 만들었습니다\. members 의 worker: WRKR3\(/);
  assert.equal(readTask(project, groupId, 2).record.status, 'draft');

  // test 는 테스터 풀이라 assignee 가 비어도 pending 이다.
  const testTask = callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 검증', batch: 'b1', kind: 'test', spec: '검사 항목',
  }, MANAGER);
  assert.doesNotMatch(testTask, /draft 로 만들었습니다/);
  assert.equal(readTask(project, groupId, 3).record.status, 'pending');
  console.log('draft_when_spec_empty=true');
  console.log('draft_when_work_assignee_empty=true');
});

test('G3: 새 그룹은 첫 task_next에서 pending에서 in_progress로 바뀐다', () => {
  const project = fixture('task-mcp-g3-group-status-');
  const groupId = addGroup(project, '그룹 상태 전이');
  assert.equal(readGroup(project, groupId).status, 'pending');
  addWork(project, groupId, '첫 태스크');
  assert.equal(readGroup(project, groupId).status, 'pending');
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.equal(readGroup(project, groupId).status, 'in_progress');
  console.log('named_group_status_transition=pending,pending,in_progress');
});

test('G3: 옛 태스크의 새 칸은 읽을 때만 기본값을 채운다', () => {
  const project = fixture('task-mcp-g3-legacy-read-');
  const groupId = '2026-07-01-old-task';
  const dir = legacyTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'task-1-pending-[legacy]-옛-태스크.json');
  const record = {
    number: 1,
    content: '옛 태스크',
    tag: 'legacy',
    description: '옛 설명',
    activeForm: '옛 태스크 진행 중',
    status: 'pending',
    owner: 'surface:legacy-owner',
    group_id: groupId,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const before = fs.readFileSync(file, 'utf8');
  const output = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 });
  assert.match(output, /assignee: surface:legacy-owner/);
  assert.match(output, /priority: 0/);
  assert.match(output, /depends_on: \(없음\)/);
  assert.match(output, /배치: \(없음\)/);
  assert.match(output, /#1 \[ \] work \(pending\)/);
  assert.match(output, /지시:\n\(없음\)/);
  assert.match(output, /스펙:\n\(없음\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  console.log('legacy_read_rewrites=0');
  console.log('legacy_read_kind=work');
});

test('G3: 표 밖 상태인 옛 태스크는 읽히되 바꿀 수 없다', () => {
  const project = fixture('task-mcp-g3-cancelled-');
  const groupId = '2026-07-31-cancelled';
  const dir = legacyTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  // 명단에 없는 패널은 쓰기 전에 거절되므로(백로그 9) 이 검사가 상태 규칙까지 닿도록 명단을 둡니다.
  fs.writeFileSync(path.join(dir, 'TASK_GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: groupId,
    about: '',
    status: 'pending',
    campaign: null,
    members: [{ name: 'MNGR3', surface: MANAGER, ref: null, roles: ['manager'], scope: '', session: null }],
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'task-1-cancelled-[setup]-터-닦기.json'), `${JSON.stringify({
    number: 1, content: '터 닦기', tag: 'setup', description: '', activeForm: '터 닦기',
    status: 'cancelled', owner: 'surface:legacy', group_id: groupId,
    created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
  }, null, 2)}\n`);

  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }), /\(cancelled\)/);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, tag: '새 태그' }, MANAGER),
    /상태가 cancelled 인 옛 태스크는 바꿀 수 없습니다/,
  );
  console.log('out_of_table_status_readable=true');
  console.log('out_of_table_status_immutable=true');
});

test('G3: task_next는 선행 조건 뒤 우선순위와 번호 순으로 고르고 진행 중 태스크를 유지한다', () => {
  const project = fixture('task-mcp-g3-order-');
  const groupId = addGroup(project, '큐 순서');
  const add = (content, priority, depends_on = []) => addWork(project, groupId, content, {
    description: `${content} 설명`,
    instruction: `${content} 지시`,
    priority,
    depends_on,
  });
  add('낮은 우선순위', 2);
  add('높은 우선순위 앞번호', 9);
  add('높은 우선순위 뒷번호', 9);
  add('선행 뒤 최고 우선순위', 99, [1]);

  const first = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.match(first, /#2 \[~\] work \(in_progress\)/);
  assert.match(first, /높은 우선순위 앞번호 설명/);
  assert.match(first, /높은 우선순위 앞번호 지시/);
  assert.equal(readGroup(project, groupId).status, 'in_progress');
  const selected = readTask(project, groupId, 2);
  assert.match(selected.file, /^task-2-b1-work-in_progress-/);
  assert.equal(selected.record.status, 'in_progress');

  const repeated = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.match(repeated, /#2 \[~\] work \(in_progress\)/);
  const complete = (number) => callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number, status: 'completed',
  }, WORKER);
  complete(2);

  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER), /#3 \[~\] work \(in_progress\)/);
  complete(3);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER), /#1 \[~\] work \(in_progress\)/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER), /#1 \[~\] work \(in_progress\)/);
  complete(1);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER), /#4 \[~\] work \(in_progress\)/);
  console.log('selection_order=2,3,1,4');
  console.log('repeat_returns_same=true');
  console.log('group_status_transition=pending->in_progress');
});

test('G3: 후보가 없을 때 세 경우를 서로 다른 문구로 답한다', () => {
  const project = fixture('task-mcp-g3-messages-');
  const groupId = addGroup(project, '큐 메시지');
  // 선행은 실제로 있는 번호여야 합니다(백로그 11). 남의 몫인 #1 이 내 #2 를 막는 모습을 만듭니다.
  addWork(project, groupId, '남이 맡은 선행', { assignee: OTHER_WORKER });
  addWork(project, groupId, '선행을 기다림', { depends_on: [1] });

  const blocked = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.match(blocked, /모두 막혀/);
  assert.match(blocked, /#2 → #1/);

  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, OTHER_WORKER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, OTHER_WORKER);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, status: 'completed' }, WORKER);
  const completed = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.match(completed, /모든 태스크가 완료/);
  assert.notEqual(blocked, completed);

  // 보고는 가짜 어댑터로만 갔습니다 — 실제 cmux 를 부르지 않았다는 근거입니다.
  const fakeLog = path.join(project, '.task-mcp-fake-cmux.jsonl');
  assert.equal(fs.existsSync(fakeLog), true, '보고가 가짜 기록에 남아야 실제 cmux 를 안 부른 것입니다.');
  const sends = fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.op === 'send');
  assert.equal(sends.length, 2);

  // 내 역할이 맡지 않는 종류만 남으면 다른 문구가 나온다.
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 검증', batch: 'b1', kind: 'test', spec: '검사 항목',
  }, MANAGER);
  const otherRole = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  assert.match(otherRole, /내 역할\(워커\)이 맡는 태스크가 없습니다/);
  assert.match(otherRole, /test 1개/);
  console.log('blocked_message_has_waiting_numbers=true');
  console.log('completed_message_distinct=true');
  console.log('other_role_message_distinct=true');
});

test('G3: task_update는 값 칸을 바꾸고 긴 글 칸은 field와 mode로만 고친다', () => {
  const project = fixture('task-mcp-g3-update-');
  const groupId = addGroup(project, '태스크 칸 수정');
  addWork(project, groupId, '칸 수정 대상', { activeForm: '처음 진행형' });
  // depends_on 은 있는 번호만 받으므로(백로그 11) 선행이 될 태스크를 먼저 만듭니다.
  addWork(project, groupId, '선행이 될 태스크');

  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId,
    number: 1,
    activeForm: '바뀐 진행형',
    depends_on: [2],
    priority: 7,
    assignee: OTHER_WORKER,
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'description', mode: 'replace', text: '바뀐 설명',
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'instruction', mode: 'append', text: '바뀐 지시',
  }, MANAGER);

  const task = readTask(project, groupId, 1).record;
  assert.equal(task.activeForm, '바뀐 진행형');
  assert.equal(task.description, '바뀐 설명');
  assert.equal(task.instruction, '바뀐 지시');
  assert.deepEqual(task.depends_on, [2]);
  assert.equal(task.priority, 7);
  assert.equal(task.assignee, OTHER_WORKER);

  const output = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 });
  for (const value of ['바뀐 설명', '바뀐 진행형', '바뀐 지시', 'depends_on: #2', 'priority: 7', `assignee: ${OTHER_WORKER}`]) {
    assert.match(output, new RegExp(value));
  }
  // 긴 칸은 줄 번호가 붙어 insert_after 에 그대로 쓸 수 있다.
  assert.match(output, /설명:\n {3}1│ 바뀐 설명/);

  // 옛 인자로 긴 칸을 통째로 주는 길은 없어졌다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, description: '통째로' }, MANAGER),
    /description · instruction · spec · memo · result 는 field 와 mode 로 고칩니다/,
  );
  console.log('task_fields_update_get=true');
  console.log('long_field_requires_mode=true');
});

test('G3: 두 프로세스가 함께 task_next를 불러도 같은 태스크를 받고 잠금 파일을 남기지 않는다', async () => {
  const project = fixture('task-mcp-g3-race-');
  const groupId = addGroup(project, '동시 큐');
  addWork(project, groupId, '동시에 집을 태스크', { instruction: '한 번만 진행 상태로 바꾼다' });
  const outputs = await Promise.all([
    callToolAsync(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER),
    callToolAsync(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER),
  ]);
  for (const output of outputs) assert.match(output, /#1 \[~\] work \(in_progress\)/);
  const files = fs.readdirSync(groupDir(project, groupId));
  assert.equal(files.filter((file) => /^task-1-b1-work-in_progress-.+\.json$/.test(file)).length, 1);
  assert.deepEqual(files.filter((file) => /lock|\.tmp$/i.test(file)), []);
  assert.equal(readTask(project, groupId, 1).record.status, 'in_progress');
  console.log('concurrent_call_results=#1,#1');
  console.log('lock_files=0');
});

test('G3: task_next를 포함한 그룹·태스크 큐 도구 9개가 계속 노출된다', () => {
  const project = fixture('task-mcp-g3-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  const expected = [
    'task_group_add', 'task_group_update', 'task_group_get', 'task_group_list',
    'task_add', 'task_update', 'task_get', 'task_list', 'task_next',
  ];
  assert.deepEqual(tools.filter((name) => expected.includes(name)), expected);
  console.log(`g3_contract_tool_count=${expected.length}`);
  console.log(`visible_tool_count=${tools.length}`);
});
