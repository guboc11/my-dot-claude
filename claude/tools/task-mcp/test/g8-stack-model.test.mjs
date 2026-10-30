// G8 — 쌓기 모델(model.mjs) 단위 검사.
// 설계: .claude/plans/2026-09-18-task-mcp-stack-model-overhaul/SPEC.md 2-1 · 2-2 · 3-1 · 3-2 · 5-3.
// 도구 단위 검사(task_add·task_update·task_next 등)는 B2-3 에서 같은 파일에 더한다.

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

import {
  FAKE_TREE,
  KINDS,
  KIND_ROLES,
  MARK,
  ROLES,
  STATUSES,
  TRANSITIONS,
  assigneeRule,
  canTake,
  canTransition,
  hasLegacyMembers,
  isBatch,
  kindsForRoles,
  memberOf,
  normalizeMembers,
  parseTaskFileName,
  requireOwner,
  resolveSurface,
  taskFileName,
  transitionGuard,
  validateMembers,
} from '../model.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function fakeTree() {
  return FAKE_TREE;
}

function message(fn) {
  try {
    fn();
  } catch (cause) {
    return cause.message;
  }
  throw new Error('거절을 예상했지만 성공했습니다.');
}

test('G8: 상태 넷 · KIND 여섯 · 역할 넷과 표식이 명세대로다', () => {
  assert.deepEqual(STATUSES, ['draft', 'pending', 'in_progress', 'completed']);
  assert.deepEqual(KINDS, ['work', 'test', 'review', 'feedback', 'onboard', 'research']);
  assert.deepEqual(ROLES, ['manager', 'worker', 'tester', 'reviewer']);
  assert.deepEqual(MARK, { draft: '[.]', pending: '[ ]', in_progress: '[~]', completed: '[x]' });
  assert.deepEqual(KIND_ROLES.work, ['worker']);
  assert.deepEqual(KIND_ROLES.feedback, ['worker']);
  assert.deepEqual(KIND_ROLES.test, ['tester']);
  assert.deepEqual(KIND_ROLES.review, ['reviewer']);
  assert.deepEqual(KIND_ROLES.onboard, []);
  assert.deepEqual(KIND_ROLES.research, []);
  console.log(`statuses=${STATUSES.length} kinds=${KINDS.length} roles=${ROLES.length}`);
});

test('G8: KIND 별 assignee 규칙과 역할이 맡는 KIND 목록', () => {
  assert.equal(assigneeRule('work'), 'mine');
  assert.equal(assigneeRule('feedback'), 'mine');
  for (const kind of ['test', 'review', 'onboard', 'research']) {
    assert.equal(assigneeRule(kind), 'mine_or_empty');
  }

  // work 는 나인 것만. 비어 있으면 아무도 못 집는다.
  assert.equal(canTake('work', WORKER, WORKER), true);
  assert.equal(canTake('work', OTHER, WORKER), false);
  assert.equal(canTake('work', '', WORKER), false);
  // test 는 비었거나 나인 것.
  assert.equal(canTake('test', '', WORKER), true);
  assert.equal(canTake('test', WORKER, WORKER), true);
  assert.equal(canTake('test', OTHER, WORKER), false);

  assert.deepEqual(kindsForRoles(['worker']), ['work', 'feedback', 'onboard', 'research']);
  assert.deepEqual(kindsForRoles(['tester']), ['test', 'onboard', 'research']);
  assert.deepEqual(kindsForRoles(['reviewer']), ['review', 'onboard', 'research']);
  assert.deepEqual(kindsForRoles(['manager']), ['onboard', 'research']);
  assert.deepEqual(kindsForRoles(['manager', 'reviewer']), ['review', 'onboard', 'research']);
  assert.deepEqual(kindsForRoles([]), ['onboard', 'research']);
  console.log('kind_roles_table=true');
});

test('G8: 배치 값은 b 뒤에 양의 정수여야 한다', () => {
  for (const value of ['b1', 'b2', 'b12']) assert.equal(isBatch(value), true);
  for (const value of ['b0', 'b', 'b01', '1', 'batch1', '', null, undefined]) {
    assert.equal(isBatch(value), false, `${value} 는 배치가 아니어야 합니다.`);
  }
  console.log('batch_rule=b{양의 정수}');
});

