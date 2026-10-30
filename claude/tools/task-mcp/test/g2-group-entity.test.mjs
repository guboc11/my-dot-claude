import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { receivablePending, taskFileName } from '../model.mjs';

import {
  campaignGroupIds,
  groupPath,
  listGroupIds,
  today,
} from '../lib.mjs';
import {
  PROJECT_SERVER,
  REPO,
  callTool,
  callToolError,
  legacyTaskGroupDir,
  legacyTaskRoot,
  listTools,
  makeProject,
  mcpTaskGroupDir,
  mcpTaskRoot,
  removeProject,
} from './helpers.mjs';

// model.mjs 의 가짜 cmux tree 가 내주는 세 패널. surface:N 을 UUID 로 바꾸는 길을 시험한다.
const FAKE_MANAGER = '11111111-1111-4111-8111-111111111111';
const FAKE_WORKER = '22222222-2222-4222-8222-222222222222';
const FAKE_TESTER = '33333333-3333-4333-8333-333333333333';

const projects = [];
let fakeCmuxBefore;

before(() => {
  fakeCmuxBefore = process.env.TASK_MCP_FAKE_CMUX;
  process.env.TASK_MCP_FAKE_CMUX = '1';
});

after(() => {
  for (const project of projects) removeProject(project);
  if (fakeCmuxBefore === undefined) delete process.env.TASK_MCP_FAKE_CMUX;
  else process.env.TASK_MCP_FAKE_CMUX = fakeCmuxBefore;
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addCampaign(project, name = 'g2-campaign') {
  const output = callTool(PROJECT_SERVER, project, 'campaign_add', { name, about: 'G2' });
  const id = /캠페인 생성: ([^\n]+)/.exec(output)?.[1];
  assert.ok(id, 'campaign_add가 생성한 캠페인 이름을 돌려줘야 합니다.');
  return id;
}

function withProject(project, fn) {
  const original = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = project;
  try { return fn(); } finally {
    if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = original;
  }
}

function groupBase(project, groupId, campaign = null) {
  return campaign
    ? path.join(project, '.claude', 'mcp-task-campaign', campaign, groupId)
    : mcpTaskGroupDir(project, groupId);
}

function groupRecord(project, groupId, campaign = null) {
  return JSON.parse(fs.readFileSync(path.join(groupBase(project, groupId, campaign), 'TASK_GROUP.json'), 'utf8'));
}

function writeLegacyTask(dir, groupId) {
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    number: 1,
    content: '옛 태스크',
    tag: 'legacy',
    description: '',
    activeForm: '옛 태스크',
    status: 'pending',
    owner: 'surface:legacy',
    group_id: groupId,
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'task-1-pending-[legacy]-옛-태스크.json'), `${JSON.stringify(record, null, 2)}\n`);
}

