// G9 — 명단과 정체 판별, task_next 의 역할·담당자 거르기.
// 설계: .claude/plans/2026-09-18-task-mcp-stack-model-overhaul/SPEC.md 3-1 · 3-2 · 5-1 · 5-2.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  PROJECT_SERVER,
  callTool,
  callToolError,
  legacyTaskGroupDir,
  makeProject,
  mcpTaskGroupDir,
  removeProject,
} from './helpers.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER_A = '22222222-2222-4222-8222-222222222222';
const WORKER_B = '33333333-3333-4333-8333-333333333333';
const TESTER = '44444444-4444-4444-8444-444444444444';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';

const projects = [];
// 이 파일의 task_update 는 completed 와 result 를 적으므로 보고가 나갑니다. 가짜 어댑터를 켜지
// 않으면 실제 cmux send 로 나가 다른 패널에 시험 보고를 보낼 수 있습니다(노트 1 의 검증 격리 계약).
// g3·g8 과 같은 방식이며, 원래 값은 담아 두었다가 되돌립니다.
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

// 보고가 아예 안 난 것이 아니라 가짜 어댑터로 갔다는 것을 보이는 자리입니다.
function fakeSendLog(project) {
  try {
    return fs.readFileSync(path.join(project, '.task-mcp-fake-cmux.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.op === 'send');
  } catch { return []; }
}

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addGroup(project, topic) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic,
    members: [
      { name: 'MNGR3', surface: MANAGER, roles: ['manager'] },
      { name: 'WRKR300', surface: WORKER_A, roles: ['worker'], scope: 'task.mjs' },
      { name: 'WRKR301', surface: WORKER_B, roles: ['worker'], scope: 'group.mjs' },
      { name: 'TESTER3', surface: TESTER, roles: ['tester'] },
      { name: 'REVIEWER3', surface: REVIEWER, roles: ['reviewer'] },
    ],
  }, MANAGER);
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function addTask(project, groupId, content, extra) {
  return callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content, batch: 'b1', spec: `${content} 기준`, ...extra,
  }, MANAGER);
}

// 워커 A 앞으로 태스크를 하나 만들고 그가 집은 상태까지 만든 뒤 번호를 돌려줍니다.
// 한 패널은 한 번에 하나만 잡으므로, 앞 시험이 잡아 둔 것이 있으면 먼저 놓아줍니다.
function addAndTake(project, groupId, holding) {
  if (holding != null) {
    callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: holding, status: 'pending' }, WORKER_A);
  }
  const output = addTask(project, groupId, '반환 시험 대상', { assignee: WORKER_A });
  const number = Number(/number=(\d+)/.exec(output)[1]);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number }, WORKER_A);
  return number;
}

function readTaskOf(project, groupId, number) {
  const dir = mcpTaskGroupDir(project, groupId);
  const file = fs.readdirSync(dir).find((name) => new RegExp(`^task-${number}-.+\\.json$`).test(name));
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

function groupSnapshot(dir) {
  return fs.readdirSync(dir).sort().map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8'), fs.statSync(path.join(dir, file)).mtimeMs]);
}

test('G9: 미등록 assignee로 추가하면 안내하고 파일을 만들지 않습니다', () => {
  const project = fixture('task-mcp-g9-assignee-unknown-');
  const groupId = addGroup(project, '미등록 배정');
  const dir = mcpTaskGroupDir(project, groupId);
  const before = groupSnapshot(dir);
  const output = callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '불가능한 배정', batch: 'b1', spec: '기준', assignee: STRANGER,
  }, MANAGER);
  assert.ok(output.includes(`assignee 66666666 는 그룹 "${groupId}" 명단에 없습니다. task_group_update 의 members 에 name·surface·roles 를 넣어 먼저 등록하십시오.`));
  assert.deepEqual(groupSnapshot(dir), before);
});

test('G9: tester에게 work를 배정하면 역할 문구로 거절합니다', () => {
  const project = fixture('task-mcp-g9-assignee-role-');
  const groupId = addGroup(project, '역할 없는 배정');
  const dir = mcpTaskGroupDir(project, groupId);
  const before = groupSnapshot(dir);
  const output = callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '테스터에게 구현', batch: 'b1', spec: '기준', assignee: TESTER,
  }, MANAGER);
  assert.ok(output.includes('assignee TESTER3(roles: tester) 은 work 를 맡을 수 없습니다. work 는 worker 가 맡습니다.'));
  assert.deepEqual(groupSnapshot(dir), before);
});

test('G9: 등록된 worker에게 work를 배정하면 그대로 수령합니다', () => {
  const project = fixture('task-mcp-g9-assignee-valid-');
  const groupId = addGroup(project, '정상 배정');
  addTask(project, groupId, '정상 구현', { assignee: WORKER_A });
  assert.equal(readTaskOf(project, groupId, 1).assignee, WORKER_A);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A), /#1 \[~\] work/);
});