test('G8: 새 꼴 파일 이름을 만들고 그대로 되읽는다', () => {
  const file = taskFileName(5, 'b2', 'work', 'pending', '오프닝 카드 3종', 'ui');
  assert.equal(file, 'task-5-b2-work-pending-[ui]-오프닝-카드-3종.json');
  assert.deepEqual(parseTaskFileName(file), {
    number: 5, batch: 'b2', kind: 'work', status: 'pending', legacy: false,
  });

  const noTag = taskFileName(12, 'b2', 'test', 'in_progress', 'b2 검증', '');
  assert.equal(noTag, 'task-12-b2-test-in_progress-b2-검증.json');
  assert.deepEqual(parseTaskFileName(noTag), {
    number: 12, batch: 'b2', kind: 'test', status: 'in_progress', legacy: false,
  });

  // 태그 20자 · 제목 40자 상한은 lib.mjs 의 slug 를 그대로 쓴다.
  const long = taskFileName(7, 'b10', 'review', 'completed', '가'.repeat(60), '나'.repeat(40));
  assert.equal(long, `task-7-b10-review-completed-[${'나'.repeat(20)}]-${'가'.repeat(40)}.json`);
  assert.equal(parseTaskFileName(long).number, 7);
  console.log('new_name_roundtrip=true');
});

test('G8: 옛 꼴 파일 이름은 kind work · batch 빈 값으로 읽힌다', () => {
  assert.deepEqual(parseTaskFileName('task-5-pending-[ui]-제목.json'), {
    number: 5, batch: '', kind: 'work', status: 'pending', legacy: true,
  });
  assert.deepEqual(parseTaskFileName('task-1-in_progress-옛-태스크.json'), {
    number: 1, batch: '', kind: 'work', status: 'in_progress', legacy: true,
  });
  assert.deepEqual(parseTaskFileName('task-99-completed-[gate]-b2-검증.json'), {
    number: 99, batch: '', kind: 'work', status: 'completed', legacy: true,
  });
  console.log('legacy_name_kind=work');
});

test('G8: 이름 규칙에 안 맞는 파일은 null 로 돌려준다', () => {
  assert.equal(parseTaskFileName('task-5-b0-work-pending-제목.json'), null, 'b0 은 배치가 아닙니다.');
  assert.equal(parseTaskFileName('task-5-b2-design-pending-제목.json'), null, 'design 은 KIND 가 아닙니다.');
  assert.equal(parseTaskFileName('task-5-b2-work-done-제목.json'), null, 'done 은 상태가 아닙니다.');
  assert.equal(parseTaskFileName('GROUP.json'), null);
  assert.equal(parseTaskFileName('note-1-제목.md'), null);
  assert.equal(parseTaskFileName('task-5.json'), null);
  console.log('malformed_returns_null=6');
});

test('G8: taskFileName 은 잘못된 배치·종류·상태를 거절한다', () => {
  assert.match(message(() => taskFileName(1, 'b0', 'work', 'pending', '제목')), /batch 는 b 뒤에 양의 정수/);
  assert.match(message(() => taskFileName(1, 'b1', 'design', 'pending', '제목')), /kind 는 work \| test/);
  assert.match(message(() => taskFileName(1, 'b1', 'work', 'done', '제목')), /status 는 draft \| pending/);
  console.log('file_name_rejects=3');
});

test('G8: 전이 표는 SPEC 5-3 그대로이고 그 밖은 전부 막힌다', () => {
  // in_progress -> pending 은 2026-09-18 정합 개선에서 열었습니다(백로그 12). 담당자 본인만 씁니다.
  assert.deepEqual(TRANSITIONS, {
    draft: ['pending'],
    pending: ['draft', 'in_progress'],
    in_progress: ['pending', 'completed'],
    completed: [],
  });

  const allowed = new Set([
    'draft>pending', 'pending>draft', 'pending>in_progress',
    'in_progress>pending', 'in_progress>completed',
  ]);
  let open = 0;
  let closed = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = allowed.has(`${from}>${to}`);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
      if (expected) open += 1; else closed += 1;
    }
  }
  assert.equal(canTransition('pending', 'done'), false);
  assert.equal(canTransition('없는상태', 'pending'), false);
  console.log(`transition_open=${open} transition_closed=${closed}`);
});

