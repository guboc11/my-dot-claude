import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { parseMarkdownRecord, today, withLineNumbers } from '../lib.mjs';
import { PROJECT_SERVER, callTool, callToolError, listTools, listToolsOutput, makeProject, removeProject } from './helpers.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const projects = [];
after(() => projects.forEach(removeProject));

function fixture() {
  const project = makeProject('task-mcp-g11-');
  projects.push(project);
  return project;
}

function call(project, name, args = {}) {
  return callTool(PROJECT_SERVER, project, name, args, MANAGER);
}

function campaignPath(project, name, ...rest) {
  return path.join(project, '.claude', 'mcp-task-campaign', name, ...rest);
}

function addCampaign(project, name = 'G11 캠페인') {
  const output = call(project, 'campaign_add', { name, about: '검증 설명' });
  return { id: /캠페인 생성: ([^\n]+)/.exec(output)[1], output };
}

function addGroup(project, campaign, topic) {
  const output = call(project, 'task_group_add', { topic, campaign });
  return /group_id="([^"]+)"/.exec(output)[1];
}

function snapshot(project) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { files.push([path.relative(project, full), 'directory']); visit(full); }
      else files.push([path.relative(project, full), fs.readFileSync(full, 'utf8'), fs.statSync(full).mtimeMs]);
    }
  }
  visit(project);
  return files;
}

test('G11: 전체 36개 도구 중 캠페인 도구 8개와 새 인자를 공개합니다', () => {
  const project = fixture();
  const tools = listTools(PROJECT_SERVER, project);
  // 2026-10-09 그룹 맥락 도구 네 개를 추가했습니다.
  assert.equal(tools.length, 36);
  assert.deepEqual(tools.filter((name) => name.startsWith('campaign_')), [
    'campaign_add', 'campaign_read', 'campaign_context_add',
    'campaign_main_context_get', 'campaign_main_context_update',
    'campaign_context_get', 'campaign_context_update', 'campaign_list',
  ]);
  const output = listToolsOutput(PROJECT_SERVER, project);
  assert.match(output, /campaign_context_add\(name, title, text, topic\?\)/);
  // gap 은 2026-09-18 정합 개선에서 더한 append 전용 선택 인자입니다(백로그 15).
  assert.match(output, /campaign_context_update\(name, number, topic\?, title\?, field\?, mode\?, text\?, at\?, gap\?, old\?, new\?, replace_all\?, insert_after\?\)/);
  assert.match(output, /task_group_research\(group_id, topic\)/);
  for (const name of ['campaign_note', 'campaign_research', 'campaign_plan']) {
    assert.match(callToolError(PROJECT_SERVER, project, name, {}), new RegExp(`알 수 없는 도구: ${name}`));
  }
});

test('G11: 새 캠페인은 새 루트에 본 맥락과 주제 노트 폴더만 만듭니다', () => {
  const project = fixture();
  const { id, output } = addCampaign(project, '2026-08-02-2026-08-01-새 캠페인');
  assert.equal(id, `${today()}-새-캠페인`);
  assert.match(output, /2026-08-02, 2026-08-01 를 뗐습니다/);
  assert.deepEqual(fs.readdirSync(campaignPath(project, id)).sort(), ['campaign-main-context', 'campaign-notes']);
  assert.deepEqual(fs.readdirSync(campaignPath(project, id, 'campaign-main-context')).sort(), ['INDEX.md', 'MAIN_CONTEXT.md']);
  const main = fs.readFileSync(campaignPath(project, id, 'campaign-main-context', 'MAIN_CONTEXT.md'), 'utf8');
  assert.equal(main, `# ${id}\n\n상태: 진행 중\n\n검증 설명\n`);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'campaigns')), false);
  // 머리 줄이 진행 중과 전체 두 수를 함께 보입니다(백로그 14).
  assert.match(call(project, 'campaign_read', { name: id }), /태스크 그룹 — 진행 중 0개 \/ 전체 0개/);
});

test('G11: 옛 루트만 있으면 읽고 새 루트가 있으면 새 루트를 우선합니다', () => {
  const project = fixture();
  const old = path.join(project, '.claude', 'campaigns', 'old-root');
  const context = path.join(old, 'campaign-main-context');
  fs.mkdirSync(context, { recursive: true });
  fs.writeFileSync(path.join(context, 'MAIN_CONTEXT.md'), '# 옛 루트의 새 구조\n\n상태: 이관 전\n');
  const before = snapshot(project);
  assert.match(call(project, 'campaign_list'), /old-root — 이관 전/);
  assert.match(call(project, 'campaign_read', { name: 'old-root' }), /옛 루트의 새 구조/);
  assert.deepEqual(snapshot(project), before);
  const { id } = addCampaign(project);
  const list = call(project, 'campaign_list');
  assert.match(list, new RegExp(id));
  assert.doesNotMatch(list, /old-root/);
  assert.equal(fs.existsSync(old), true);
});