test('G9: 미등록 담당자로 재배정하면 레코드·시각·보고를 보존합니다', () => {
  const project = fixture('task-mcp-g9-reassign-unknown-');
  const groupId = addGroup(project, '미등록 재배정');
  addTask(project, groupId, '기존 일', { assignee: WORKER_A });
  const dir = mcpTaskGroupDir(project, groupId);
  const before = groupSnapshot(dir);
  const output = callToolError(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, assignee: STRANGER, field: 'result', mode: 'replace', text: '저장 금지',
  }, WORKER_A);
  assert.ok(output.includes(`assignee 66666666 는 그룹 "${groupId}" 명단에 없습니다.`));
  assert.deepEqual(groupSnapshot(dir), before);
  assert.equal(fakeSendLog(project).length, 0);
});

test('G9: 빈 문자열은 work·feedback 배정을 해제하고 안내합니다', () => {
  const project = fixture('task-mcp-g9-unassign-');
  const groupId = addGroup(project, '배정 해제');
  for (const [index, kind] of ['work', 'feedback', 'test'].entries()) {
    const assignee = kind === 'test' ? TESTER : WORKER_A;
    addTask(project, groupId, `${kind} 해제`, { kind, assignee });
    const output = callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: index + 1, assignee: '' }, MANAGER);
    assert.equal(readTaskOf(project, groupId, index + 1).assignee, '');
    assert.equal(output.includes('assignee 가 비어 아무도 집을 수 없습니다'), kind !== 'test');
  }
  const created = addTask(project, groupId, '명시적으로 배정 없는 구현', { assignee: '' });
  assert.match(created, /assignee 가 비어 아무도 집을 수 없습니다/);
  assert.equal(readTaskOf(project, groupId, 4).status, 'draft');
});

test('G9: kind와 assignee를 함께 바꾸면 바뀐 kind로 검사합니다', () => {
  const project = fixture('task-mcp-g9-kind-assignee-');
  const groupId = addGroup(project, '종류와 배정');
  addTask(project, groupId, '바꿀 일', { assignee: WORKER_A });
  const before = groupSnapshot(mcpTaskGroupDir(project, groupId));
  assert.ok(callToolError(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, kind: 'test', assignee: WORKER_A,
  }, MANAGER).includes('assignee WRKR300(roles: worker) 은 test 를 맡을 수 없습니다. test 는 tester 가 맡습니다.'));
  assert.deepEqual(groupSnapshot(mcpTaskGroupDir(project, groupId)), before);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, kind: 'test', assignee: TESTER }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).kind, 'test');
  assert.equal(readTaskOf(project, groupId, 1).assignee, TESTER);
});

test('G9: kind만 바꿔도 저장된 담당자의 역할을 검사하고 거절은 사본을 남기지 않습니다', () => {
  for (const useLegacy of [false, true]) {
    const project = fixture('task-mcp-g9-kind-only-');
    const groupId = addGroup(project, '종류만 변경');
    addTask(project, groupId, '워커가 맡은 일', { assignee: WORKER_A });
    const modern = mcpTaskGroupDir(project, groupId);
    const dir = useLegacy ? legacyTaskGroupDir(project, groupId) : modern;
    if (useLegacy) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(modern, dir);
    }
    const before = groupSnapshot(dir);
    const output = callToolError(PROJECT_SERVER, project, 'task_update', {
      group_id: groupId, number: 1, kind: 'test', field: 'result', mode: 'replace', text: '저장 금지',
    }, MANAGER);
    assert.equal(output, 'Error: assignee WRKR300(roles: worker) 은 test 를 맡을 수 없습니다. test 는 tester 가 맡습니다.');
    assert.deepEqual(groupSnapshot(dir), before);
    if (useLegacy) assert.equal(fs.existsSync(modern), false);
    assert.equal(fakeSendLog(project).length, 0);

    callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, kind: 'feedback' }, MANAGER);
    assert.equal(readTaskOf(project, groupId, 1).kind, 'feedback');
    assert.equal(readTaskOf(project, groupId, 1).assignee, WORKER_A);

    addTask(project, groupId, '배정 없는 초안', { assignee: '' });
    callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, kind: 'review' }, MANAGER);
    assert.equal(readTaskOf(project, groupId, 2).kind, 'review');
    assert.equal(readTaskOf(project, groupId, 2).assignee, '');
  }
});

test('G9: 명단에서 빠진 담당자는 kind 변경 때 거절하고 함께 재배정하면 통과합니다', () => {
  const project = fixture('task-mcp-g9-kind-removed-member-');
  const groupId = addGroup(project, '옛 담당자 종류 변경');
  addTask(project, groupId, '기존 일', { assignee: WORKER_A });
  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId, members: [{ name: 'WRKR300', remove: true }],
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, tag: '그대로' }, MANAGER);
  const dir = mcpTaskGroupDir(project, groupId);
  const before = groupSnapshot(dir);
  const output = callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, kind: 'test' }, MANAGER);
  assert.equal(output, `Error: assignee 22222222 는 그룹 "${groupId}" 명단에 없습니다. task_group_update 의 members 에 name·surface·roles 를 넣어 먼저 등록하십시오.`);
  assert.deepEqual(groupSnapshot(dir), before);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, kind: 'test', assignee: TESTER }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).assignee, TESTER);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 1 }, TESTER), /#1 \[~\] test/);
});