test('G8: draft 를 pending 으로 올리려면 spec 과 assignee 가 차 있어야 한다', () => {
  const record = { members: [{ name: 'MNGR', surface: MANAGER, roles: ['manager'] }] };
  const base = { owner: MANAGER, assignee: WORKER, spec: '만들 것과 받아들임 조건', kind: 'work' };

  assert.equal(transitionGuard({ from: 'draft', to: 'pending', task: base, caller: MANAGER, record }), true);

  assert.equal(
    message(() => transitionGuard({
      from: 'draft', to: 'pending', task: { ...base, spec: '   ' }, caller: MANAGER, record,
    })),
    'spec 이 비어 있어 pending 으로 올릴 수 없습니다.',
  );
  assert.match(
    message(() => transitionGuard({
      from: 'draft', to: 'pending', task: { ...base, assignee: '' }, caller: MANAGER, record,
    })),
    /^assignee 가 비어 있어 pending 으로 올릴 수 없습니다\./,
  );
  // test 는 빈 assignee 로도 올라간다 — 테스터 풀이기 때문이다.
  assert.equal(
    transitionGuard({
      from: 'draft', to: 'pending', task: { ...base, kind: 'test', assignee: '' }, caller: MANAGER, record,
    }),
    true,
  );
  // 옛 태스크는 spec 칸이 없으므로 그 조건을 묻지 않는다.
  assert.equal(
    transitionGuard({
      from: 'draft', to: 'pending', task: { owner: MANAGER, assignee: WORKER, spec: '', kind: 'work', legacy: true }, caller: MANAGER, record,
    }),
    true,
  );
  console.log('draft_to_pending_guard=spec+assignee');
});

test('G8: 전이를 부를 수 있는 패널이 정해져 있다', () => {
  const record = {
    members: [
      { name: 'MNGR', surface: MANAGER, roles: ['manager'] },
      { name: 'WRKR', surface: WORKER, roles: ['worker'] },
    ],
  };
  const task = { owner: MANAGER, assignee: WORKER, spec: '스펙', kind: 'work' };

  assert.match(
    message(() => transitionGuard({ from: 'draft', to: 'pending', task, caller: WORKER, record })),
    /매니저나 만든 패널만/,
  );
  // 만든 패널이면 매니저가 아니어도 올릴 수 있다.
  assert.equal(
    transitionGuard({ from: 'draft', to: 'pending', task: { ...task, owner: WORKER }, caller: WORKER, record }),
    true,
  );

  assert.equal(transitionGuard({ from: 'in_progress', to: 'completed', task, caller: WORKER, record }), true);
  assert.equal(transitionGuard({ from: 'in_progress', to: 'completed', task, caller: MANAGER, record }), true);
  assert.match(
    message(() => transitionGuard({ from: 'in_progress', to: 'completed', task, caller: OTHER, record })),
    /담당자나 매니저만/,
  );
  // assignee 가 빈 옛 태스크는 누구든 끝낼 수 있다.
  assert.equal(
    transitionGuard({ from: 'in_progress', to: 'completed', task: { ...task, assignee: '' }, caller: OTHER, record }),
    true,
  );
  console.log('transition_caller_guard=true');
});

test('G8: completed 뒤 변경과 in_progress 직접 지정은 거절한다', () => {
  const record = { members: [{ name: 'MNGR', surface: MANAGER, roles: ['manager'] }] };
  const task = { owner: MANAGER, assignee: MANAGER, spec: '스펙', kind: 'work' };

  assert.equal(
    message(() => transitionGuard({ from: 'completed', to: 'pending', task, caller: MANAGER, record })),
    'completed 태스크는 바꿀 수 없습니다.',
  );
  assert.equal(
    message(() => transitionGuard({ from: 'pending', to: 'in_progress', task, caller: MANAGER, record })),
    'in_progress 는 task_next 로만 갑니다.',
  );
  assert.equal(
    message(() => transitionGuard({ from: 'draft', to: 'completed', task, caller: MANAGER, record })),
    'draft 에서 completed 로는 갈 수 없습니다.',
  );
  console.log('terminal_and_direct_pick_rejected=true');
});

