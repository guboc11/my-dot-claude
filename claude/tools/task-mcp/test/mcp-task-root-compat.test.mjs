import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { renderMarkdownRecord } from '../lib.mjs';
import {
  LEGACY_SERVER,
  PROJECT_SERVER,
  callTool,
  callToolError,
  legacyTaskGroupDir,
  legacyTaskRoot,
  makeProject,
  mcpTaskGroupDir,
  mcpTaskRoot,
  removeProject,
} from './helpers.mjs';

const projects = [];
// 이 파일의 쓰기도 보고를 냅니다. 실제 cmux 로 나가지 않게 가짜 어댑터를 켭니다.
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

function treeManifest(root, dir = root, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) treeManifest(root, full, out);
    else out.push(`${relative}\t${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
  }
  return out;
}

function treeChecksum(root) {
  return createHash('sha256').update(treeManifest(root).join('\n')).digest('hex');
}

function planBody(marker) {
  return ['왜', '스펙', '합의', '단계', '검증', '미결']
    .map((title) => `## ${title}\n${marker} ${title}`)
    .join('\n\n');
}

function seedGroup(root, groupId, marker) {
  const dir = path.join(root, groupId);
  const timestamp = '2026-08-16T00:00:00.000Z';
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: `${marker} 그룹`,
    about: `${marker} 설명`,
    status: 'pending',
    campaign: null,
    worker: { name: 'WRKR3', surface: 'surface:worker' },
    manager: null,
    created_at: timestamp,
    updated_at: timestamp,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `task-1-pending-[root]-${marker}.json`), `${JSON.stringify({
    number: 1,
    content: `${marker} 태스크`,
    tag: 'root',
    description: `${marker} 태스크 설명`,
    activeForm: `${marker} 진행 중`,
    instruction: `${marker} 지시`,
    depends_on: [],
    priority: 0,
    status: 'pending',
    owner: 'surface:owner',
    assignee: 'surface:worker',
    group_id: groupId,
    created_at: timestamp,
    updated_at: timestamp,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'notes', `note-1-${marker}-노트.md`), renderMarkdownRecord({
    number: 1,
    title: `${marker} 노트`,
    author: 'surface:author',
    created_at: timestamp,
    updated_at: timestamp,
  }, `${marker} 노트 본문`));
  fs.writeFileSync(path.join(dir, 'plans', `plan-1-${marker}-계획.md`), renderMarkdownRecord({
    number: 1,
    title: `${marker} 계획`,
    author: 'surface:author',
    created_at: timestamp,
    updated_at: timestamp,
  }, planBody(marker)));
  fs.writeFileSync(path.join(dir, 'NOTES.md'), `# ${marker} 옛 노트\n\n${marker} NOTES 보존\n`);
  fs.writeFileSync(path.join(dir, 'extra', 'keep.txt'), `${marker} 보존 파일\n`);
  return dir;
}

function taskFile(dir, number = 1) {
  return fs.readdirSync(dir).find((file) => new RegExp(`^task-${number}-.+\\.json$`).test(file));
}

test('저장 뿌리: 새 그룹과 새 태스크·노트·계획서는 .claude/mcp-task에만 생긴다', () => {
  const project = fixture('task-mcp-root-new-writes-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '새 뿌리 쓰기' });
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.ok(groupId);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '새 태스크', batch: 'b1', spec: '받아들임 조건',
  });
  callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: '새 노트',
    body: '새 노트 본문',
  });
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '새 계획' });

  const dir = mcpTaskGroupDir(project, groupId);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(legacyTaskRoot(project)), false);
  assert.equal(fs.existsSync(path.join(dir, 'TASK_GROUP.json')), true);
  assert.ok(taskFile(dir));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['note-1-새-노트.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plans')), ['plan-1-새-계획.md']);
  console.log('new_writes_root=.claude/mcp-task');
  console.log('legacy_write_paths=0');
});