test('G11: 본 맥락 문서와 주제 노트의 번호·앞머리·차례가 나뉩니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  for (const [title, topic] of [['첫 [결정]', undefined], ['둘째 결정', undefined], ['첫 노트', '합의 사항'], ['둘째 노트', '합의 사항']]) {
    call(project, 'campaign_context_add', { name: id, title, text: `본문 ${title}`, ...(topic ? { topic } : {}) });
  }
  const context = campaignPath(project, id, 'campaign-main-context');
  const notes = campaignPath(project, id, 'campaign-notes', '합의-사항');
  assert.deepEqual(fs.readdirSync(context).sort(), ['INDEX.md', 'MAIN_CONTEXT.md', 'context-1-첫-결정.md', 'context-2-둘째-결정.md']);
  assert.deepEqual(fs.readdirSync(notes).sort(), ['note-1-첫-노트.md', 'note-2-둘째-노트.md']);
  const doc = parseMarkdownRecord(fs.readFileSync(path.join(context, 'context-1-첫-결정.md'), 'utf8'));
  assert.equal(doc.metadata.number, '1');
  assert.equal(doc.metadata.title, '첫 [결정]');
  assert.equal(doc.metadata.author, MANAGER);
  assert.equal(doc.metadata.created_at, doc.metadata.updated_at);
  assert.equal(doc.body, '본문 첫 [결정]');
  const index = fs.readFileSync(path.join(context, 'INDEX.md'), 'utf8');
  assert.equal((index.match(/context-\d+-/g) || []).length, 2);
  assert.equal((index.match(/\.\.\/campaign-notes\/합의-사항\//g) || []).length, 1);
  assert.doesNotMatch(index, /note-\d+-/);
  assert.doesNotMatch(call(project, 'campaign_read', { name: id }), /차례와 실물이 어긋납니다/);
});

test('G11: 본 맥락의 상태 값을 바꾸고 줄 번호로 본문을 편집합니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  const file = campaignPath(project, id, 'campaign-main-context', 'MAIN_CONTEXT.md');
  assert.equal(call(project, 'campaign_main_context_get', { name: id }), withLineNumbers(fs.readFileSync(file, 'utf8')).trimEnd());
  call(project, 'campaign_main_context_update', { name: id, status: '종료 — 확인 완료' });
  assert.match(call(project, 'campaign_list'), /종료 — 확인 완료/);
  call(project, 'campaign_main_context_update', { name: id, field: 'body', mode: 'edit', insert_after: 3, text: '상태 뒤 안내' });
  assert.match(fs.readFileSync(file, 'utf8'), /상태: 종료 — 확인 완료\n상태 뒤 안내/);
  call(project, 'campaign_main_context_update', { name: id, field: 'body', mode: 'replace', text: '# 제목\n\n본문' });
  call(project, 'campaign_main_context_update', { name: id, status: '다시 진행' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# 제목\n\n상태: 다시 진행\n\n본문');
  call(project, 'campaign_main_context_update', { name: id, field: 'body', mode: 'append', text: '추가 설명' });
  assert.match(fs.readFileSync(file, 'utf8'), /본문\n\n추가 설명$/);
});

test('G11: 맥락 제목 변경은 파일과 차례를 바꾸고 작성자·생성 시각을 보존합니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  call(project, 'campaign_context_add', { name: id, title: '원제목', text: '첫 줄\n둘째 줄' });
  const context = campaignPath(project, id, 'campaign-main-context');
  const original = path.join(context, 'context-1-원제목.md');
  const before = parseMarkdownRecord(fs.readFileSync(original, 'utf8'));
  assert.match(call(project, 'campaign_context_get', { name: id, number: 1 }), /\n   1│ 첫 줄\n   2│ 둘째 줄/);
  call(project, 'campaign_context_update', { name: id, number: 1, title: '새 [제목]', field: 'body', mode: 'edit', old: '둘째 줄', new: '$& 그대로' });
  const next = path.join(context, 'context-1-새-제목.md');
  assert.equal(fs.existsSync(original), false);
  const after = parseMarkdownRecord(fs.readFileSync(next, 'utf8'));
  assert.equal(after.body, '첫 줄\n$& 그대로');
  assert.equal(after.metadata.author, before.metadata.author);
  assert.equal(after.metadata.created_at, before.metadata.created_at);
  assert.notEqual(after.metadata.updated_at, before.metadata.updated_at);
  assert.match(fs.readFileSync(path.join(context, 'INDEX.md'), 'utf8'), /\(context-1-새-제목\.md\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(context, 'INDEX.md'), 'utf8'), /원제목/);
  assert.doesNotMatch(call(project, 'campaign_read', { name: id }), /차례와 실물이 어긋납니다/);
});

test('G11: 주제 노트의 제목·빈 본문 교체는 주제 차례와 다른 번호에 영향을 주지 않습니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  call(project, 'campaign_context_add', { name: id, title: '본 문서', text: '본 문서 본문' });
  call(project, 'campaign_context_add', { name: id, title: '주제 노트', text: '주제 본문', topic: '합의' });
  const index = campaignPath(project, id, 'campaign-main-context', 'INDEX.md');
  const beforeIndex = fs.readFileSync(index, 'utf8');
  call(project, 'campaign_context_update', { name: id, number: 1, topic: '합의', title: '새 노트', field: 'body', mode: 'replace', text: '' });
  const file = campaignPath(project, id, 'campaign-notes', '합의', 'note-1-새-노트.md');
  assert.equal(parseMarkdownRecord(fs.readFileSync(file, 'utf8')).body, '');
  assert.equal(fs.readFileSync(index, 'utf8'), beforeIndex);
  assert.match(call(project, 'campaign_context_get', { name: id, number: 1 }), /본 문서 본문/);
  assert.doesNotMatch(call(project, 'campaign_context_get', { name: id, number: 1, topic: '합의' }), /│/);
});