test('G8: 옛 레코드의 worker·manager 를 members 로 읽고 surface:N 은 ref 로 옮긴다', () => {
  const legacy = {
    id: '2026-08-16-옛-그룹',
    worker: { name: 'WRKR3', surface: WORKER },
    manager: { name: 'MNGR3', surface: 'surface:87' },
  };
  const members = normalizeMembers(legacy);
  assert.equal(members.length, 2);
  assert.deepEqual(members[0], {
    name: 'MNGR3', surface: '', ref: 'surface:87', roles: ['manager'], scope: '', session: null,
  });
  assert.deepEqual(members[1], {
    name: 'WRKR3', surface: WORKER, ref: null, roles: ['worker'], scope: '', session: null,
  });

  // 두 표기가 섞여 있으면 UUID 쪽만 정체 판별에 쓰인다.
  assert.equal(memberOf(legacy, WORKER).name, 'WRKR3');
  assert.equal(memberOf(legacy, 'surface:87'), null);
  assert.equal(hasLegacyMembers(legacy), false);
  assert.equal(hasLegacyMembers({ manager: { name: 'MNGR3', surface: 'surface:87' } }), true);
  assert.deepEqual(normalizeMembers(null), []);
  assert.deepEqual(normalizeMembers({}), []);
  console.log('legacy_record_to_members=2');
});

test('G8: members 가 이미 있으면 그대로 읽고 정체를 찾는다', () => {
  const record = {
    members: [
      { name: 'MNGR3', surface: MANAGER, ref: 'surface:32', roles: ['manager', 'reviewer'], session: 'd1eab583' },
      { name: 'WRKR301', surface: WORKER, ref: 'surface:70', roles: ['worker'], scope: 'task.mjs · group.mjs' },
    ],
  };
  assert.deepEqual(memberOf(record, MANAGER).roles, ['manager', 'reviewer']);
  assert.equal(memberOf(record, WORKER).scope, 'task.mjs · group.mjs');
  assert.equal(memberOf(record, OTHER), null);
  assert.equal(memberOf(record, ''), null);
  assert.equal(hasLegacyMembers(record), false);
  console.log('members_lookup=true');
});

test('G8: 명단 검사는 매니저 두 명과 없는 역할을 거절한다', () => {
  const ok = [
    { name: 'MNGR3', surface: MANAGER, roles: ['manager', 'reviewer'] },
    { name: 'WRKR301', surface: WORKER, roles: ['worker'] },
  ];
  assert.equal(validateMembers(ok), ok);

  assert.match(
    message(() => validateMembers([
      { name: 'MNGR3', surface: MANAGER, roles: ['manager'] },
      { name: 'MNGR4', surface: WORKER, roles: ['manager'] },
    ])),
    /^매니저는 그룹당 한 명입니다\. 받은 매니저 2명: MNGR3, MNGR4$/,
  );
  assert.match(message(() => validateMembers([{ name: 'X', surface: MANAGER, roles: ['watcher'] }])), /roles 는 manager \| worker/);
  assert.match(message(() => validateMembers([{ name: 'X', surface: MANAGER, roles: [] }])), /roles 는 manager \| worker/);
  assert.match(message(() => validateMembers([{ name: '', surface: MANAGER, roles: ['worker'] }])), /name 이 필요합니다/);
  assert.match(message(() => validateMembers([{ name: 'X', roles: ['worker'] }])), /surface 가 필요합니다/);
  assert.match(message(() => validateMembers('없음')), /members 는 배열이어야 합니다/);
  console.log('member_validation_rejects=6');
});