for (const [label, assignee, reason] of [
  ['앞뒤 공백 UUID', ` ${WORKER_A} `, `assignee 값에 앞뒤 공백이 있습니다: " ${WORKER_A} "`],
  ['surface 번호', 'surface:79', 'assignee 는 surface 번호가 아니라 UUID 로 주십시오. cmux tree --all --id-format both 로 찾습니다.'],
  ['공백만 있는 값', '   ', 'assignee 값에 앞뒤 공백이 있습니다: "   "'],
]) {
  test(`G9: 잘못된 assignee(${label})는 모양 검사 문구로 거절하고 파일을 바꾸지 않습니다`, () => {
    const project = fixture('task-mcp-g9-assignee-shape-');
    const groupId = addGroup(project, label);
    addTask(project, groupId, '기존 일', { assignee: WORKER_A });
    const dir = mcpTaskGroupDir(project, groupId);
    const before = groupSnapshot(dir);
    for (const [name, args] of [
      ['task_add', { content: '새 일', batch: 'b1', spec: '기준' }],
      ['task_update', { number: 1, field: 'result', mode: 'replace', text: '저장 금지' }],
    ]) {
      const output = callToolError(PROJECT_SERVER, project, name, { group_id: groupId, ...args, assignee }, MANAGER);
      assert.equal(output, `Error: ${reason}`);
      assert.deepEqual(groupSnapshot(dir), before);
      assert.equal(fakeSendLog(project).length, 0);
    }
  });
}

test('G9: 옛 경로 그룹의 잘못된 배정은 승격 사본을 만들지 않습니다', () => {
  const project = fixture('task-mcp-g9-legacy-assignee-');
  const groupId = addGroup(project, '옛 경로 배정');
  addTask(project, groupId, '기존 일', { assignee: WORKER_A });
  const modern = mcpTaskGroupDir(project, groupId);
  const legacy = legacyTaskGroupDir(project, groupId);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.renameSync(modern, legacy);
  const before = groupSnapshot(legacy);
  for (const assignee of [STRANGER, TESTER, '   ', ` ${WORKER_A} `, 'surface:79']) {
    for (const [name, args] of [
      ['task_add', { content: '새 일', batch: 'b1', spec: '기준' }],
      ['task_update', { number: 1, field: 'result', mode: 'replace', text: '저장 금지' }],
    ]) {
      callToolError(PROJECT_SERVER, project, name, { group_id: groupId, ...args, assignee }, WORKER_A);
      assert.equal(fs.existsSync(modern), false);
      assert.deepEqual(groupSnapshot(legacy), before);
      assert.equal(fakeSendLog(project).length, 0);
    }
  }
});

test('G9: 정체를 알 수 없거나 명단에 없으면 거절 문구가 셋으로 갈린다', () => {
  const project = fixture('task-mcp-g9-identity-');
  const groupId = addGroup(project, '정체 판별');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });

  // ① 환경변수가 없다 — 빈 문자열이라도 조용히 통과시키지 않는다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, ''),
    /cmux 패널 밖에서는 정체를 알 수 없어 거절합니다\./,
  );
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_add', { group_id: groupId, content: '정체 없이 추가', batch: 'b1' }, ''),
    /cmux 패널 밖에서는 정체를 알 수 없어 거절합니다\./,
  );
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, tag: 'x' }, ''),
    /cmux 패널 밖에서는 정체를 알 수 없어 거절합니다\./,
  );

  // ② 명단에 없는 패널.
  const stranger = callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, STRANGER);
  assert.match(stranger, /이 패널\(66666666\)은 그룹 ".+" 에 쓸 수 없습니다\. 이 패널이 명단에 없습니다\./);
  assert.doesNotMatch(stranger, /옛 명단/);
  // 다음 행동은 한 번만 말합니다(백로그 13).
  assert.equal((stranger.match(/task_group_update/g) || []).length, 1);

  // ③ 옛 명단만 있는 그룹 — surface:N 은 ref 로 밀려 아무도 맞지 않는다.
  const legacyId = '2026-08-01-옛-명단';
  const legacyDir = mcpTaskGroupDir(project, legacyId);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'GROUP.json'), `${JSON.stringify({
    id: legacyId, title: '옛 명단 그룹', about: '', status: 'pending', campaign: null,
    worker: { name: 'WRKR3', surface: 'surface:90' },
    manager: { name: 'MNGR3', surface: 'surface:87' },
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(legacyDir, 'task-1-pending-[old]-옛-일.json'), `${JSON.stringify({
    number: 1, content: '옛 일', tag: 'old', status: 'pending', owner: 'surface:87', assignee: 'surface:90',
    group_id: legacyId, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);
  const legacy = callToolError(PROJECT_SERVER, project, 'task_next', { group_id: legacyId }, WORKER_A);
  assert.match(legacy, /옛 명단이라 등록된 패널이 하나도 없습니다/);
  // 까닭은 한 번, 다음 행동도 한 번입니다 — 같은 말을 되풀이하지 않습니다(백로그 13).
  assert.equal((legacy.match(/task_group_update/g) || []).length, 1);
  console.log('identity_rejections=3');
  console.log('no_duplicated_guidance=true');
});