test('G11: 편집 오류는 본 문서·주제 노트·차례의 내용·이름·시각을 모두 보존합니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  call(project, 'campaign_main_context_update', { name: id, field: 'body', mode: 'replace', text: '반복\n반복' });
  for (const topic of [undefined, '주제']) call(project, 'campaign_context_add', { name: id, title: '보존', text: '반복\n반복', ...(topic ? { topic } : {}) });
  const before = snapshot(project);
  const cases = [
    [{ field: 'body' }, 'field 에는 mode 가 있어야 합니다'],
    [{ field: 'body', mode: 'edit', old: '없는 말', new: '새 말' }, 'old 를 찾지 못했습니다'],
    [{ field: 'body', mode: 'edit', old: '반복', new: '새 말' }, 'old 가 2 군데에 있습니다'],
    [{ field: 'body', mode: 'edit', old: '반복', new: '반복' }, 'old 와 new 가 같습니다'],
    [{ field: 'body', mode: 'edit', insert_after: 3, text: '새 줄' }, '줄이 2 개뿐입니다'],
    [{ append: true, text: '옛 인자' }, 'append 플래그는 없어졌습니다'],
    [{ body: '옛 인자' }, 'append 플래그는 없어졌습니다'],
    [{ field: 'spec', mode: 'replace', text: '오류' }, 'field 는 body 여야 합니다'],
  ];
  for (const [tool, base, value] of [
    ['campaign_main_context_update', { name: id }, { status: '바뀌면 안 되는 상태' }],
    ['campaign_context_update', { name: id, number: 1 }, { title: '바뀌면 안 되는 제목' }],
    ['campaign_context_update', { name: id, number: 1, topic: '주제' }, { title: '바뀌면 안 되는 제목' }],
  ]) {
    for (const [args, error] of cases) assert.ok(callToolError(PROJECT_SERVER, project, tool, { ...base, ...value, ...args }, MANAGER).includes(error));
  }
  callToolError(PROJECT_SERVER, project, 'campaign_context_add', { name: id, title: '줄\n바꿈', text: '내용', topic: '만들면 안 되는 폴더' }, MANAGER);
  assert.deepEqual(snapshot(project), before);
});