test('G8: 환경변수가 없으면 정체를 알 수 없어 거절한다', () => {
  assert.equal(requireOwner(MANAGER), MANAGER);
  assert.equal(message(() => requireOwner('')), 'cmux 패널 밖에서는 정체를 알 수 없어 거절합니다.');
  assert.equal(message(() => requireOwner(undefined)), 'cmux 패널 밖에서는 정체를 알 수 없어 거절합니다.');
  console.log('owner_required=true');
});

test('G8: surface:N 은 cmux tree 로 UUID 가 되고 UUID 는 조회 없이 통과한다', () => {
  assert.deepEqual(resolveSurface('surface:2', fakeTree), { surface: WORKER, ref: 'surface:2' });
  assert.deepEqual(resolveSurface('2', fakeTree), { surface: WORKER, ref: 'surface:2' });
  assert.deepEqual(resolveSurface(MANAGER, fakeTree), { surface: MANAGER, ref: null });

  // UUID 를 줄 때는 tree 를 아예 부르지 않는다.
  let called = 0;
  resolveSurface(OTHER, () => { called += 1; return FAKE_TREE; });
  assert.equal(called, 0);

  assert.equal(
    message(() => resolveSurface('surface:99', fakeTree)),
    'surface:99 패널을 cmux 에서 찾지 못했습니다.',
  );
  assert.match(message(() => resolveSurface('WRKR301', fakeTree)), /UUID 이거나 surface:N 꼴/);
  assert.match(message(() => resolveSurface('', fakeTree)), /surface 값이 비어 있습니다/);
  assert.match(
    message(() => resolveSurface('surface:1', () => { throw new Error('cmux 없음'); })),
    /cmux tree 를 부르지 못해 surface:1 를 UUID 로 바꿀 수 없습니다: cmux 없음/,
  );
  console.log('resolve_surface=uuid+ref');
});

test('G8: TASK_MCP_FAKE_CMUX=1 이면 기본 runTree 가 고정 문자열을 쓴다', () => {
  const before = process.env.TASK_MCP_FAKE_CMUX;
  process.env.TASK_MCP_FAKE_CMUX = '1';
  try {
    assert.deepEqual(resolveSurface('surface:3'), { surface: OTHER, ref: 'surface:3' });
  } finally {
    if (before === undefined) delete process.env.TASK_MCP_FAKE_CMUX;
    else process.env.TASK_MCP_FAKE_CMUX = before;
  }
  console.log('fake_tree_default=true');
});

// ── 도구 단위 — 쌓기 모델이 task_add · task_update · task_list 에서 실제로 도는지 ────────────

const projects = [];
// 거절 흐름과 전이 검사가 completed 를 적어 보고가 나갑니다. 가짜 어댑터를 켜지 않으면 실제
// cmux send 로 나갑니다(노트 1 의 검증 격리 계약). 원래 값은 담아 두었다가 되돌립니다.
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

function addGroup(project, topic) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic,
    members: [
      { name: 'MNGR3', surface: MANAGER, roles: ['manager', 'reviewer'] },
      { name: 'WRKR3', surface: WORKER, roles: ['worker'] },
    ],
  }, MANAGER);
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function taskFileOf(project, groupId, number) {
  return fs.readdirSync(mcpTaskGroupDir(project, groupId))
    .find((file) => new RegExp(`^task-${number}-.+\\.json$`).test(file));
}

function readTaskOf(project, groupId, number) {
  const file = taskFileOf(project, groupId, number);
  return JSON.parse(fs.readFileSync(path.join(mcpTaskGroupDir(project, groupId), file), 'utf8'));
}

function causeFixture(prefix) {
  const project = fixture(prefix);
  const groupId = addGroup(project, '발생 원인');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '기존 구현', batch: 'b1', spec: '기준', assignee: WORKER,
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '기존 판정', batch: 'b1', kind: 'review', spec: '기준', depends_on: [],
  }, MANAGER);
  return { project, groupId };
}

function causeSnapshot(dir) {
  return fs.readdirSync(dir).sort().map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8'), fs.statSync(path.join(dir, file)).mtimeMs]);
}