test('G9: 워커는 남에게 배정된 work 를 집지 못한다', () => {
  const project = fixture('task-mcp-g9-worker-');
  const groupId = addGroup(project, '워커 격리');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });
  addTask(project, groupId, '워커 B 의 일', { assignee: WORKER_B });

  const forA = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A);
  assert.match(forA, /워커 A 의 일/);
  assert.doesNotMatch(forA, /워커 B 의 일/);
  const forB = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_B);
  assert.match(forB, /워커 B 의 일/);

  assert.equal(readTaskOf(project, groupId, 1).status, 'in_progress');
  assert.equal(readTaskOf(project, groupId, 2).status, 'in_progress');
  assert.equal(readTaskOf(project, groupId, 1).assignee, WORKER_A);
  assert.equal(readTaskOf(project, groupId, 2).assignee, WORKER_B);
  console.log('worker_isolation=true');
});

test('G9: 남의 in_progress 에 내 태스크가 가려지지 않는다', () => {
  const project = fixture('task-mcp-g9-inprogress-');
  const groupId = addGroup(project, '진행 중 격리');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });
  addTask(project, groupId, '워커 B 의 일', { assignee: WORKER_B });

  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A);
  // A 가 잡고 있는 동안에도 B 는 자기 것을 받는다(note-3 §5 결함 1).
  const forB = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_B);
  assert.match(forB, /다음 태스크를 시작합니다/);
  assert.match(forB, /#2 \[~\] work \(in_progress\)/);
  // 다시 부르면 자기 진행 중 태스크만 돌려준다.
  const againB = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_B);
  assert.match(againB, /이미 진행 중인 태스크입니다/);
  assert.match(againB, /#2 /);
  console.log('own_in_progress_only=true');
});

test('G9: 테스터와 리뷰어는 빈 assignee 를 집고 그 순간 자기 이름이 채워진다', () => {
  const project = fixture('task-mcp-g9-pool-');
  const groupId = addGroup(project, '풀 배정');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });
  addTask(project, groupId, 'b1 검증', { kind: 'test', depends_on: [] });
  addTask(project, groupId, 'b1 판정', { kind: 'review', depends_on: [] });

  const forTester = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, TESTER);
  assert.match(forTester, /#2 \[~\] test \(in_progress\)/);
  assert.equal(readTaskOf(project, groupId, 2).assignee, TESTER, '집는 순간 빈 assignee 가 부른 패널로 채워집니다.');

  const forReviewer = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, REVIEWER);
  assert.match(forReviewer, /#3 \[~\] review \(in_progress\)/);
  assert.equal(readTaskOf(project, groupId, 3).assignee, REVIEWER);

  // 이미 남이 집은 test 는 다른 테스터가 못 가져간다.
  assert.equal(readTaskOf(project, groupId, 1).status, 'pending');
  console.log('pool_assignee_filled_on_pick=2');
});

test('G9: 역할이 맡지 않는 종류만 남으면 다른 문구로 답한다', () => {
  const project = fixture('task-mcp-g9-role-');
  const groupId = addGroup(project, '역할 거르기');
  addTask(project, groupId, 'b1 검증', { kind: 'test', depends_on: [] });
  addTask(project, groupId, 'b1 판정', { kind: 'review', depends_on: [] });

  const forWorker = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A);
  assert.match(forWorker, /내 역할\(워커\)이 맡는 태스크가 없습니다/);
  assert.match(forWorker, /test 1개/);
  assert.match(forWorker, /review 1개/);

  // 매니저는 onboard·research 만 맡는다.
  const forManager = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, MANAGER);
  assert.match(forManager, /내 역할\(매니저\)이 맡는 태스크가 없습니다/);

  // 내 역할이 맡지만 전부 남에게 배정된 경우는 또 다른 문구다.
  const owned = addGroup(project, '전부 남의 것');
  addTask(project, owned, '워커 A 의 일', { assignee: WORKER_A });
  const forB = callTool(PROJECT_SERVER, project, 'task_next', { group_id: owned }, WORKER_B);
  assert.match(forB, /내 역할이 맡는 pending 1개가 모두 다른 패널에 배정되어 있습니다/);
  console.log('role_filter_messages=3');
});

