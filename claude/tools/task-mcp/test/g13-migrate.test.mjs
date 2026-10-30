// G13 — 이관 스크립트.
// 설계: .claude/plans/2026-09-18-task-mcp-stack-model-overhaul/SPEC.md 6절 · 7절.
//
// 임시 폴더에 옛 구조를 세우고 dry-run → apply → 두 번째 apply 0건을 봅니다.
// 실물 장부는 건드리지 않고, 실행 기록도 임시 폴더로 돌려 레포에 파일을 남기지 않습니다.
// 03 ~ 05 의 검사는 B6-2 에서 이 파일에 더합니다.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { makeProject, mcpTaskRoot, removeProject } from './helpers.mjs';

const MIGRATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrate');
const WORKER_UUID = '22222222-2222-4222-8222-222222222222';

const projects = [];

after(() => {
  for (const project of projects) removeProject(project);
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function runMigrate(script, project, args = []) {
  const result = spawnSync(process.execPath, [path.join(MIGRATE, script), ...args], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      TASK_MCP_MIGRATE_LOG_DIR: path.join(project, 'migrate-log'),
    },
    encoding: 'utf8',
  });
  const stdout = result.stdout || '';
  // 집계 줄은 dry-run 이 「처리 예정」, --apply 가 「처리」이고 수의 뜻은 같습니다.
  const summary = /대상 (\d+)건 · 처리(?: 예정)? (\d+)건 · 제외 (\d+)건/.exec(stdout);
  const lines = stdout.split('\n');
  return {
    status: result.status,
    stdout,
    stderr: result.stderr || '',
    planned: lines.filter((line) => /^\[(예정|실행)\]/.test(line)).length,
    skipLines: lines.filter((line) => line.startsWith('[제외]')).length,
    errorLines: lines.filter((line) => line.startsWith('[오류]')).length,
    cleanupLines: lines.filter((line) => line.startsWith('[뒷정리]')).length,
    targets: summary ? Number(summary[1]) : null,
    processed: summary ? Number(summary[2]) : null,
    excluded: summary ? Number(summary[3]) : null,
  };
}

// 대상 = 처리 + 제외 가 두 모드에서 같은 뜻으로 성립하는지 봅니다(백로그 3).
function assertTally(result, label) {
  assert.equal(result.status, 0, `${label}: 종료 코드가 0 이어야 합니다.`);
  assert.notEqual(result.targets, null, `${label}: 집계 줄을 읽지 못했습니다.\n${result.stdout}`);
  assert.equal(result.targets, result.processed + result.excluded,
    `${label}: 대상은 처리와 제외의 합이어야 합니다.\n${result.stdout}`);
  assert.equal(result.planned, result.processed, `${label}: 출력 줄 수가 처리 수와 같아야 합니다.`);
  assert.equal(result.skipLines + result.errorLines, result.excluded,
    `${label}: 제외마다 이유 한 줄이 있어야 합니다.\n${result.stdout}`);
}