for (const [label, value, expected] of [
  ['0', 0, 'caused_by 는 양의 정수 review 번호여야 합니다.'],
  ['-3', -3, 'caused_by 는 양의 정수 review 번호여야 합니다.'],
  ['문자열', '2', 'caused_by 는 양의 정수 review 번호여야 합니다.'],
  ['소수', 1.5, 'caused_by 는 양의 정수 review 번호여야 합니다.'],
  ['불리언', true, 'caused_by 는 양의 정수 review 번호여야 합니다.'],
  ['없는 번호', 999, null],
  ['work 번호', 1, 'caused_by #1 은 review 가 아니라 work 입니다.'],
]) {
  test(`G8: caused_by ${label}는 add·update에서 거절하고 옛 그룹을 승격하지 않습니다`, () => {
    const { project, groupId } = causeFixture('task-mcp-g8-cause-invalid-');
    const modern = mcpTaskGroupDir(project, groupId);
    const legacy = legacyTaskGroupDir(project, groupId);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.renameSync(modern, legacy);
    const before = causeSnapshot(legacy);
    const message = expected || `caused_by 에 그룹 "${groupId}" 에 없는 번호가 있습니다: #999.`;
    for (const [name, args] of [
      ['task_add', { content: '수정', batch: 'b1', kind: 'feedback', spec: '기준', assignee: WORKER }],
      ['task_update', { number: 1, field: 'result', mode: 'replace', text: '저장 금지' }],
    ]) {
      const output = callToolError(PROJECT_SERVER, project, name, { group_id: groupId, ...args, caused_by: value }, WORKER);
      assert.ok(output.includes(message), output);
      assert.equal(fs.existsSync(modern), false);
      assert.deepEqual(causeSnapshot(legacy), before);
      assert.equal(fs.existsSync(path.join(project, '.task-mcp-fake-cmux.jsonl')), false);
    }
  });
}

test('G8: 존재하는 review 원인은 저장하고 null·생략은 기존 동작을 유지합니다', () => {
  const { project, groupId } = causeFixture('task-mcp-g8-cause-valid-');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '판정에 따른 수정', batch: 'b1', kind: 'feedback', spec: '기준', assignee: WORKER, caused_by: 2,
  }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 3).caused_by, 2);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, caused_by: 2 }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).caused_by, 2);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, caused_by: null, tag: 'null 무시' }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).caused_by, 2);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '원인 없는 일', batch: 'b1', spec: '기준', assignee: WORKER, caused_by: null,
  }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 4).caused_by, null);
  assert.equal(readTaskOf(project, groupId, 2).caused_by, null);
});

test('G8: 저장돼 있던 잘못된 원인은 읽거나 다른 칸을 고칠 때 검사하지 않습니다', () => {
  const { project, groupId } = causeFixture('task-mcp-g8-cause-stored-');
  const file = path.join(mcpTaskGroupDir(project, groupId), taskFileOf(project, groupId, 1));
  const record = readTaskOf(project, groupId, 1);
  fs.writeFileSync(file, `${JSON.stringify({ ...record, caused_by: 999, assignee: OTHER }, null, 2)}\n`);
  const before = fs.readFileSync(file, 'utf8');
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, MANAGER), /caused_by: #999/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, tag: '옛 값 유지' }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).caused_by, 999);
  assert.equal(readTaskOf(project, groupId, 1).assignee, OTHER);
});

test('G8: 명단에서 빠진 원래 담당자도 자동 feedback의 draft에는 보존합니다', () => {
  const { project, groupId } = causeFixture('task-mcp-g8-feedback-removed-');
  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId, members: [{ name: 'WRKR3', remove: true }],
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, outcome: 'reject', rejected: [1] }, MANAGER);
  const feedback = readTaskOf(project, groupId, 3);
  assert.equal(feedback.status, 'draft');
  assert.equal(feedback.assignee, WORKER);
  assert.equal(feedback.caused_by, 2);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 3, assignee: WORKER,
  }, MANAGER), /명단에 없습니다/);
});