test('G9: 겸임한 패널은 두 역할의 종류를 모두 맡는다', () => {
  const project = fixture('task-mcp-g9-dual-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '겸임',
    members: [
      { name: 'MNGR3', surface: MANAGER, roles: ['manager', 'reviewer'] },
      { name: 'WRKR301', surface: WORKER_A, roles: ['worker', 'tester'] },
    ],
  }, MANAGER);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  addTask(project, groupId, '구현', { assignee: WORKER_A });
  addTask(project, groupId, '검증', { kind: 'test', depends_on: [] });
  addTask(project, groupId, '판정', { kind: 'review', depends_on: [] });

  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, MANAGER), /#3 \[~\] review/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A), /#1 \[~\] work/);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, WORKER_A);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A), /#2 \[~\] test/);

  // 완료 보고가 실제로 났고, 실제 cmux 가 아니라 가짜 어댑터로 갔습니다.
  const sent = fakeSendLog(project);
  assert.equal(sent.length, 1, '보고가 0건이면 격리가 아니라 보고 자체가 사라진 것입니다.');
  assert.match(sent[0].text, /task-1 \(work\) 의 completed 를 적었습니다/);
  console.log('dual_role_kinds=true');
  console.log('report_went_to_fake_adapter=1');
});

// ── 백로그 9 — 명단 밖 패널의 쓰기 ────────────────────────────────────────────

test('G9: 명단에 없거나 명단에서 뺀 패널은 task_add 와 task_update 가 모두 거절된다', () => {
  const project = fixture('task-mcp-g9-outsider-');
  const groupId = addGroup(project, '명단 밖 쓰기');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });

  // ① 한 번도 등록한 적 없는 패널입니다.
  for (const [name, args] of [
    ['task_add', { group_id: groupId, content: '몰래 추가', batch: 'b1', spec: '기준', assignee: WORKER_A }],
    ['task_update', { group_id: groupId, number: 1, priority: 3 }],
    ['task_update', { group_id: groupId, number: 1, field: 'result', mode: 'append', text: '몰래 적기' }],
  ]) {
    assert.match(
      callToolError(PROJECT_SERVER, project, name, args, STRANGER),
      /이 패널\(66666666\)은 그룹 ".+" 에 쓸 수 없습니다\. 이 패널이 명단에 없습니다\./,
      `${name} 이 명단 밖 패널을 통과시켰습니다.`,
    );
  }

  // 거절된 요청은 아무것도 남기지 않습니다 — 태스크 수도 result 도 그대로입니다.
  assert.equal(readTaskOf(project, groupId, 1).result, '');
  assert.equal(fs.readdirSync(mcpTaskGroupDir(project, groupId)).filter((f) => f.startsWith('task-')).length, 1);

  // ② 명단에서 뺀 옛 패널도 같습니다. 담당 패널 교체(E1)에서 옛 패널이 계속 쓰던 자리입니다.
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A);
  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId, members: [{ name: 'WRKR300', remove: true }],
  }, MANAGER);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', {
      group_id: groupId, number: 1, field: 'result', mode: 'append', text: '뺀 뒤에도 적기',
    }, WORKER_A),
    /쓸 수 없습니다/,
  );
  assert.equal(readTaskOf(project, groupId, 1).result, '');
  console.log('stranger_write_rejected=true');
  console.log('removed_member_write_rejected=true');
});

test('G9: 옛 명단 그룹은 까닭을 알리고 task_group_update 로 등록하면 바로 쓸 수 있다', () => {
  const project = fixture('task-mcp-g9-legacy-recover-');
  const groupId = '2026-08-01-옛-명단';
  const dir = mcpTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  // 이관 01 이 옛 레코드의 두 칸을 members 로 옮겼지만 옛 레코드에 UUID 가 없어 surface 가 비었습니다.
  fs.writeFileSync(path.join(dir, 'TASK_GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: groupId,
    about: '',
    status: 'pending',
    campaign: null,
    members: [{ name: 'WRKR3', surface: '', ref: 'surface:90', roles: ['worker'], scope: '', session: null }],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);

  // ① 거절합니다. 까닭은 옛 명단이라는 것이고 다음 행동은 task_group_update 입니다.
  const refused = callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '옛 그룹에 추가', batch: 'b1', spec: '기준', assignee: WORKER_A,
  }, WORKER_A);
  assert.match(refused, /옛 명단이라 등록된 패널이 하나도 없습니다/);
  assert.match(refused, /task_group_update 의 members 에 name 과 surface 와 roles 를 넣어 등록하십시오/);

  // ② 보강합니다. 같은 이름이면 갱신이라 항목이 늘지 않습니다.
  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId, members: [{ name: 'WRKR3', surface: WORKER_A, roles: ['worker'] }],
  }, WORKER_A);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'TASK_GROUP.json'), 'utf8'));
  assert.equal(record.members.length, 1);
  assert.equal(record.members[0].surface, WORKER_A);

  // ③ 이제 됩니다.
  assert.match(
    callTool(PROJECT_SERVER, project, 'task_add', {
      group_id: groupId, content: '옛 그룹에 추가', batch: 'b1', spec: '기준', assignee: WORKER_A,
    }, WORKER_A),
    /추가됨: group_id="2026-08-01-옛-명단", number=1/,
  );
  console.log('legacy_members_rejected=true');
  console.log('legacy_members_recovered=true');
});