test('G11: 접두사 그룹만 찾고 완료 태스크 수와 관계없이 그룹 상태로 숨깁니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  const empty = addGroup(project, id, '빈 진행 그룹');
  const done = addGroup(project, id, '완료 그룹');
  const completedTasks = addGroup(project, id, '태스크만 완료');
  fs.mkdirSync(campaignPath(project, id, '자료-폴더'));
  fs.mkdirSync(campaignPath(project, id, `${today()}-옛-접두사-없는-폴더`));
  const doneTask = { number: 1, content: '완료 태스크', status: 'completed', owner: MANAGER, group_id: completedTasks };
  fs.writeFileSync(campaignPath(project, id, completedTasks, 'task-1-completed-완료.json'), JSON.stringify(doneTask));
  call(project, 'task_group_update', { group_id: done, status: 'done' });
  const read = call(project, 'campaign_read', { name: id });
  // 그룹 셋 가운데 하나를 done 으로 숨겼으므로 진행 중 2개 · 전체 3개입니다(백로그 14).
  assert.match(read, /태스크 그룹 — 진행 중 2개 \/ 전체 3개/);
  assert.ok(read.includes(empty));
  assert.ok(read.includes(completedTasks));
  assert.ok(!read.includes(`[${done}]`));
  assert.match(read, /완료 그룹 1개를 숨겼습니다/);
  assert.ok(call(project, 'campaign_read', { name: id, full: true }).includes(done));
  assert.doesNotMatch(call(project, 'task_group_list', { campaign: id, all: true }), /자료-폴더|접두사-없는-폴더/);
  assert.match(call(project, 'task_group_get', { group_id: empty.replace(/^task-group-/, '') }), /빈 진행 그룹/);
});

test('G11: 그룹 조사는 날짜를 정리한 빈 폴더를 만들고 대시보드에 셉니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  const group = addGroup(project, id, '조사 그룹');
  const output = call(project, 'task_group_research', { group_id: group, topic: '2026-08-03-2026-08-02-호환 조사' });
  const folder = `research-${today()}-호환-조사`;
  assert.match(output, /2026-08-03, 2026-08-02 를 뗐습니다/);
  assert.ok(output.endsWith(`/researches/${folder}/`));
  assert.deepEqual(fs.readdirSync(campaignPath(project, id, group, 'researches', folder)), []);
  const get = call(project, 'task_group_get', { group_id: group });
  assert.match(get, /조사 1개/);
  assert.ok(get.includes(`researches/${folder}/`));
  assert.match(call(project, 'task_group_list', { campaign: id }), /조사 1개/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_research', { group_id: group, topic: '호환 조사' }, MANAGER), /이미 있는 조사 폴더/);
});

test('G11: 차례와 실물의 어긋남을 알리고 옛 맥락·조사·노트는 읽지 않습니다', () => {
  const project = fixture();
  const { id } = addCampaign(project);
  call(project, 'campaign_context_add', { name: id, title: '새 문서', text: '새 본문' });
  const group = addGroup(project, id, '대조 그룹');
  const context = campaignPath(project, id, 'campaign-main-context');
  fs.writeFileSync(path.join(context, 'context-99-미등재.md'), '# 미등재\n');
  fs.mkdirSync(campaignPath(project, id, 'campaign-notes', '미등재-주제'));
  fs.appendFileSync(path.join(context, 'INDEX.md'), '- [유령](context-88-유령.md)\n');
  for (const dir of ['main-context', 'campaign-context', 'researches']) {
    fs.mkdirSync(campaignPath(project, id, dir));
    fs.writeFileSync(campaignPath(project, id, dir, 'README.md'), '# LEGACY_CONTENT\n');
  }
  for (const file of ['plans.md', 'researches.md']) fs.writeFileSync(campaignPath(project, id, file), '# LEGACY_CONTENT\n');
  for (const file of ['NOTES.md', 'plans.md']) fs.writeFileSync(campaignPath(project, id, group, file), '# LEGACY_CONTENT\n');
  const before = snapshot(project);
  const read = call(project, 'campaign_read', { name: id, full: true });
  const positions = ['# ' + id, '## 차례 (campaign-main-context)', '! 차례와 실물이 어긋납니다', '## 태스크 그룹'].map((text) => read.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(read, /context-1-새-문서.md/);
  assert.match(read, /차례에 없는 문서·폴더: context-99-미등재.md, \.\.\/campaign-notes\/미등재-주제\//);
  assert.match(read, /실물이 없는 등재: context-88-유령.md/);
  assert.doesNotMatch(read, /LEGACY_CONTENT|plans\.md|researches\.md|README\.md|리서치 폴더/);
  assert.match(read, /노트 0개 · 계획서 0개/);
  assert.doesNotMatch(call(project, 'task_group_get', { group_id: group }), /NOTES\.md|plans\.md/);
  assert.deepEqual(snapshot(project), before);
});