// 옛 이름(GROUP.json)과 옛 두 칸(worker · manager)을 가진 레코드를 그대로 심는다.
function writeLegacyRecord(dir, groupId, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: '옛 이름 그룹',
    about: '옛 레코드',
    status: 'pending',
    campaign: null,
    worker: { name: 'WRKR3', surface: FAKE_WORKER },
    manager: { name: 'MNGR3', surface: 'surface:87' },
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
    ...extra,
  }, null, 2)}\n`);
}

function countGroupRecords(root) {
  let count = 0;
  const visited = new Set();
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === 'GROUP.json' || entry.name === 'TASK_GROUP.json') count += 1;
    }
  }
  visit(mcpTaskRoot(root));
  visit(legacyTaskRoot(root));
  visit(path.join(root, '.claude', 'campaigns'));
  visit(path.join(root, '.claude', 'mcp-task-campaign'));
  return count;
}

function dashboardFixture(entries) {
  const project = fixture('task-mcp-g2-next-dashboard-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '다음 표시', members: [
      { name: 'MNGR', surface: FAKE_MANAGER, roles: ['manager'] },
      { name: 'WRKR', surface: FAKE_WORKER, roles: ['worker'] },
      { name: 'TESTER', surface: FAKE_TESTER, roles: ['tester', 'worker'] },
    ],
  }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)[1];
  const tasks = entries.map((entry, index) => ({
    number: index + 1, content: `일 ${index + 1}`, tag: '', batch: 'b1', kind: 'work', status: 'pending',
    spec: '기준', owner: FAKE_MANAGER, assignee: FAKE_WORKER, depends_on: [], priority: 0,
    group_id: groupId, created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z', ...entry,
  }));
  for (const task of tasks) {
    const file = taskFileName(task.number, task.batch, task.kind, task.status, task.content, task.tag);
    fs.writeFileSync(path.join(mcpTaskGroupDir(project, groupId), file), `${JSON.stringify(task, null, 2)}\n`);
  }
  return { project, groupId, tasks };
}

function assertDashboard(project, groupId, expected) {
  assert.equal(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }, FAKE_MANAGER).split('\n')[2], expected);
  assert.equal(callTool(PROJECT_SERVER, project, 'task_group_list', { all: true }, FAKE_WORKER).split('\n')[2], expected);
  console.log(expected);
}

test('G2: draft만 있으면 다음은 없고 draft 개수를 표시합니다', () => {
  const { project, groupId } = dashboardFixture([{ status: 'draft' }]);
  assertDashboard(project, groupId, '  태스크 0/1 완료 · 진행 중 0개 · 다음 → 없음 · draft 1개');
});

test('G2: 모든 pending의 선행이 미완료면 선행 대기 개수를 표시합니다', () => {
  const { project, groupId } = dashboardFixture([
    { status: 'completed' }, { status: 'completed' }, { depends_on: [4] }, { depends_on: [3] },
  ]);
  assertDashboard(project, groupId, '  태스크 2/4 완료 · 진행 중 0개 · 다음 → 없음 (선행 대기 2개) · draft 0개');
});

test('G2: 다음은 호출자의 역할·배정과 무관하게 높은 우선순위부터 표시합니다', () => {
  const { project, groupId } = dashboardFixture([
    { priority: 1 }, { priority: 9, kind: 'test', tag: 'gate', assignee: FAKE_TESTER },
  ]);
  assertDashboard(project, groupId, '  태스크 0/2 완료 · 진행 중 0개 · 다음 → #2 [gate] 일 2 · draft 0개');
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, FAKE_WORKER), /#1 \[~\] work/);
});

test('G2: 남의 in_progress는 다음에 섞이지 않고 별도로 셉니다', () => {
  const { project, groupId } = dashboardFixture([
    { status: 'in_progress', assignee: FAKE_TESTER, priority: 99 }, {},
  ]);
  assertDashboard(project, groupId, '  태스크 0/2 완료 · 진행 중 1개 · 다음 → #2 일 2 · draft 0개');
});

test('G2: 같은 역할·배정이면 task_next도 대시보드와 같은 번호를 고릅니다', () => {
  const { project, groupId } = dashboardFixture([
    { status: 'completed' }, { priority: 1 }, { priority: 9, depends_on: [1] }, { priority: 9 },
  ]);
  assertDashboard(project, groupId, '  태스크 1/4 완료 · 진행 중 0개 · 다음 → #3 일 3 · draft 0개');
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, FAKE_WORKER), /#3 \[~\] work/);
});

test('G2: 명세의 혼합 상태 예시와 비어 있는 그룹도 네 수를 모두 표시합니다', () => {
  const { project, groupId } = dashboardFixture([
    ...Array.from({ length: 4 }, () => ({ status: 'completed' })),
    { tag: 'backend', content: 'TASK_GROUP.json 읽고 쓰기' }, { status: 'in_progress' },
    { status: 'draft' }, { status: 'draft' }, {}, {}, {}, {},
  ]);
  assertDashboard(project, groupId, '  태스크 4/12 완료 · 진행 중 1개 · 다음 → #5 [backend] TASK_GROUP.json 읽고 쓰기 · draft 2개');
  const empty = dashboardFixture([]);
  assertDashboard(empty.project, empty.groupId, '  태스크 0/0 완료 · 진행 중 0개 · 다음 → 없음 · draft 0개');
});

test('G2: 공유 후보 함수는 입력 순서를 바꾸지 않고 우선순위·번호로 정렬합니다', () => {
  const tasks = [
    { number: 4, status: 'pending', priority: 2, depends_on: [1] },
    { number: 3, status: 'pending', priority: 2, depends_on: [] },
    { number: 2, status: 'pending', priority: 99, depends_on: [9] },
    { number: 1, status: 'completed', priority: 0, depends_on: [] },
    { number: 5, status: 'draft', priority: 99, depends_on: [] },
    { number: 6, status: 'in_progress', priority: 99, depends_on: [] },
  ];
  const before = structuredClone(tasks);
  assert.deepEqual(receivablePending(tasks).map((task) => task.number), [3, 4]);
  assert.deepEqual(tasks, before);
});

test('G2: 새 그룹에 TASK_GROUP.json과 호출 패널이 매니저로 기록된다', () => {
  const project = fixture('task-mcp-g2-group-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '2026-08-02-2026-08-01-그룹',
    about: 'G2 그룹 설명',
  }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.equal(groupId, `${today()}-그룹`);
  assert.match(output.split('\n')[0], /2026-08-02, 2026-08-01 를 뗐습니다/);

  const dir = mcpTaskGroupDir(project, groupId);
  assert.equal(fs.existsSync(path.join(dir, 'TASK_GROUP.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), false);

  const record = groupRecord(project, groupId);
  assert.equal(record.id, groupId);
  assert.equal(record.title, '그룹');
  assert.equal(record.about, 'G2 그룹 설명');
  assert.equal(record.status, 'pending');
  assert.equal(record.campaign, null);
  assert.equal(record.worker, undefined);
  assert.equal(record.manager, undefined);
  assert.deepEqual(record.members, [{
    name: FAKE_MANAGER.slice(0, 8), surface: FAKE_MANAGER, ref: null, roles: ['manager'], scope: '', session: null,
  }]);
  assert.equal(record.created_at, record.updated_at);

  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(list, new RegExp(`매니저 ${FAKE_MANAGER.slice(0, 8)} · 워커 \\(없음\\) · 테스터 \\(없음\\) · 리뷰어 \\(없음\\)`));
  console.log(`group_id=${groupId}`);
  console.log('record_file=TASK_GROUP.json');
  console.log('default_member_role=manager');
});

test('G2: members의 surface:N은 UUID로 바뀌고 넘긴 번호는 ref에 남는다', () => {
  const project = fixture('task-mcp-g2-members-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '명단 등록',
    members: [
      { name: 'MNGR3', surface: 'surface:1', roles: ['manager', 'reviewer'] },
      { name: 'WRKR301', surface: FAKE_WORKER, roles: ['worker'], scope: 'task.mjs · group.mjs' },
      { name: 'TESTER3', surface: 'surface:3', roles: ['tester'] },
    ],
  }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  const record = groupRecord(project, groupId);

  assert.deepEqual(record.members.map((m) => [m.name, m.surface, m.ref]), [
    ['MNGR3', FAKE_MANAGER, 'surface:1'],
    ['WRKR301', FAKE_WORKER, null],
    ['TESTER3', FAKE_TESTER, 'surface:3'],
  ]);
  assert.equal(record.members[1].scope, 'task.mjs · group.mjs');
  assert.match(output, /매니저 MNGR3 · 워커 WRKR301 · 테스터 TESTER3 · 리뷰어 MNGR3/);

  // cmux 에 없는 번호는 저장하지 않고 거절한다.
  const rejected = callToolError(PROJECT_SERVER, project, 'task_group_add', {
    topic: '없는 패널',
    members: [{ name: 'GHOST', surface: 'surface:99', roles: ['worker'] }],
  }, FAKE_MANAGER);
  assert.match(rejected, /surface:99 패널을 cmux 에서 찾지 못했습니다/);
  assert.equal(fs.existsSync(mcpTaskGroupDir(project, `${today()}-없는-패널`)), false);
  console.log('surface_ref_to_uuid=2');
  console.log('unknown_surface_rejected=true');
});

test('G2: 매니저가 둘이면 add와 update가 거절한다', () => {
  const project = fixture('task-mcp-g2-two-managers-');
  const twoManagers = [
    { name: 'MNGR3', surface: FAKE_MANAGER, roles: ['manager'] },
    { name: 'MNGR4', surface: FAKE_WORKER, roles: ['manager'] },
  ];
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_group_add', { topic: '매니저 둘', members: twoManagers }, FAKE_MANAGER),
    /매니저는 그룹당 한 명입니다\. 받은 매니저 2명: MNGR3, MNGR4/,
  );

  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '매니저 하나',
    members: [{ name: 'MNGR3', surface: FAKE_MANAGER, roles: ['manager'] }],
  }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_group_update', {
      group_id: groupId,
      members: [{ name: 'MNGR4', surface: FAKE_WORKER, roles: ['manager'] }],
    }, FAKE_MANAGER),
    /매니저는 그룹당 한 명입니다/,
  );
  assert.equal(groupRecord(project, groupId).members.length, 1);

  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_group_update', {
      group_id: groupId,
      members: [{ name: 'X', surface: FAKE_WORKER, roles: ['watcher'] }],
    }, FAKE_MANAGER),
    /roles 는 manager \| worker \| tester \| reviewer 중 하나여야 합니다/,
  );
  console.log('two_manager_rejected=add,update');
});

test('G2: members 갱신은 이름으로 맞추고 remove:true는 명단에서 뺀다', () => {
  const project = fixture('task-mcp-g2-member-merge-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '명단 갱신',
    members: [
      { name: 'MNGR3', surface: FAKE_MANAGER, roles: ['manager'] },
      { name: 'WRKR301', surface: FAKE_WORKER, roles: ['worker'], scope: '옛 경계' },
    ],
  }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];

  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId,
    members: [
      { name: 'WRKR301', surface: 'surface:2', roles: ['worker'], scope: '새 경계' },
      { name: 'TESTER3', surface: 'surface:3', roles: ['tester'] },
    ],
  }, FAKE_MANAGER);
  let record = groupRecord(project, groupId);
  assert.deepEqual(record.members.map((m) => m.name), ['MNGR3', 'WRKR301', 'TESTER3']);
  assert.equal(record.members[1].scope, '새 경계');
  assert.equal(record.members[1].ref, 'surface:2');

  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId,
    members: [{ name: 'TESTER3', remove: true }],
  }, FAKE_MANAGER);
  record = groupRecord(project, groupId);
  assert.deepEqual(record.members.map((m) => m.name), ['MNGR3', 'WRKR301']);
  console.log('member_merge_by_name=true');
  console.log('member_remove=1');
});

test('G2: 옛 이름 레코드를 읽고 쓰기가 닿으면 TASK_GROUP.json으로 옮긴다', () => {
  const project = fixture('task-mcp-g2-record-rename-');
  const groupId = '2026-08-16-옛-이름';
  const dir = mcpTaskGroupDir(project, groupId);
  writeLegacyRecord(dir, groupId);
  writeLegacyTask(dir, groupId);

  // 읽기만 할 때는 파일을 옮기지 않는다.
  const view = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }, FAKE_MANAGER);
  assert.match(view, /옛 이름 그룹/);
  assert.match(view, /매니저 MNGR3 · 워커 WRKR3 · 테스터 \(없음\) · 리뷰어 \(없음\)/);
  assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'TASK_GROUP.json')), false);

  // 쓰기가 닿으면 새 이름으로 옮기고 옛 이름을 지운다.
  callTool(PROJECT_SERVER, project, 'task_group_update', { group_id: groupId, about: '새 설명' }, FAKE_MANAGER);
  assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), false);
  const record = groupRecord(project, groupId);
  assert.equal(record.about, '새 설명');
  assert.equal(record.worker, undefined);
  assert.equal(record.manager, undefined);
  // 옛 두 칸이 members 로 바뀐다. surface:N 이던 매니저는 ref 로 옮겨 가 정체 판별에서 빠진다.
  assert.deepEqual(record.members, [
    { name: 'MNGR3', surface: '', ref: 'surface:87', roles: ['manager'], scope: '', session: null },
    { name: 'WRKR3', surface: FAKE_WORKER, ref: null, roles: ['worker'], scope: '', session: null },
  ]);
  console.log('legacy_record_read_writes=0');
  console.log('legacy_record_renamed_on_write=true');
});

test('G2: 그룹 수정은 칸을 갱신하고 옛 자리 그룹은 update에서만 승격한다', () => {
  const project = fixture('task-mcp-g2-upgrade-');
  const legacyId = '2026-07-01-legacy-group';
  const legacyDir = legacyTaskGroupDir(project, legacyId);
  writeLegacyTask(legacyDir, legacyId);
  const legacyTask = path.join(legacyDir, 'task-1-pending-[legacy]-옛-태스크.json');
  const legacyBefore = fs.readFileSync(legacyTask, 'utf8');
  const promotedRecordFile = path.join(mcpTaskGroupDir(project, legacyId), 'TASK_GROUP.json');

  const getOutput = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: legacyId });
  const listOutput = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(getOutput, /옛 그룹/);
  assert.match(listOutput, /옛 그룹/);
  assert.match(getOutput, /매니저 \(없음\) · 워커 \(없음\)/);
  assert.equal(fs.existsSync(path.join(legacyDir, 'GROUP.json')), false);
  assert.equal(fs.existsSync(path.join(legacyDir, 'TASK_GROUP.json')), false);
  assert.equal(fs.existsSync(mcpTaskRoot(project)), false);

  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: legacyId,
    title: '승격된 옛 그룹',
    about: '명시적으로 승격',
    status: 'in_progress',
    members: [
      { name: 'WRKR3', surface: 'surface:2', roles: ['worker'] },
      { name: 'MNGR3', surface: 'surface:1', roles: ['manager'] },
    ],
  }, FAKE_MANAGER);
  assert.equal(fs.existsSync(path.join(legacyDir, 'GROUP.json')), false);
  assert.equal(fs.existsSync(path.join(legacyDir, 'TASK_GROUP.json')), false);
  assert.equal(fs.readFileSync(legacyTask, 'utf8'), legacyBefore);
  assert.equal(fs.existsSync(promotedRecordFile), true);
  const record = JSON.parse(fs.readFileSync(promotedRecordFile, 'utf8'));
  assert.equal(record.title, '승격된 옛 그룹');
  assert.equal(record.about, '명시적으로 승격');
  assert.equal(record.status, 'in_progress');
  assert.deepEqual(record.members.map((m) => [m.name, m.surface, m.roles]), [
    ['WRKR3', FAKE_WORKER, ['worker']],
    ['MNGR3', FAKE_MANAGER, ['manager']],
  ]);
  console.log('legacy_read_writes=0');
  console.log('legacy_upgrade_writes=1');
});

test('G2: 캠페인 자료 폴더는 제외하고 예전 예약 이름으로 그룹을 만들 수 있습니다', () => {
  const project = fixture('task-mcp-g2-reserved-');
  const campaign = addCampaign(project);
  const campaignDir = path.join(project, '.claude', 'mcp-task-campaign', campaign);
  const materials = ['campaign-context', 'main-context', 'researches', '자료'];
  for (const material of materials) fs.mkdirSync(path.join(campaignDir, material), { recursive: true });

  const fresh = callTool(PROJECT_SERVER, project, 'task_group_list', { campaign, all: true });
  assert.match(fresh, /태스크 그룹 없음/);
  withProject(project, () => {
    assert.deepEqual(campaignGroupIds(campaign), []);
    assert.deepEqual(listGroupIds(), []);
    for (const material of materials) {
      assert.equal(groupPath(material).campaign, null);
      assert.equal(groupPath(material).dir, mcpTaskGroupDir(project, material));
    }
  });

  for (const material of materials) {
    const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: material, campaign }, FAKE_MANAGER);
    const id = /group_id="([^"]+)"/.exec(output)[1];
    assert.equal(id, `task-group-${today()}-${material}`);
    withProject(project, () => {
      assert.equal(groupPath(id).campaign, campaign);
      assert.equal(groupPath(id.replace(/^task-group-/, '')).safe, id);
    });
  }
  console.log('fresh_campaign_groups=0');
  console.log(`material_folders_filtered=${materials.length}`);
});

test('G2: 캠페인 소속·중복 위치·없는 캠페인·없는 그룹 오류를 지킨다', () => {
  const project = fixture('task-mcp-g2-errors-');
  const campaign = addCampaign(project);
  const campaignOutput = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '캠페인 그룹',
    campaign,
    members: [{ name: 'WRKR3', surface: 'surface:2', roles: ['worker'] }],
  }, FAKE_MANAGER);
  const campaignGroupId = /group_id="([^"]+)"/.exec(campaignOutput)?.[1];
  const campaignRecord = groupRecord(project, campaignGroupId, campaign);
  assert.equal(campaignRecord.campaign, campaign);
  assert.deepEqual(campaignRecord.members.map((m) => m.name), ['WRKR3']);

  callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '중복 그룹' }, FAKE_MANAGER);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_add', {
    topic: '중복 그룹',
    campaign,
  }, FAKE_MANAGER), /이미 있는 그룹/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_add', {
    topic: '없는 캠페인 그룹',
    campaign: 'missing-campaign',
  }, FAKE_MANAGER), /캠페인 .* 없음/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: 'missing-group',
    content: '생기면 안 되는 태스크',
    batch: 'b1',
  }, FAKE_MANAGER), /task_group_add/);
  assert.equal(fs.existsSync(mcpTaskGroupDir(project, 'missing-group')), false);
  assert.equal(fs.existsSync(legacyTaskGroupDir(project, 'missing-group')), false);
  console.log('missing_group_files=0');
});

test('G2: 태스크와 그룹 레코드가 없는 폴더는 그룹 목록에서 제외된다', () => {
  const project = fixture('task-mcp-g2-empty-directory-');
  const emptyId = 'empty-material';
  const materialId = 'assets-source';
  fs.mkdirSync(mcpTaskGroupDir(project, emptyId), { recursive: true });
  fs.mkdirSync(mcpTaskGroupDir(project, materialId), { recursive: true });
  fs.writeFileSync(path.join(mcpTaskGroupDir(project, materialId), 'artifact.txt'), '자료 파일\n');

  withProject(project, () => {
    assert.equal(listGroupIds().includes(emptyId), true);
    assert.equal(listGroupIds().includes(materialId), true);
  });
  for (const all of [false, true]) {
    const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all });
    assert.doesNotMatch(list, new RegExp(`\\[${emptyId}\\]`));
    assert.doesNotMatch(list, new RegExp(`\\[${materialId}\\]`));
  }
  console.log('empty_directory_candidates=2');
  console.log('empty_directory_dashboard_rows=0');
  console.log('listGroupIds_boundary_unchanged=true');
});

test('G2: task_group_add로 만든 태스크 0개 빈 그룹은 목록에 남는다', () => {
  const project = fixture('task-mcp-g2-empty-recorded-group-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '빈 명시 그룹' }, FAKE_MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.ok(groupId);
  const files = fs.readdirSync(mcpTaskGroupDir(project, groupId));
  assert.deepEqual(files, ['TASK_GROUP.json']);

  for (const all of [false, true]) {
    const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all });
    assert.match(list, new RegExp(`\\[${groupId}\\]`));
    assert.match(list, /태스크 0\/0 완료/);
  }
  console.log('recorded_empty_group_task_files=0');
  console.log('recorded_empty_group_visible=true');
});

test('G2: 기존 그룹의 task_add는 activeForm을 유지하고 옛 그룹 50개가 모두 보인다', () => {
  const project = fixture('task-mcp-g2-legacy-list-');
  for (let number = 1; number <= 50; number += 1) {
    const id = `legacy-${String(number).padStart(2, '0')}`;
    const dir = legacyTaskGroupDir(project, id);
    if (number === 1) fs.mkdirSync(dir, { recursive: true });
    else writeLegacyTask(dir, id);
  }
  const target = 'legacy-01';
  // 옛 그룹에도 명단 검사가 걸립니다(백로그 9). 이 검사가 보려는 것은 새 자리 쓰기와 activeForm 유지이므로
  // 명단을 새 자리 레코드에 둡니다. 옛 폴더는 그대로 비워 두어 옛 tree 가 안 바뀌는 것을 그대로 봅니다.
  fs.mkdirSync(mcpTaskGroupDir(project, target), { recursive: true });
  fs.writeFileSync(path.join(mcpTaskGroupDir(project, target), 'TASK_GROUP.json'), `${JSON.stringify({
    id: target,
    title: target,
    about: '',
    status: 'pending',
    campaign: null,
    members: [{ name: 'WRKR-LEGACY', surface: FAKE_WORKER, ref: null, roles: ['worker'], scope: '', session: null }],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: target,
    content: '옛 그룹에 추가',
    batch: 'b1',
    spec: '받아들임 조건',
    assignee: FAKE_WORKER,
    activeForm: 'activeForm 유지 중',
  }, FAKE_WORKER);
  const promotedDir = mcpTaskGroupDir(project, target);
  const taskFile = fs.readdirSync(promotedDir)
    .find((file) => file.startsWith('task-1-'));
  const task = JSON.parse(fs.readFileSync(path.join(promotedDir, taskFile), 'utf8'));
  assert.equal(task.activeForm, 'activeForm 유지 중');
  assert.deepEqual(fs.readdirSync(legacyTaskGroupDir(project, target)), []);

  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  const legacyRows = list.split('\n').filter((line) => /^\[legacy-\d+\]/.test(line));
  assert.equal(legacyRows.length, 50);
  console.log(`legacy_fixture_groups=${legacyRows.length}`);
  console.log('activeForm_preserved=true');
});