// ── 백로그 11 — 없는 선행 번호 ───────────────────────────────────────────────

test('G9: 없는 depends_on 번호는 그 번호를 짚어 거절하고 태스크를 만들지 않는다', () => {
  const project = fixture('task-mcp-g9-depends-');
  const groupId = addGroup(project, '없는 선행');
  addTask(project, groupId, '첫 일', { assignee: WORKER_A });

  const refused = callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '없는 선행을 봄', batch: 'b1', spec: '기준', assignee: WORKER_A, depends_on: [1, 99, 100],
  }, MANAGER);
  assert.match(refused, /depends_on 에 그룹 ".+" 에 없는 번호가 있습니다: #99, #100/);
  assert.match(refused, /지금 있는 태스크는 1개이고 번호는 #1 부터 #1 까지입니다/);
  // 거절된 요청은 태스크를 남기지 않습니다.
  assert.equal(fs.readdirSync(mcpTaskGroupDir(project, groupId)).filter((f) => f.startsWith('task-')).length, 1);

  // task_update 도 같습니다. 값도 보고도 바뀌지 않습니다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, depends_on: [42] }, MANAGER),
    /없는 번호가 있습니다: #42/,
  );
  assert.deepEqual(readTaskOf(project, groupId, 1).depends_on, []);

  // 있는 번호는 그대로 받습니다.
  addTask(project, groupId, '뒤따르는 일', { assignee: WORKER_A, depends_on: [1] });
  assert.deepEqual(readTaskOf(project, groupId, 2).depends_on, [1]);
  console.log('missing_dependency_rejected=true');
  console.log('existing_dependency_accepted=true');
});

// ── 백로그 12 — 번호 지정 수령과 자기 반환 ──────────────────────────────────

test('G9: task_next 는 번호를 지정해 집고 못 집는 까닭을 번호마다 따로 답한다', () => {
  const project = fixture('task-mcp-g9-pick-number-');
  const groupId = addGroup(project, '번호 지정');
  addTask(project, groupId, '워커 A 의 앞 일', { assignee: WORKER_A });
  addTask(project, groupId, '워커 A 의 뒤 일', { assignee: WORKER_A });
  addTask(project, groupId, '워커 B 의 일', { assignee: WORKER_B });
  addTask(project, groupId, '검증', { kind: 'test', depends_on: [] });
  addTask(project, groupId, '선행이 걸린 일', { assignee: WORKER_A, depends_on: [1] });

  // 번호를 주면 앞 번호를 건너뛰고 그것을 집습니다. 생략하면 예전처럼 번호가 앞선 것을 집습니다.
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 2 }, WORKER_A), /#2 \[~\] work/);

  // 이미 잡은 번호를 다시 부르면 그대로 돌려줍니다.
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 2 }, WORKER_A), /이미 진행 중인 태스크입니다/);

  // 다른 번호를 부르면 둘을 한꺼번에 잡지 않게 막고 되돌리는 법을 알립니다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 1 }, WORKER_A),
    /#2 를 진행 중이라 #1 를 집을 수 없습니다\..*task_update 로 #2 를 pending 으로 되돌리십시오/s,
  );

  // 못 집는 까닭은 번호마다 다릅니다.
  const cases = [
    [WORKER_B, 99, /#99 를 그룹 ".+" 에서 못 찾았습니다/],
    [WORKER_B, 2, /#2 는 다른 패널이 진행 중입니다/],
    [WORKER_B, 4, /#4 는 test 라 내 역할\(워커\)이 맡지 않습니다/],
    [WORKER_B, 1, /#1 는 다른 패널에 배정되어 있습니다/],
    [WORKER_B, 5, /#5 는 다른 패널에 배정되어 있습니다/],
  ];
  for (const [who, wanted, pattern] of cases) {
    assert.match(callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: wanted }, who), pattern);
  }

  // 선행이 안 끝난 것은 담당자에게도 막힙니다 — #2 를 놓고 #5 를 부릅니다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, status: 'pending' }, WORKER_A);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 5 }, WORKER_A),
    /#5 는 선행 태스크가 끝나지 않았습니다: #1/,
  );

  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 0 }, WORKER_A),
    /number 는 양의 정수 태스크 번호여야 합니다/,
  );
  console.log('pick_by_number=true');
  console.log('pick_refusal_reasons=5');
});