test('저장 뿌리: 옛 자리만 있는 그룹은 모든 읽기에서 보이고 두 tree를 바꾸지 않는다', () => {
  const project = fixture('task-mcp-root-legacy-read-');
  const groupId = '2026-08-01-legacy-read';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '옛읽기');
  const before = treeChecksum(legacyDir);

  assert.match(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }), /옛읽기 그룹/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_list', { all: true }), new RegExp(groupId));
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }), /옛읽기 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId, all: true }), /옛읽기 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_note_get', { group_id: groupId, number: 1 }), /옛읽기 노트 본문/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_note_list', { group_id: groupId }), /옛읽기 노트/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_plan_get', { group_id: groupId, number: 1 }), /옛읽기 스펙/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_plan_list', { group_id: groupId }), /옛읽기 계획/);

  assert.equal(treeChecksum(legacyDir), before);
  assert.equal(fs.existsSync(mcpTaskRoot(project)), false);
  console.log('legacy_read_tree_unchanged=true');
  console.log('legacy_read_new_tree_writes=0');
});

test('저장 뿌리: 옛 그룹 수정은 그룹 전체를 새 자리로 승격하고 옛 tree를 그대로 둔다', () => {
  const project = fixture('task-mcp-root-promote-');
  const groupId = '2026-08-01-promote';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '승격전');
  const before = treeChecksum(legacyDir);

  callTool(PROJECT_SERVER, project, 'task_group_update', { group_id: groupId, title: '승격 후 그룹' });
  // 태스크를 고치는 패널은 명단에 있어야 합니다(백로그 9). seedGroup 의 옛 레코드에 적힌 워커로 부릅니다.
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, content: '승격 후 태스크' }, 'surface:worker');
  callTool(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId, number: 1, field: 'body', mode: 'replace', text: '승격 후 노트',
  });
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'spec',
    mode: 'replace',
    text: '승격 후 스펙',
  });

  assert.equal(treeChecksum(legacyDir), before);
  const promotedDir = mcpTaskGroupDir(project, groupId);
  assert.equal(fs.existsSync(path.join(promotedDir, 'extra', 'keep.txt')), true);
  assert.match(fs.readFileSync(path.join(promotedDir, 'NOTES.md'), 'utf8'), /승격전 NOTES 보존/);
  // 옛 이름으로 심은 레코드는 승격 사본에서 쓰기가 닿을 때 새 이름으로 옮겨 간다(SPEC 5-7).
  assert.equal(fs.existsSync(path.join(promotedDir, 'GROUP.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(promotedDir, 'TASK_GROUP.json'), 'utf8')).title, '승격 후 그룹');
  assert.match(fs.readFileSync(path.join(promotedDir, taskFile(promotedDir)), 'utf8'), /승격 후 태스크/);
  assert.match(fs.readFileSync(path.join(promotedDir, 'notes', 'note-1-승격전-노트.md'), 'utf8'), /승격 후 노트/);
  assert.match(fs.readFileSync(path.join(promotedDir, 'plans', 'plan-1-승격전-계획.md'), 'utf8'), /승격 후 스펙/);
  console.log('legacy_promotion_copies_whole_group=true');
  console.log('legacy_tree_unchanged_after_updates=true');
});

test('저장 뿌리: 옛 그룹의 task_next는 고를 태스크가 있을 때만 승격해 새 사본을 바꾼다', () => {
  const project = fixture('task-mcp-root-next-promote-');
  const groupId = '2026-08-01-next-promote';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '큐승격');
  const before = treeChecksum(legacyDir);

  const output = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, 'surface:worker');
  assert.match(output, /#1 \[~\] work \(in_progress\)/);
  assert.equal(treeChecksum(legacyDir), before);
  const promotedDir = mcpTaskGroupDir(project, groupId);
  assert.match(taskFile(promotedDir), /^task-1-in_progress-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(promotedDir, 'TASK_GROUP.json'), 'utf8')).status, 'in_progress');
  console.log('task_next_promotes_before_write=true');
  console.log('task_next_legacy_tree_unchanged=true');
});