test('G2: 그룹 도구 다섯 개를 노출합니다', () => {
  const project = fixture('task-mcp-g2-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  // task_group_listen 은 2026-09-18 보고 직통 전환에서 없어졌습니다 — 듣기 등록이 사라졌습니다.
  const expected = [
    'task_group_add',
    'task_group_update',
    'task_group_get',
    'task_group_list',
    'task_group_research',
  ];
  // 다른 묶음이 앞에 붙어도 그룹 묶음 안의 순서는 그대로여야 합니다.
  assert.deepEqual(tools.filter((name) => expected.includes(name)), expected);
  console.log(`g2_group_tool_count=${expected.length}`);
  console.log(`visible_tool_count=${tools.length}`);
});

test('G2: 실물 그룹 대시보드 읽기는 그룹 레코드를 만들지 않는다', () => {
  const before = countGroupRecords(REPO);
  callTool(PROJECT_SERVER, REPO, 'task_group_list', { all: true });
  const after = countGroupRecords(REPO);
  assert.equal(after, before);
  const realGroups = withProject(REPO, () => listGroupIds().length);
  assert.ok(realGroups >= 50);
  console.log(`real_group_ids=${realGroups}`);
  console.log(`real_group_records_before=${before}`);
  console.log(`real_group_records_after=${after}`);
});