test('G9: 진행 중 태스크는 담당자 본인만 pending 으로 되돌리고 담당자와 본문은 그대로다', () => {
  const project = fixture('task-mcp-g9-return-');
  const groupId = addGroup(project, '자기 반환');
  addTask(project, groupId, '겸임 매니저 몫', { assignee: WORKER_A });

  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'memo', mode: 'replace', text: '적어 둔 메모',
  }, WORKER_A);

  // 남은 되돌릴 수 없습니다. 매니저에게도 열지 않습니다.
  for (const who of [WORKER_B, MANAGER]) {
    assert.match(
      callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'pending' }, who),
      /진행 중인 태스크를 pending 으로 되돌리는 것은 담당자 본인만 할 수 있습니다/,
    );
  }
  assert.equal(readTaskOf(project, groupId, 1).status, 'in_progress');

  // 본인은 됩니다. 담당자와 본문이 그대로 남아 다시 집을 수 있습니다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'pending' }, WORKER_A);
  const returned = readTaskOf(project, groupId, 1);
  assert.equal(returned.status, 'pending');
  assert.equal(returned.assignee, WORKER_A);
  assert.equal(returned.memo, '적어 둔 메모');
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A), /#1 \[~\] work/);

  // 되돌림은 보고 사건이 아닙니다 — 기록에 줄이 생기지 않습니다.
  const queue = path.join(mcpTaskGroupDir(project, groupId), 'MANAGER_MESSAGE_QUEUE.jsonl');
  assert.equal(fs.existsSync(queue), false);

  // pending 에서 completed 로 바로 가는 길은 그대로 막힙니다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'pending' }, WORKER_A);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, WORKER_A),
    /pending 에서 completed 로는 갈 수 없습니다/,
  );
  console.log('self_return_allowed=true');
  console.log('other_return_rejected=true');
});

test('G9: 반환 요청에 담당자를 함께 실어도 권한은 저장된 담당자로 본다', () => {
  const project = fixture('task-mcp-g9-return-guard-');
  const groupId = addGroup(project, '반환 우회');

  // 남이 assignee 에 자기 UUID 를 실어 남의 일을 반환하던 자리입니다(리뷰 29).
  let held = null;
  for (const [label, who, newAssignee, pattern] of [
    ['매니저가 자기에게', MANAGER, MANAGER, /담당자 본인만 할 수 있습니다/],
    ['다른 워커가 자기에게', WORKER_B, WORKER_B, /담당자 본인만 할 수 있습니다/],
    ['담당자가 남에게 넘기며', WORKER_A, WORKER_B, /되돌리는 호출에서는 담당자를 바꿀 수 없습니다/],
    // 비우는 것도 바꾸는 것입니다. 이 길로 담당자가 사라지던 자리입니다(리뷰 28).
    ['담당자가 빈 문자열로 비우며', WORKER_A, '', /되돌리는 호출에서는 담당자를 바꿀 수 없습니다/],
    ['담당자가 공백으로 비우며', WORKER_A, '   ', /되돌리는 호출에서는 담당자를 바꿀 수 없습니다/],
    // 원문 그대로 견줍니다. 다듬어 견주면 이것이 통과하고 공백째 저장돼 본인이 다시 못 받습니다.
    ['같은 UUID 에 공백을 붙여', WORKER_A, ` ${WORKER_A} `, /되돌리는 호출에서는 담당자를 바꿀 수 없습니다/],
  ]) {
    const number = addAndTake(project, groupId, held);
    held = number;
    assert.match(
      callToolError(PROJECT_SERVER, project, 'task_update', {
        group_id: groupId, number, status: 'pending', assignee: newAssignee,
        field: 'memo', mode: 'replace', text: '몰래 적기',
      }, who),
      pattern,
      label,
    );
    // 거절된 호출은 상태도 담당자도 본문도 남기지 않습니다.
    const task = readTaskOf(project, groupId, number);
    assert.equal(task.status, 'in_progress', `${label}: 상태가 바뀌었습니다.`);
    assert.equal(task.assignee, WORKER_A, `${label}: 담당자가 바뀌었습니다.`);
    assert.equal(task.memo, '', `${label}: 본문이 부분 저장됐습니다.`);
    // 담당자가 원문 그대로 남아야 본인이 계속 그 일을 쥐고 있습니다.
    assert.match(
      callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER_A),
      new RegExp(`#${number} \\[~\\]`),
      `${label}: 거절 뒤 담당자가 자기 일을 잃었습니다.`,
    );
  }

  // 막지 말아야 할 것 넷입니다.
  const mine = addAndTake(project, groupId, held);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: mine, status: 'pending', assignee: WORKER_A,
  }, WORKER_A);
  assert.equal(readTaskOf(project, groupId, mine).status, 'pending', '같은 UUID 를 함께 줘도 본인 반환은 됩니다.');
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: mine }, WORKER_A), /in_progress/);

  // 인자를 생략한 본인 반환도 됩니다. 저장된 담당자가 그대로 남고 다시 집힙니다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: mine, status: 'pending' }, WORKER_A);
  assert.equal(readTaskOf(project, groupId, mine).assignee, WORKER_A, '생략한 반환은 담당자를 지우지 않습니다.');
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: mine }, WORKER_A), /in_progress/);

  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: mine, assignee: WORKER_B }, MANAGER);
  assert.equal(readTaskOf(project, groupId, mine).assignee, WORKER_B, '상태를 안 바꾸는 배정 변경은 그대로 됩니다.');
  console.log('return_guard_uses_stored_assignee=true');
  console.log('return_call_cannot_move_assignee=true');
});