test('저장 뿌리: 호환 symlink에서는 동결 서버와 현재 서버의 쓰기가 서로 보인다', () => {
  const project = fixture('task-mcp-root-symlink-');
  const currentWorker = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(mcpTaskRoot(project), { recursive: true });
  fs.symlinkSync('mcp-task', legacyTaskRoot(project), 'dir');

  const legacyAdd = callTool(LEGACY_SERVER, project, 'task_add', {
    group: 'symlink bridge',
    content: '동결 서버가 쓴 태스크',
  }, 'surface:legacy');
  const groupId = /group_id="([^"]+)"/.exec(legacyAdd)?.[1];
  assert.ok(groupId);
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }), /동결 서버가 쓴 태스크/);

  // 현재 서버로 쓰려면 명단에 있어야 합니다(백로그 9). 옛 GROUP.json 은 동결 서버가 계속 읽어야 하므로
  // 도구로 갱신하지 않고 새 이름 레코드를 따로 두어 현재 서버만 그것을 보게 합니다.
  fs.writeFileSync(path.join(mcpTaskGroupDir(project, groupId), 'TASK_GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: groupId,
    about: '',
    status: 'pending',
    campaign: null,
    members: [{ name: 'WRKR-CURRENT', surface: currentWorker, ref: null, roles: ['worker'], scope: '', session: null }],
    created_at: '2026-09-18T00:00:00.000Z',
    updated_at: '2026-09-18T00:00:00.000Z',
  }, null, 2)}\n`);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '현재 서버가 쓴 태스크',
    batch: 'b1',
    spec: '받아들임 조건',
    assignee: currentWorker,
  }, currentWorker);
  const legacyList = callTool(LEGACY_SERVER, project, 'task_list', { group_id: groupId, all: true });
  assert.match(legacyList, /동결 서버가 쓴 태스크/);
  assert.match(legacyList, /현재 서버가 쓴 태스크/);
  assert.equal(fs.realpathSync(legacyTaskRoot(project)), fs.realpathSync(mcpTaskRoot(project)));
  console.log('symlink_legacy_to_current_visible=true');
  console.log('symlink_current_to_legacy_visible=true');
});

test('저장 뿌리: 새·옛 그룹은 합집합이고 같은 ID는 새 자리를 한 번만 쓴다', () => {
  const project = fixture('task-mcp-root-union-');
  const newOnly = '2026-08-01-new-only';
  const legacyOnly = '2026-08-01-legacy-only';
  const duplicate = '2026-08-01-duplicate';
  seedGroup(mcpTaskRoot(project), newOnly, '새전용');
  seedGroup(legacyTaskRoot(project), legacyOnly, '옛전용');
  seedGroup(mcpTaskRoot(project), duplicate, '새우선');
  seedGroup(legacyTaskRoot(project), duplicate, '옛후순위');

  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(list, new RegExp(newOnly));
  assert.match(list, new RegExp(legacyOnly));
  assert.equal((list.match(new RegExp(`\\[${duplicate}\\]`, 'g')) || []).length, 1);
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: duplicate, number: 1 }), /새우선 태스크/);
  console.log('new_legacy_group_union=true');
  console.log('duplicate_group_precedence=new');
});

// 거절된 요청은 옛 그룹을 새 자리로 승격시키지 않습니다(리뷰 29). 승격은 쓰기 직전에만 합니다.
// 경우마다 임시 프로젝트를 따로 씁니다 — 앞 요청이 만든 사본에 가려지면 검사가 가짜로 통과합니다.
test('저장 뿌리: 거절된 옛 그룹 요청은 사본도 보고도 남기지 않는다', () => {
  const MEMBER = '11111111-1111-4111-8111-111111111111';
  const OTHER_HOLDER = '22222222-2222-4222-8222-222222222222';
  const STRANGER = '66666666-6666-4666-8666-666666666666';
  const groupId = '2026-08-01-거절-승격';

  const seedLegacyWithMember = (prefix) => {
    const project = fixture(prefix);
    const dir = legacyTaskGroupDir(project, groupId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TASK_GROUP.json'), `${JSON.stringify({
      id: groupId,
      title: groupId,
      about: '',
      status: 'pending',
      campaign: null,
      members: [{ name: 'MNGR', surface: MEMBER, ref: null, roles: ['manager', 'worker'], scope: '', session: null }],
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'task-1-pending-옛-일.json'), `${JSON.stringify({
      number: 1, content: '옛 일', status: 'pending', owner: MEMBER, assignee: MEMBER, group_id: groupId,
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    }, null, 2)}\n`);
    // 남이 진행 중인 태스크입니다. 반환 거절을 재현할 때 씁니다.
    fs.writeFileSync(path.join(dir, 'task-2-in_progress-남의-일.json'), `${JSON.stringify({
      number: 2, content: '남의 일', status: 'in_progress', owner: MEMBER, assignee: OTHER_HOLDER, group_id: groupId,
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    }, null, 2)}\n`);
    return { project, before: treeChecksum(dir) };
  };


  const refusals = [
    ['명단 밖 add', STRANGER, 'task_add', { group_id: groupId, content: '몰래', batch: 'b1', spec: '기준' }, /쓸 수 없습니다/],
    ['명단 밖 update', STRANGER, 'task_update', { group_id: groupId, number: 1, priority: 3 }, /쓸 수 없습니다/],
    ['없는 선행 add', MEMBER, 'task_add', { group_id: groupId, content: '새 일', batch: 'b1', spec: '기준', assignee: MEMBER, depends_on: [99] }, /없는 번호가 있습니다: #99/],
    ['없는 선행 update', MEMBER, 'task_update', { group_id: groupId, number: 1, depends_on: [99] }, /없는 번호가 있습니다: #99/],
    // 전이 거절도 승격 뒤가 아니라 읽기 자리에서 끝나야 합니다.
    ['잘못된 전이', MEMBER, 'task_update', { group_id: groupId, number: 1, status: 'completed' }, /pending 에서 completed 로는 갈 수 없습니다/],
    // 편집 거절도 같습니다 — 찾지 못하는 old 는 파일을 쓰기 전에 걸립니다.
    ['편집 실패', MEMBER, 'task_update', { group_id: groupId, number: 1, field: 'memo', mode: 'edit', old: '없는 글', new: '새 글' }, /old 를 찾지 못했습니다/],
    // 남의 일을 반환하려는 요청도 사본을 남기지 않습니다.
    ['남의 반환', MEMBER, 'task_update', { group_id: groupId, number: 2, status: 'pending', assignee: MEMBER }, /담당자 본인만 할 수 있습니다/],
    // task_add 의 인자 검사도 승격보다 앞이어야 합니다(리뷰 28).
    ['잘못된 target', MEMBER, 'task_add', { group_id: groupId, content: '새 일', batch: 'b1', spec: '기준', assignee: MEMBER, target: [0] }, /target은 양의 정수 태스크 번호 배열이어야 합니다/],
    ['잘못된 priority', MEMBER, 'task_add', { group_id: groupId, content: '새 일', batch: 'b1', spec: '기준', assignee: MEMBER, priority: '높음' }, /priority는 정수여야 합니다/],
  ];

  for (const [label, surface, tool, args, pattern] of refusals) {
    const { project, before: checksum } = seedLegacyWithMember(`task-mcp-root-refuse-${tool}-`);
    assert.match(callToolError(PROJECT_SERVER, project, tool, args, surface), pattern, label);
    assert.equal(fs.existsSync(mcpTaskGroupDir(project, groupId)), false, `${label}: 새 자리에 사본이 생겼습니다.`);
    assert.equal(treeChecksum(legacyTaskGroupDir(project, groupId)), checksum, `${label}: 옛 자리가 바뀌었습니다.`);
    assert.equal(fs.existsSync(path.join(project, '.task-mcp-fake-cmux.jsonl')), false, `${label}: 보고가 나갔습니다.`);
  }

  // 대조군 — 통과하는 요청은 예전처럼 승격하고 옛 자리는 그대로 둡니다.
  const { project, before: checksum } = seedLegacyWithMember('task-mcp-root-refuse-ok-');
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, priority: 5 }, MEMBER);
  assert.equal(fs.existsSync(mcpTaskGroupDir(project, groupId)), true, '통과한 요청은 승격해야 합니다.');
  assert.equal(treeChecksum(legacyTaskGroupDir(project, groupId)), checksum, '옛 자리는 그대로 둡니다.');

  // task_add 대조군 — 인자가 멀쩡하면 옛 그룹 전체가 승격하고 태스크가 새 자리에 생깁니다.
  const added = seedLegacyWithMember('task-mcp-root-add-ok-');
  callTool(PROJECT_SERVER, added.project, 'task_add', {
    group_id: groupId, content: '새 일', batch: 'b1', spec: '기준', assignee: MEMBER, target: [1], priority: 2,
  }, MEMBER);
  const addedDir = mcpTaskGroupDir(added.project, groupId);
  assert.equal(fs.existsSync(addedDir), true, '정상 추가는 승격해야 합니다.');
  assert.ok(taskFile(addedDir, 3), '새 태스크가 새 자리에 생겨야 합니다.');
  assert.equal(treeChecksum(legacyTaskGroupDir(added.project, groupId)), added.before, '옛 자리는 그대로 둡니다.');
  console.log(`refused_requests_promote_nothing=${refusals.length}`);
  console.log('accepted_request_still_promotes=true');
});