// review 의 기본 선행은 여기에 test 가 더 들어갑니다(백로그 10). 그 쪽은 g9 가 봅니다.
test('G8: test 는 같은 배치의 work·feedback 전부를 선행으로 받는다', () => {
  const project = fixture('task-mcp-g8-depends-');
  const groupId = addGroup(project, '기본 선행');
  const work = (content, batch) => callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content, batch, spec: '받아들임 조건', assignee: WORKER,
  }, MANAGER);
  work('b1 구현 하나', 'b1');
  work('b1 구현 둘', 'b1');
  work('b2 구현', 'b2');

  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 검증', batch: 'b1', kind: 'test', spec: '검사 항목',
  }, MANAGER);
  assert.deepEqual(readTaskOf(project, groupId, 4).depends_on, [1, 2]);

  // 뒤늦게 더한 work 는 그 뒤에 만든 test 에만 들어간다.
  work('b1 구현 셋', 'b1');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 재검증', batch: 'b1', kind: 'test', spec: '검사 항목',
  }, MANAGER);
  assert.deepEqual(readTaskOf(project, groupId, 6).depends_on, [1, 2, 5]);
  assert.deepEqual(readTaskOf(project, groupId, 4).depends_on, [1, 2]);

  // 명시로 준 depends_on 은 그대로 쓴다.
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b2 검증', batch: 'b2', kind: 'test', spec: '검사 항목', depends_on: [3],
  }, MANAGER);
  assert.deepEqual(readTaskOf(project, groupId, 7).depends_on, [3]);
  console.log('test_default_depends_on=batch work+feedback');
});

test('G8: review가 거절하면 feedback 태스크가 draft로 서고 두 번 만들지 않는다', () => {
  const project = fixture('task-mcp-g8-feedback-');
  const groupId = addGroup(project, '거절 흐름');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '업로드 상한', batch: 'b2', tag: 'api', spec: '받아들임 조건', assignee: WORKER,
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, WORKER);

  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b2 판정', batch: 'b2', kind: 'review', spec: '판정 기준',
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 2, field: 'result', mode: 'replace', text: '상한 값이 계약과 다릅니다.',
  }, MANAGER);

  const rejected = callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 2, outcome: 'reject', rejected: [1],
  }, MANAGER);
  assert.match(rejected, /거절에 따라 feedback 태스크 #3 를 draft 로 만들었습니다\./);

  const feedback = readTaskOf(project, groupId, 3);
  assert.equal(feedback.kind, 'feedback');
  assert.equal(feedback.status, 'draft');
  assert.equal(feedback.batch, 'b2');
  assert.equal(feedback.content, '업로드 상한 수정');
  assert.equal(feedback.description, '상한 값이 계약과 다릅니다.');
  assert.equal(feedback.spec, '');
  assert.equal(feedback.assignee, WORKER);
  assert.deepEqual(feedback.target, [1]);
  assert.equal(feedback.caused_by, 2);
  assert.deepEqual(feedback.depends_on, []);
  assert.match(taskFileOf(project, groupId, 3), /^task-3-b2-feedback-draft-\[api\]-/);

  // 같은 review 가 같은 번호를 다시 거절해도 feedback 은 하나뿐이다.
  const again = callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 2, outcome: 'reject', rejected: [1],
  }, MANAGER);
  assert.doesNotMatch(again, /feedback 태스크 #4/);
  assert.equal(taskFileOf(project, groupId, 4), undefined);

  // outcome 값은 종류마다 다르다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, outcome: 'fail' }, MANAGER),
    /review 의 outcome 은 approve \| reject 중 하나여야 합니다/,
  );

  // 보고는 가짜 어댑터로만 갔습니다 — 실제 cmux 를 부르지 않았다는 근거입니다.
  const fakeLog = path.join(project, '.task-mcp-fake-cmux.jsonl');
  assert.equal(fs.existsSync(fakeLog), true, '보고가 가짜 기록에 남아야 실제 cmux 를 안 부른 것입니다.');
  assert.ok(fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).length >= 1);
  console.log('reject_creates_feedback=1');
  console.log('reject_twice_creates=0');
});