// ── 백로그 10 — review 의 기본 선행 ─────────────────────────────────────────

test('G9: review 의 기본 선행에는 같은 배치의 test 가 들어가고 명시한 배열은 빈 것도 그대로다', () => {
  const project = fixture('task-mcp-g9-review-depends-');
  const groupId = addGroup(project, 'review 선행');
  addTask(project, groupId, '구현 하나', { assignee: WORKER_A });
  addTask(project, groupId, '구현 둘', { assignee: WORKER_B });
  addTask(project, groupId, '배치 검증', { kind: 'test' });
  addTask(project, groupId, '배치 판정', { kind: 'review' });

  // test 는 work·feedback 만, review 는 거기에 test 까지 기다립니다.
  assert.deepEqual(readTaskOf(project, groupId, 3).depends_on, [1, 2]);
  assert.deepEqual(readTaskOf(project, groupId, 4).depends_on, [1, 2, 3]);

  // 명시한 배열은 그대로이고 빈 배열도 존중합니다.
  addTask(project, groupId, '따로 정한 판정', { kind: 'review', depends_on: [1] });
  addTask(project, groupId, '선행 없는 판정', { kind: 'review', depends_on: [] });
  assert.deepEqual(readTaskOf(project, groupId, 5).depends_on, [1]);
  assert.deepEqual(readTaskOf(project, groupId, 6).depends_on, []);

  // 나중에 생기는 test 는 따라가지 않습니다 — 이미 만든 review 의 선행은 그대로입니다.
  addTask(project, groupId, '뒤늦은 검증', { kind: 'test' });
  assert.deepEqual(readTaskOf(project, groupId, 4).depends_on, [1, 2, 3]);

  // 다른 배치의 것은 섞이지 않습니다.
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b2 판정', batch: 'b2', kind: 'review', spec: '기준',
  }, MANAGER);
  assert.deepEqual(readTaskOf(project, groupId, 8).depends_on, []);
  console.log('review_default_includes_test=true');
  console.log('explicit_empty_respected=true');
});

// ── 백로그 13·14 — 안내 문구와 목록 표시 ───────────────────────────────────

test('G9: 거절과 안내가 다음 행동을 가리키고 목록이 담당자와 센 대상을 밝힌다', () => {
  const project = fixture('task-mcp-g9-guidance-');
  const groupId = addGroup(project, '안내 문구');
  addTask(project, groupId, '워커 A 의 일', { assignee: WORKER_A });
  addTask(project, groupId, '워커 B 의 일', { assignee: WORKER_B });

  // ① completed 거절에 다음 행동이 붙습니다.
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId, number: 1 }, WORKER_A);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, WORKER_A);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, content: '고친 제목' }, MANAGER),
    /completed 태스크는 바꿀 수 없습니다\. 고칠 것이 있으면 task_add 로 feedback 태스크를 새로 만드십시오\./,
  );

  // ② 목록이 담당자를 보입니다. 옛 표시는 만든 사람이라 병행 워커를 가리지 못했습니다.
  const list = callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId, all: true }, MANAGER);
  assert.match(list, new RegExp(`담당 ${WORKER_A.slice(0, 8)}`));
  assert.match(list, new RegExp(`담당 ${WORKER_B.slice(0, 8)}`));
  assert.doesNotMatch(list, new RegExp(`@${MANAGER.slice(0, 8)}`), '만든 사람 표기는 담당자 자리를 차지하지 않습니다.');

  // ③ 보고 목록의 머리 줄이 무엇을 걸러 보이는지 밝힙니다.
  const messages = callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId }, MANAGER);
  assert.match(messages, /안 읽은 것 \d+건 \/ 기록 전체 \d+건/);
  assert.match(
    callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'all' }, MANAGER),
    /전부 \d+건 \/ 기록 전체 \d+건/,
  );
  // 이 검사의 보고도 가짜 어댑터로 갔습니다 — 기록에 남은 줄과 보낸 줄이 하나씩 맞습니다.
  const sent = fakeSendLog(project);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /의 completed 를 적었습니다/);
  console.log('completed_error_has_next_action=true');
  console.log('list_shows_assignee=true');
  console.log('message_list_header_names_filter=true');
  console.log('report_went_to_fake_adapter=1');
});