function writeLegacyRecord(dir, id, extra) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GROUP.json'), `${JSON.stringify({
    id,
    title: `${id} 제목`,
    about: '',
    status: 'pending',
    campaign: null,
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
    ...extra,
  }, null, 2)}\n`);
}

function readRecord(dir, name = 'TASK_GROUP.json') {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

// 옛 구조 — 독립 그룹 셋과 캠페인 하나(그 아래 그룹 하나).
function seedLegacy(project) {
  const a = path.join(mcpTaskRoot(project), '2026-08-01-worker-uuid');
  const b = path.join(mcpTaskRoot(project), '2026-08-02-worker-ref');
  const c = path.join(mcpTaskRoot(project), '2026-08-03-manager-only');
  writeLegacyRecord(a, '2026-08-01-worker-uuid', {
    worker: { name: 'WRKR301', surface: WORKER_UUID },
    manager: { name: 'MNGR3', surface: 'surface:32' },
  });
  writeLegacyRecord(b, '2026-08-02-worker-ref', {
    worker: { name: 'WRKR3', surface: 'surface:90' },
    manager: null,
  });
  writeLegacyRecord(c, '2026-08-03-manager-only', {
    worker: null,
    manager: { name: 'MNGR3', surface: 'surface:87' },
  });

  const campaign = path.join(project, '.claude', 'campaigns', '2026-08-16-보기-캠페인');
  const inCampaign = path.join(campaign, '2026-08-20-캠페인-그룹');
  writeLegacyRecord(inCampaign, '2026-08-20-캠페인-그룹', {
    worker: { name: 'WRKR300', surface: 'surface:71' },
    manager: { name: 'MNGR3', surface: 'surface:32' },
    campaign: '2026-08-16-보기-캠페인',
  });
  fs.mkdirSync(path.join(campaign, 'campaign-context'), { recursive: true });
  return { a, b, c, campaign, inCampaign };
}

function addIgnoreLines(project) {
  fs.writeFileSync(path.join(project, '.gitignore'), '.claude/mcp-task/\n.claude/mcp-task-campaign/\n.claude/mcp-task-backlog/\n');
}

test('G13-01: dry-run 은 아무것도 바꾸지 않고 옮길 것만 센다', () => {
  const project = fixture('task-mcp-g13-01-dry-');
  const dirs = seedLegacy(project);

  const dry = runMigrate('01-group-record.mjs', project);
  assertTally(dry, '01 dry-run');
  assert.equal(dry.targets, 5, '그룹 넷과 캠페인 자료 폴더 하나를 훑습니다.');
  assert.equal(dry.processed, 4, '독립 그룹 셋과 캠페인 아래 그룹 하나입니다.');
  assert.equal(dry.excluded, 1, '레코드가 없는 campaign-context 는 제외입니다.');
  assert.match(dry.stdout, /\[제외\] .*campaign-context  그룹 레코드가 없습니다/);
  assert.match(dry.stdout, /dry-run 입니다\. 실제로 옮기려면 --apply 를 붙이십시오\./);

  for (const dir of [dirs.a, dirs.b, dirs.c, dirs.inCampaign]) {
    assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'TASK_GROUP.json')), false);
  }
  assert.equal(fs.existsSync(path.join(project, 'migrate-log')), false, 'dry-run 은 기록도 남기지 않습니다.');
  console.log(`g13_01_dry_targets=${dry.targets}`);
  console.log('g13_01_dry_changes=0');
});

test('G13-01: apply 는 이름을 옮기고 명단을 members 로 바꾼다', () => {
  const project = fixture('task-mcp-g13-01-apply-');
  const dirs = seedLegacy(project);
  addIgnoreLines(project);

  const applied = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(applied, '01 apply');
  assert.equal(applied.targets, 5);
  assert.equal(applied.processed, 4);

  for (const dir of [dirs.a, dirs.b, dirs.c, dirs.inCampaign]) {
    assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'TASK_GROUP.json')), true);
  }

  // UUID 는 surface 에 남고 surface:N 은 ref 로 옮겨 갑니다(SPEC 3-1).
  const a = readRecord(dirs.a);
  assert.equal(a.worker, undefined);
  assert.equal(a.manager, undefined);
  assert.deepEqual(a.members, [
    { name: 'MNGR3', surface: '', ref: 'surface:32', roles: ['manager'], scope: '', session: null },
    { name: 'WRKR301', surface: WORKER_UUID, ref: null, roles: ['worker'], scope: '', session: null },
  ]);
  assert.deepEqual(readRecord(dirs.b).members.map((m) => [m.name, m.roles]), [['WRKR3', ['worker']]]);
  assert.deepEqual(readRecord(dirs.c).members.map((m) => [m.name, m.roles]), [['MNGR3', ['manager']]]);
  assert.equal(readRecord(dirs.inCampaign).campaign, '2026-08-16-보기-캠페인');

  // 기록은 한 줄이 한 건입니다.
  const logs = fs.readdirSync(path.join(project, 'migrate-log'));
  assert.equal(logs.length, 1);
  const entries = fs.readFileSync(path.join(project, 'migrate-log', logs[0]), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.equal(entry.action, 'rename');
    assert.match(entry.from, /GROUP\.json$/);
    assert.match(entry.to, /TASK_GROUP\.json$/);
    assert.ok(entry.at);
  }

  // 두 번째 실행은 훑는 수가 같고 처리가 0건이며 전부 이유가 붙은 제외로 갑니다.
  const again = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(again, '01 재실행');
  assert.equal(again.targets, 5, '대상 수는 두 실행에서 같습니다.');
  assert.equal(again.processed, 0);
  assert.equal(again.excluded, 5);
  assert.match(again.stdout, /이미 members 입니다 — 4건/);
  assert.match(again.stdout, /그룹 레코드가 없습니다 — 1건/);
  console.log('g13_01_apply_processed=4');
  console.log('g13_01_second_apply_processed=0');
});

test('G13-01: 두 이름이 함께 있으면 updated_at 이 늦은 쪽을 남긴다', () => {
  const project = fixture('task-mcp-g13-01-both-');
  const dir = path.join(mcpTaskRoot(project), '2026-08-04-둘-다');
  writeLegacyRecord(dir, '2026-08-04-둘-다', {
    title: '옛 쪽이 최신',
    updated_at: '2026-09-01T00:00:00.000Z',
    worker: { name: 'WRKR3', surface: WORKER_UUID },
  });
  fs.writeFileSync(path.join(dir, 'TASK_GROUP.json'), `${JSON.stringify({
    id: '2026-08-04-둘-다', title: '새 쪽이 오래됨', about: '', status: 'pending', campaign: null,
    members: [], created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
  }, null, 2)}\n`);

  const applied = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(applied, '01 둘 다 있음');
  assert.equal(applied.processed, 1);
  assert.match(applied.stdout, /둘 다 있음 — 옛 쪽이 최신/);
  assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), false);
  assert.equal(readRecord(dir).title, '옛 쪽이 최신');
  assert.deepEqual(readRecord(dir).members.map((m) => m.name), ['WRKR3']);

  // 반대 경우 — 새 쪽이 최신이면 옛 파일만 지웁니다.
  const other = path.join(mcpTaskRoot(project), '2026-08-05-새-쪽이-최신');
  writeLegacyRecord(other, '2026-08-05-새-쪽이-최신', { title: '옛 쪽', updated_at: '2026-08-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(other, 'TASK_GROUP.json'), `${JSON.stringify({
    id: '2026-08-05-새-쪽이-최신', title: '새 쪽', about: '', status: 'pending', campaign: null,
    members: [], created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  }, null, 2)}\n`);
  const second = runMigrate('01-group-record.mjs', project, ['--apply']);
  assert.match(second.stdout, /둘 다 있음 — 새 쪽이 최신/);
  assert.equal(fs.existsSync(path.join(other, 'GROUP.json')), false);
  assert.equal(readRecord(other).title, '새 쪽');
  console.log('g13_01_duplicate_resolution=updated_at');
});

test('G13-02: .gitignore 두 줄이 없으면 아무것도 옮기지 않고 멈춘다', () => {
  const project = fixture('task-mcp-g13-02-guard-');
  seedLegacy(project);

  const blocked = runMigrate('02-campaign-root.mjs', project, ['--apply']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /\.gitignore 에 두 줄이 없습니다\. 먼저 넣으십시오/);
  assert.match(blocked.stderr, /\.claude\/mcp-task-campaign\//);
  assert.match(blocked.stderr, /\.claude\/mcp-task-backlog\//);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'campaigns')), true);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'mcp-task-campaign')), false);

  // 한 줄만 있어도 막습니다.
  fs.writeFileSync(path.join(project, '.gitignore'), '.claude/mcp-task-campaign/\n');
  const half = runMigrate('02-campaign-root.mjs', project, ['--apply']);
  assert.equal(half.status, 1);
  assert.match(half.stderr, /\.claude\/mcp-task-backlog\//);
  assert.doesNotMatch(half.stderr, /mcp-task-campaign\/ ·/);
  console.log('g13_02_guard_exit=1');
  console.log('g13_02_guard_moves=0');
});

test('G13-02: 캠페인 뿌리를 옮기고 옛 자리에 상대 링크를 남긴다', () => {
  const project = fixture('task-mcp-g13-02-move-');
  seedLegacy(project);
  addIgnoreLines(project);
  const legacy = path.join(project, '.claude', 'campaigns');
  const fresh = path.join(project, '.claude', 'mcp-task-campaign');

  const dry = runMigrate('02-campaign-root.mjs', project);
  assertTally(dry, '02 dry-run');
  // 옮기기와 링크 걸기 두 건입니다. 옛 코드는 dry-run 에서 링크를 세지 않아 apply 와 수가
  // 달랐습니다(백로그 3).
  assert.equal(dry.processed, 2, 'dry-run 도 apply 와 같은 수를 세야 합니다.');
  assert.match(dry.stdout, /옛 경로에 링크 걸기/);
  assert.match(dry.stdout, /캠페인 1개/);
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), false);
  assert.equal(fs.existsSync(fresh), false);

  const applied = runMigrate('02-campaign-root.mjs', project, ['--apply']);
  assertTally(applied, '02 apply');
  assert.equal(applied.processed, dry.processed, 'dry-run 과 apply 의 처리 수가 같아야 합니다.');
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(legacy), 'mcp-task-campaign', '상대 링크여야 합니다.');
  assert.equal(fs.existsSync(path.join(legacy, '2026-08-16-보기-캠페인')), true, '옛 경로로도 읽힙니다.');

  const again = runMigrate('02-campaign-root.mjs', project, ['--apply']);
  assertTally(again, '02 재실행');
  assert.equal(again.targets, 2);
  assert.equal(again.processed, 0);
  assert.match(again.stdout, /캠페인 뿌리가 이미 새 자리에 있습니다/);
  assert.match(again.stdout, /옛 자리가 이미 링크입니다/);
  console.log('g13_02_apply_link=relative');
  console.log('g13_02_second_apply_processed=0');
});

test('G13-02: 옮긴 뒤에도 01 은 새 캠페인 경로에서 그룹을 찾는다', () => {
  const project = fixture('task-mcp-g13-order-');
  const dirs = seedLegacy(project);
  addIgnoreLines(project);

  runMigrate('02-campaign-root.mjs', project, ['--apply']);
  const applied = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(applied, '02 뒤의 01');
  assert.equal(applied.processed, 4, '독립 셋과 새 경로의 캠페인 그룹 하나입니다.');

  const moved = path.join(project, '.claude', 'mcp-task-campaign', '2026-08-16-보기-캠페인', '2026-08-20-캠페인-그룹');
  assert.equal(fs.existsSync(path.join(moved, 'TASK_GROUP.json')), true);
  assert.equal(fs.existsSync(path.join(dirs.inCampaign, 'GROUP.json')), false, '링크 너머의 같은 실물입니다.');
  console.log('g13_order_02_then_01=true');
});

// ── 03 · 04 · 05 — 캠페인 맥락 · 그룹 접두사 · 조사 폴더 ──────────────────────────

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// 옛 캠페인 세 가지 — 둘 다 있는 것 · 새 쪽만 있는 것 · 옛 쪽만 있는 것.
function seedCampaigns(project) {
  const root = path.join(project, '.claude', 'campaigns');
  const both = path.join(root, '2026-08-16-둘-다');
  write(path.join(both, 'campaign-context', 'INDEX.md'), '# 옛 차례\n\n- [주제-하나](주제-하나/)\n');
  write(path.join(both, 'campaign-context', 'notes', 'note-1-첫-메모.md'), '---\nnumber: 1\ntitle: 첫 메모\nauthor: surface:x\ncreated_at: 2026-08-16T00:00:00.000Z\nupdated_at: 2026-08-16T00:00:00.000Z\n---\n\n첫 메모 본문\n');
  write(path.join(both, 'campaign-context', '주제-하나', 'note-1-주제-노트.md'), '주제 노트 본문\n');
  write(path.join(both, 'main-context', 'README.md'), '# 둘 다\n\n상태: 진행 중\n\n설명 한 단락\n');
  write(path.join(both, 'main-context', 'INDEX.md'), '# 옛 main-context 차례\n\n- [direction](direction.md)\n');
  write(path.join(both, 'main-context', 'direction.md'), '# 방향\n\n[다른 문서](goal.md) 를 보십시오.\n');
  write(path.join(both, 'main-context', 'NOTES.md'), '# 옛 노트\n\n한 줄\n');

  const freshOnly = path.join(root, '2026-08-20-새-쪽만');
  write(path.join(freshOnly, 'campaign-context', 'INDEX.md'), '# 차례\n');
  write(path.join(freshOnly, 'campaign-context', 'MAIN_CONTEXT.md'), '# 새 쪽만\n\n상태: 진행 중\n');
  fs.mkdirSync(path.join(freshOnly, 'campaign-context', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(freshOnly, 'researches'), { recursive: true });

  const legacyOnly = path.join(root, '2026-08-21-옛-쪽만');
  write(path.join(legacyOnly, 'main-context', 'README.md'), '# 옛 쪽만\n\n상태: 완료\n');
  write(path.join(legacyOnly, 'main-context', '한-문서.md'), '한 문서 내용\n');
  write(path.join(legacyOnly, 'researches', '2026-08-01-조사', '보고.md'), '조사 결과\n');

  return { root, both, freshOnly, legacyOnly };
}

// 04 가 볼 자리 — 그룹 셋과 그룹이 아닌 자료 폴더 하나.
function seedCampaignGroups(dirs) {
  write(path.join(dirs.both, '2026-08-17-그룹-하나', 'TASK_GROUP.json'), `${JSON.stringify({
    id: '2026-08-17-그룹-하나', title: '그룹 하나', about: '', status: 'pending',
    campaign: '2026-08-16-둘-다', members: [],
    created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z',
  }, null, 2)}\n`);
  write(path.join(dirs.both, '자료-폴더', 'keep.txt'), '자료입니다\n');
  write(path.join(dirs.freshOnly, 'task-group-2026-08-22-이미-붙음', 'TASK_GROUP.json'), `${JSON.stringify({
    id: 'task-group-2026-08-22-이미-붙음', title: '이미 붙음', about: '', status: 'pending',
    campaign: '2026-08-20-새-쪽만', members: [],
    created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z',
  }, null, 2)}\n`);
  write(path.join(dirs.legacyOnly, '2026-08-23-태스크만', 'task-1-pending-옛-일.json'), `${JSON.stringify({
    number: 1, content: '옛 일', tag: '', status: 'pending', owner: 'surface:x',
    group_id: '2026-08-23-태스크만',
    created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z',
  }, null, 2)}\n`);
}

function contextFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((file) => /^context-\d+-.+\.md$/.test(file)).sort();
  } catch { return []; }
}

test('G13-03: dry-run 은 맥락 폴더를 그대로 두고 옮길 것만 센다', () => {
  const project = fixture('task-mcp-g13-03-dry-');
  const dirs = seedCampaigns(project);

  const dry = runMigrate('03-campaign-context.mjs', project);
  assertTally(dry, '03 dry-run');
  assert.ok(dry.processed > 0);
  // 옮길 곳은 언제나 새 이름으로 찍습니다.
  assert.match(dry.stdout, /campaign-main-context/);
  assert.match(dry.stdout, /확인 필요: 링크 1개/, '문서 안 상대 링크는 세기만 합니다.');

  assert.equal(fs.existsSync(path.join(dirs.both, 'campaign-context')), true);
  assert.equal(fs.existsSync(path.join(dirs.both, 'campaign-main-context')), false);
  assert.equal(fs.existsSync(path.join(dirs.both, 'main-context', 'README.md')), true);
  console.log(`g13_03_dry_targets=${dry.targets}`);
  console.log('g13_03_dry_changes=0');
});

test('G13-03: apply 는 맥락을 한 자리로 모으고 주제 폴더를 campaign-notes 로 뺀다', () => {
  const project = fixture('task-mcp-g13-03-apply-');
  const dirs = seedCampaigns(project);

  const applied = runMigrate('03-campaign-context.mjs', project, ['--apply']);
  assert.equal(applied.status, 0);
  assert.ok(applied.processed > 0);

  // (a) 맥락 폴더 개명
  const bothContext = path.join(dirs.both, 'campaign-main-context');
  assert.equal(fs.existsSync(path.join(dirs.both, 'campaign-context')), false);
  assert.equal(fs.existsSync(bothContext), true);

  // (b) README 가 MAIN_CONTEXT 로, 나머지 문서가 context-{N} 으로
  assert.match(fs.readFileSync(path.join(bothContext, 'MAIN_CONTEXT.md'), 'utf8'), /상태: 진행 중/);
  const docs = contextFiles(bothContext);
  assert.equal(docs.length, 3, 'direction · NOTES · 옛 notes 의 메모 셋입니다.');
  assert.ok(docs.some((file) => file.endsWith('-direction.md')));
  assert.ok(docs.some((file) => file.endsWith('-NOTES.md')));
  assert.ok(docs.some((file) => file.endsWith('-첫-메모.md')));
  for (const file of docs) {
    const body = fs.readFileSync(path.join(bothContext, file), 'utf8');
    assert.ok(body.startsWith('---\n'), `${file} 에 앞머리가 있어야 합니다.`);
    assert.match(body, /^number: \d+$/m);
  }
  assert.equal(fs.existsSync(path.join(dirs.both, 'main-context')), false, '빈 main-context 는 지웁니다.');

  // (c) notes/ 가 없어집니다.
  assert.equal(fs.existsSync(path.join(bothContext, 'notes')), false);

  // (d) 주제 폴더가 campaign-notes 로 갑니다.
  assert.equal(
    fs.existsSync(path.join(dirs.both, 'campaign-notes', '주제-하나', 'note-1-주제-노트.md')),
    true,
  );
  assert.equal(fs.existsSync(path.join(bothContext, '주제-하나')), false);

  // 차례는 실물에서 다시 씁니다.
  const index = fs.readFileSync(path.join(bothContext, 'INDEX.md'), 'utf8');
  assert.match(index, /## 본 맥락 문서/);
  assert.match(index, /## 주제 노트/);
  assert.match(index, /\.\.\/campaign-notes\/주제-하나\//);

  // 새 쪽만 있던 캠페인 — MAIN_CONTEXT 는 그대로, 빈 notes 는 사라집니다.
  const freshContext = path.join(dirs.freshOnly, 'campaign-main-context');
  assert.equal(fs.existsSync(freshContext), true);
  assert.match(fs.readFileSync(path.join(freshContext, 'MAIN_CONTEXT.md'), 'utf8'), /새 쪽만/);
  assert.equal(fs.existsSync(path.join(freshContext, 'notes')), false);

  // 옛 쪽만 있던 캠페인 — 새 폴더가 생기고 README 가 MAIN_CONTEXT 가 됩니다.
  const legacyContext = path.join(dirs.legacyOnly, 'campaign-main-context');
  assert.equal(fs.existsSync(path.join(dirs.legacyOnly, 'main-context')), false);
  assert.match(fs.readFileSync(path.join(legacyContext, 'MAIN_CONTEXT.md'), 'utf8'), /옛 쪽만/);
  assert.equal(contextFiles(legacyContext).length, 1);

  const again = runMigrate('03-campaign-context.mjs', project, ['--apply']);
  assertTally(again, '03 재실행');
  assert.equal(again.processed, 0);
  assert.equal(again.excluded, again.targets, '두 번째는 전부 이유가 붙은 제외입니다.');
  assert.match(again.stdout, /맥락이 이미 새 자리에 있습니다/);
  console.log('g13_03_apply_context_docs=3');
  console.log('g13_03_second_apply_processed=0');
});

test('G13-04: 그룹 폴더에만 접두사를 붙이고 자료 폴더는 그대로 둔다', () => {
  const project = fixture('task-mcp-g13-04-');
  const dirs = seedCampaigns(project);
  seedCampaignGroups(dirs);

  const dry = runMigrate('04-group-prefix.mjs', project);
  assertTally(dry, '04 dry-run');
  assert.equal(dry.processed, 2, '레코드가 있는 하나와 태스크 파일만 있는 하나입니다.');
  // 하위 폴더를 전부 훑고 자료 폴더·이미 붙은 것·그룹 아닌 것을 이유와 함께 제외로 셉니다.
  assert.equal(dry.targets, 10, '세 캠페인의 하위 폴더 전부입니다.');
  assert.match(dry.stdout, /캠페인 자료 폴더입니다 — 6건/, '세 캠페인의 맥락·조사 폴더 여섯입니다.');
  assert.match(dry.stdout, /이미 접두사가 붙어 있습니다 — 1건/);
  assert.match(dry.stdout, /레코드도 태스크 파일도 없어 그룹이 아닙니다 — 1건/, '자료-폴더 하나입니다.');
  assert.equal(fs.existsSync(path.join(dirs.both, '2026-08-17-그룹-하나')), true);

  const applied = runMigrate('04-group-prefix.mjs', project, ['--apply']);
  assertTally(applied, '04 apply');
  assert.equal(applied.processed, 2);
  assert.equal(applied.targets, dry.targets, '대상 수는 두 모드에서 같습니다.');
  assert.equal(fs.existsSync(path.join(dirs.both, 'task-group-2026-08-17-그룹-하나')), true);
  assert.equal(fs.existsSync(path.join(dirs.both, '2026-08-17-그룹-하나')), false);
  assert.equal(fs.existsSync(path.join(dirs.legacyOnly, 'task-group-2026-08-23-태스크만')), true);

  // 레코드의 id 도 폴더 이름과 맞춥니다.
  const record = JSON.parse(fs.readFileSync(
    path.join(dirs.both, 'task-group-2026-08-17-그룹-하나', 'TASK_GROUP.json'), 'utf8',
  ));
  assert.equal(record.id, 'task-group-2026-08-17-그룹-하나');

  // 그룹이 아닌 것은 건드리지 않습니다.
  assert.equal(fs.existsSync(path.join(dirs.both, '자료-폴더', 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(dirs.both, 'task-group-자료-폴더')), false);
  assert.equal(fs.existsSync(path.join(dirs.both, 'main-context')), true, '맥락 폴더도 그룹이 아닙니다.');
  assert.equal(fs.existsSync(path.join(dirs.freshOnly, 'task-group-2026-08-22-이미-붙음')), true);

  const again = runMigrate('04-group-prefix.mjs', project, ['--apply']);
  assertTally(again, '04 재실행');
  assert.equal(again.processed, 0);
  assert.equal(again.excluded, again.targets);
  console.log('g13_04_apply_processed=2');
  console.log('g13_04_second_apply_processed=0');
});

test('G13-05: 빈 조사 폴더는 지우고 실물이 있으면 이름만 바꾼다', () => {
  const project = fixture('task-mcp-g13-05-');
  const dirs = seedCampaigns(project);

  const dry = runMigrate('05-researches.mjs', project);
  assertTally(dry, '05 dry-run');
  assert.equal(dry.processed, 2, '빈 것 하나와 실물 하나입니다.');
  assert.equal(dry.excluded, 1, 'researches 가 없는 캠페인 하나입니다.');
  assert.match(dry.stdout, /옛 researches 폴더가 없습니다/);
  assert.equal(fs.existsSync(path.join(dirs.freshOnly, 'researches')), true);
  assert.match(dry.stdout, /폴더 1개 · 파일 1개/);

  const applied = runMigrate('05-researches.mjs', project, ['--apply']);
  assertTally(applied, '05 apply');
  assert.equal(applied.processed, 2);
  assert.equal(fs.existsSync(path.join(dirs.freshOnly, 'researches')), false, '빈 폴더는 지웁니다.');
  assert.equal(fs.existsSync(path.join(dirs.legacyOnly, 'researches')), false);
  assert.equal(
    fs.readFileSync(path.join(dirs.legacyOnly, 'campaign-researches', '2026-08-01-조사', '보고.md'), 'utf8'),
    '조사 결과\n',
    '안의 파일은 그대로입니다.',
  );

  const again = runMigrate('05-researches.mjs', project, ['--apply']);
  assertTally(again, '05 재실행');
  assert.equal(again.processed, 0);
  assert.equal(again.excluded, again.targets);
  console.log('g13_05_apply_processed=2');
  console.log('g13_05_second_apply_processed=0');
});

test('G13: 01 부터 05 까지 순서대로 돌려도 두 번째는 처리 0건이다', () => {
  const project = fixture('task-mcp-g13-full-');
  seedLegacy(project);
  const dirs = seedCampaigns(project);
  seedCampaignGroups(dirs);
  addIgnoreLines(project);

  const scripts = [
    '01-group-record.mjs', '02-campaign-root.mjs', '03-campaign-context.mjs',
    '04-group-prefix.mjs', '05-researches.mjs',
  ];
  for (const script of scripts) {
    const result = runMigrate(script, project, ['--apply']);
    assert.equal(result.status, 0, `${script} 가 종료 코드 0 이어야 합니다.`);
  }

  const fresh = path.join(project, '.claude', 'mcp-task-campaign');
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.lstatSync(path.join(project, '.claude', 'campaigns')).isSymbolicLink(), true);
  for (const campaign of fs.readdirSync(fresh)) {
    assert.equal(fs.existsSync(path.join(fresh, campaign, 'main-context')), false);
    assert.equal(fs.existsSync(path.join(fresh, campaign, 'campaign-context')), false);
    assert.equal(fs.existsSync(path.join(fresh, campaign, 'researches')), false);
  }

  for (const script of scripts) {
    const result = runMigrate(script, project, ['--apply']);
    assertTally(result, `${script} 두 번째 실행`);
    assert.equal(result.processed, 0, `${script} 두 번째 실행은 처리 0건이어야 합니다.`);
    assert.equal(result.errorLines, 0, `${script} 두 번째 실행에 오류가 없어야 합니다.`);
  }
  console.log('g13_full_chain_second_run_processed=0');
});

// ── 06 — 제외 사유와 집계 단위 (백로그 3) ──────────────────────────────────────
//
// 아래 넷은 고치기 전 코드에서 실제로 실패합니다.
//   · 02 의 dry-run 이 링크 걸기를 세지 않아 대상이 1 대 2 로 갈렸습니다.
//   · skip() 이 이유를 받지 않아 제외 줄이 아예 찍히지 않았습니다.
//   · 읽기 실패가 정상 제외와 같은 칸에 섞였습니다.
//   · 03 의 빈 폴더 지우기가 대상 없이 실행 수만 늘려 대상 ≠ 처리 + 제외 였습니다.

test('G13-06: 다섯 스크립트가 dry-run 과 apply 에서 같은 수를 센다', () => {
  const project = fixture('task-mcp-g13-06-same-');
  seedLegacy(project);
  const dirs = seedCampaigns(project);
  seedCampaignGroups(dirs);
  addIgnoreLines(project);

  const scripts = [
    '01-group-record.mjs', '02-campaign-root.mjs', '03-campaign-context.mjs',
    '04-group-prefix.mjs', '05-researches.mjs',
  ];
  for (const script of scripts) {
    // dry-run 은 아무것도 바꾸지 않으므로 같은 자리에서 곧바로 apply 와 견줍니다.
    const dry = runMigrate(script, project);
    const applied = runMigrate(script, project, ['--apply']);
    assertTally(dry, `${script} dry-run`);
    assertTally(applied, `${script} apply`);
    assert.equal(applied.targets, dry.targets, `${script}: 대상 수가 두 모드에서 같아야 합니다.`);
    assert.equal(applied.processed, dry.processed, `${script}: 처리 수가 두 모드에서 같아야 합니다.`);
    assert.equal(applied.excluded, dry.excluded, `${script}: 제외 수가 두 모드에서 같아야 합니다.`);
  }
  console.log('g13_06_dry_apply_same=5');
});

test('G13-06: 제외에는 이유가 반드시 붙고 이유 없는 제외는 거절된다', async () => {
  const project = fixture('task-mcp-g13-06-reason-');
  seedLegacy(project);
  addIgnoreLines(project);
  runMigrate('01-group-record.mjs', project, ['--apply']);

  const again = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(again, '01 재실행');
  assert.equal(again.skipLines, again.excluded, '제외 한 건마다 줄 하나입니다.');
  for (const line of again.stdout.split('\n').filter((row) => row.startsWith('[제외]'))) {
    assert.match(line, /^\[제외\] \S+  .+\S$/, `이유가 비어 있습니다: ${line}`);
  }

  const { createRun } = await import('../migrate/common.mjs');
  const run = createRun({ number: 'X', title: '시험', argv: ['node', 'x', '--dry-run'] });
  assert.throws(() => run.skip(), /제외에는 이유가 있어야 합니다/);
  console.log('g13_06_skip_requires_reason=true');
});

test('G13-06: 읽지 못한 레코드는 오류로 갈라 세고 나머지는 계속 처리한다', () => {
  const project = fixture('task-mcp-g13-06-error-');
  const good = path.join(mcpTaskRoot(project), '2026-08-01-멀쩡');
  const broken = path.join(mcpTaskRoot(project), '2026-08-02-깨짐');
  writeLegacyRecord(good, '2026-08-01-멀쩡', { worker: { name: 'W', surface: WORKER_UUID } });
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'GROUP.json'), '{ 깨진 JSON\n');
  addIgnoreLines(project);

  const applied = runMigrate('01-group-record.mjs', project, ['--apply']);
  assertTally(applied, '01 오류 섞임');
  assert.equal(applied.processed, 1, '멀쩡한 하나는 옮깁니다.');
  assert.equal(applied.errorLines, 1);
  assert.equal(applied.skipLines, 0, '읽기 실패는 정상 제외로 세지 않습니다.');
  assert.match(applied.stdout, /레코드를 읽지 못했습니다 — 1건 \[오류\]/);
  assert.match(applied.stdout, /오류 1건이 있습니다\. 사람이 보고 정한 뒤 다시 실행하십시오\./);
  assert.equal(fs.existsSync(path.join(good, 'TASK_GROUP.json')), true);
  assert.equal(fs.existsSync(path.join(broken, 'GROUP.json')), true, '오류 자리의 원본은 그대로 둡니다.');
  console.log('g13_06_error_split=1');
});

test('G13-06: 빈 폴더 지우기는 뒷정리로 따로 세고 대상에 넣지 않는다', () => {
  const project = fixture('task-mcp-g13-06-cleanup-');
  const dirs = seedCampaigns(project);
  addIgnoreLines(project);

  const applied = runMigrate('03-campaign-context.mjs', project, ['--apply']);
  assertTally(applied, '03 apply');
  assert.ok(applied.cleanupLines > 0, '빈 main-context 와 notes 를 지웁니다.');
  assert.match(applied.stdout, /뒷정리 \d+건 — 옮기고 난 빈 폴더를 지운 것이며 대상에 넣지 않습니다\./);
  assert.equal(fs.existsSync(path.join(dirs.legacyOnly, 'main-context')), false);
  console.log('g13_06_cleanup_outside_targets=true');
});