test('G8: 목록은 배치별로 접어 보이고 배치 없는 옛 태스크를 따로 묶는다', () => {
  const project = fixture('task-mcp-g8-render-');
  const groupId = '2026-08-01-배치-렌더';
  const dir = mcpTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task-1-pending-[old]-옛-태스크.json'), `${JSON.stringify({
    number: 1, content: '옛 태스크', tag: 'old', status: 'pending', owner: MANAGER, assignee: WORKER,
    group_id: groupId, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);
  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId,
    members: [
      { name: 'MNGR3', surface: MANAGER, roles: ['manager'] },
      { name: 'WRKR3', surface: WORKER, roles: ['worker'] },
    ],
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 구현', batch: 'b1', spec: '조건', assignee: WORKER,
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b2 구현', batch: 'b2', spec: '조건', assignee: WORKER,
  }, MANAGER);

  const list = callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId, all: true }, MANAGER);
  const lines = list.split('\n');
  assert.equal(lines.findIndex((line) => line === '  b1') > 0, true);
  assert.equal(lines.findIndex((line) => line === '  b2') > 0, true);
  assert.equal(lines.findIndex((line) => line === '  (배치 없음)') > 0, true);
  // 배치 없는 묶음은 마지막이다.
  assert.ok(lines.findIndex((line) => line === '  (배치 없음)') > lines.findIndex((line) => line === '  b2'));
  assert.match(list, /\[ \] 2\. work b1 구현 \(pending\)/);
  assert.match(list, /\[ \] 1\. work \[old\] 옛 태스크 \(pending\)/);
  console.log('batch_sections=b1,b2,(배치 없음)');
});

test('G8: 옛 꼴 파일은 배치를 주면 새 꼴로 개명되고 안 주면 옛 이름을 지킨다', () => {
  const project = fixture('task-mcp-g8-rename-');
  const groupId = '2026-08-01-개명';
  const dir = legacyTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  // 옛 그룹에도 명단 검사가 걸리므로(백로그 9) 고치는 패널을 명단에 둡니다.
  fs.writeFileSync(path.join(dir, 'TASK_GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: groupId,
    about: '',
    status: 'pending',
    campaign: null,
    members: [{ name: 'MNGR3', surface: MANAGER, ref: null, roles: ['manager'], scope: '', session: null }],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'task-1-pending-[ui]-옛-제목.json'), `${JSON.stringify({
    number: 1, content: '옛 제목', tag: 'ui', status: 'pending', owner: MANAGER, assignee: WORKER,
    group_id: groupId, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  }, null, 2)}\n`);

  // 배치 없이 고치면 옛 이름을 그대로 둔다 — 배치를 지어내지 않는다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, content: '고친 제목' }, MANAGER);
  assert.equal(taskFileOf(project, groupId, 1), 'task-1-pending-[ui]-고친-제목.json');

  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, batch: 'b3' }, MANAGER);
  assert.equal(taskFileOf(project, groupId, 1), 'task-1-b3-work-pending-[ui]-고친-제목.json');
  assert.equal(readTaskOf(project, groupId, 1).batch, 'b3');
  assert.equal(readTaskOf(project, groupId, 1).kind, 'work');
  console.log('legacy_rename_needs_batch=true');
});

test('G8: 도구가 전이 표 밖 호출을 거절한다', () => {
  const project = fixture('task-mcp-g8-transition-');
  const groupId = addGroup(project, '전이 거절');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'spec 없는 일', batch: 'b1', assignee: WORKER,
  }, MANAGER);

  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'pending' }, MANAGER),
    /spec 이 비어 있어 pending 으로 올릴 수 없습니다/,
  );
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'in_progress' }, MANAGER),
    /in_progress 는 task_next 로만 갑니다/,
  );

  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'spec', mode: 'replace', text: '받아들임 조건',
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'pending' }, MANAGER);
  assert.equal(readTaskOf(project, groupId, 1).status, 'pending');
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, MANAGER),
    /pending 에서 completed 로는 갈 수 없습니다/,
  );

  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, WORKER);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, WORKER);
  assert.match(
    callToolError(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, tag: '새 태그' }, MANAGER),
    /completed 태스크는 바꿀 수 없습니다/,
  );
  console.log('tool_transition_rejects=4');
});
