// G10 — 보고 직통.
// 설계: 태스크 그룹 `task-group-2026-09-18-보고-직통-전환` 의 노트 1 「대본」 2 · 3 · 4절.
//
// 워커가 적으면 그 자리에서 매니저 패널로 갑니다. 매니저가 쉬는지 일하는지 판정하지 않으므로
// 전송 시점은 그대로이며, 보낸 뒤 입력창에 남았는지만 확인합니다.
// 실제 cmux 로 다른 패널에 글을 보내지 않습니다 — TASK_MCP_FAKE_CMUX=1 이 기록만 하는 가짜를 쓰고
// TASK_MCP_FAKE_SEND_FAIL=1 이면 그 가짜가 실패를 돌려줍니다.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { makeCmux, reportIsInInput, reportIsVisible } from '../tools/message.mjs';

import {
  PROJECT_SERVER,
  callTool,
  callToolError,
  makeProject,
  mcpTaskGroupDir,
  mcpTaskRoot,
  removeProject,
} from './helpers.mjs';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const TESTER = '33333333-3333-4333-8333-333333333333';

const projects = [];
const saved = {};

before(() => {
  for (const key of ['TASK_MCP_FAKE_CMUX', 'TASK_MCP_FAKE_SEND_FAIL', 'TASK_MCP_FAKE_SCREEN']) saved[key] = process.env[key];
  process.env.TASK_MCP_FAKE_CMUX = '1';
  delete process.env.TASK_MCP_FAKE_SEND_FAIL;
  delete process.env.TASK_MCP_FAKE_SCREEN;
});

after(() => {
  for (const project of projects) removeProject(project);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

// send 가 실패하는 길만 이 안에서 돕니다.
function withSendFailure(fn) {
  process.env.TASK_MCP_FAKE_SEND_FAIL = '1';
  try { return fn(); } finally { delete process.env.TASK_MCP_FAKE_SEND_FAIL; }
}

function logOf(project, groupId) {
  const file = path.join(mcpTaskGroupDir(project, groupId), 'MANAGER_MESSAGE_QUEUE.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function commandLog(project) {
  try {
    return fs.readFileSync(path.join(project, '.task-mcp-fake-cmux.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function sendLog(project) {
  return commandLog(project).filter((entry) => entry.op === 'send');
}

// 맡은 사람이 하나 집어 든 상태까지 만듭니다.
// 태스크를 만드는 패널도 명단에 있어야 합니다(백로그 9). 매니저가 없는 그룹을 시험할 때는
// 매니저가 아니라 그 그룹의 워커가 만듭니다.
function setup(project, topic, members, actor = WORKER) {
  const list = members || [
    { name: 'MNGR3', surface: MANAGER, ref: 'surface:32', roles: ['manager'] },
    { name: 'WRKR301[claude]', surface: WORKER, ref: 'surface:70', roles: ['worker'] },
    { name: 'TESTER3', surface: TESTER, roles: ['tester'] },
  ];
  const creator = list.some((entry) => entry.surface === MANAGER) ? MANAGER : actor;
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic, members: list }, creator);
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: '오프닝 카드 3종', batch: 'b1', spec: '받아들임 조건', assignee: actor,
  }, creator);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, actor);
  return groupId;
}

test('G10: result 를 적으면 그 자리에서 패널로 가고 기록에 delivered 한 줄이 남는다', () => {
  const project = fixture('task-mcp-g10-direct-');
  const groupId = setup(project, '직통 한 줄');

  const output = callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'replace', text: '오프닝 카드 3종 구현',
  }, WORKER);
  assert.match(output, /매니저 패널\(surface:32\)로 보고를 보냈습니다\./);

  // 패널로 간 줄은 대본 2절 꼴입니다.
  const sent = sendLog(project);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].surface, MANAGER);
  assert.equal(
    sent[0].text,
    `[task-mcp] WRKR301[claude] (surface:70) 이 ${groupId} task-1 (work) 의 result 를 적었습니다. 오프닝 카드 3종 구현 task_get ${groupId} 1`,
  );
  assert.doesNotMatch(sent[0].text, /\n/, '줄바꿈이 있으면 패널에서 줄마다 따로 들어갑니다.');

  const log = logOf(project, groupId);
  assert.equal(log.length, 1);
  assert.equal(log[0].state, 'delivered');
  assert.equal(log[0].reason, null);
  assert.ok(log[0].sent_at);
  assert.equal(log[0].read_at, null);
  assert.equal(log[0].event, 'result');
  assert.equal(log[0].outcome, null);
  assert.equal(log[0].task, 1);
  assert.equal(log[0].kind, 'work');
  assert.deepEqual(log[0].from, { name: 'WRKR301[claude]', surface: WORKER, ref: 'surface:70' });
  assert.deepEqual(log[0].to, { name: 'MNGR3', surface: MANAGER, ref: 'surface:32' });
  assert.equal(log[0].line, sent[0].text, '보낸 글 원문이 기록에 그대로 남습니다.');
  // 쌓아 두던 시절의 칸은 없습니다.
  assert.equal('delivered_by' in log[0], false);
  assert.equal('session' in log[0].to, false);
  console.log('direct_send=1');
  console.log('log_state=delivered');
});

test('G10: completed 와 result 를 한 호출에 적으면 줄 하나이고 event 는 completed', () => {
  const project = fixture('task-mcp-g10-completed-');
  const groupId = setup(project, '한 호출 두 사건');

  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, status: 'completed', field: 'result', mode: 'replace', text: '끝냈습니다',
  }, WORKER);

  const log = logOf(project, groupId);
  assert.equal(log.length, 1);
  assert.equal(log[0].event, 'completed');
  assert.equal(log[0].summary, '끝냈습니다');
  assert.equal(sendLog(project).length, 1);
  console.log('one_call_one_line=true');
});

test('G10: outcome 만 적으면 event 는 outcome 이고 줄에 판정이 붙는다', () => {
  const project = fixture('task-mcp-g10-outcome-');
  const groupId = setup(project, '판정');
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, status: 'completed', field: 'result', mode: 'replace', text: '구현 끝',
  }, WORKER);
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId, content: 'b1 검증', batch: 'b1', kind: 'test', spec: '검사 항목',
  }, MANAGER);
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, TESTER);

  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 2, field: 'result', mode: 'replace', text: '검사 항목 여섯 개 모두 통과',
  }, TESTER);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 2, outcome: 'pass',
  }, TESTER);

  const log = logOf(project, groupId);
  const judged = log[log.length - 1];
  assert.equal(judged.event, 'outcome');
  assert.equal(judged.outcome, 'pass');
  assert.equal(judged.kind, 'test');
  const sent = sendLog(project);
  assert.match(sent[sent.length - 1].text, new RegExp(`task-2 \\(test\\) 의 outcome \\(pass\\) 를 적었습니다\\.`));
  // outcome 만 준 호출의 요약은 result 전체의 첫 줄입니다.
  assert.equal(judged.summary, '검사 항목 여섯 개 모두 통과');
  // 이름이 없는 패널은 UUID 앞 8자로 표시합니다.
  assert.match(sent[sent.length - 1].text, /^\[task-mcp\] TESTER3 \(33333333\) 이 /);
  console.log('outcome_event=outcome(pass)');
  console.log('person_label_fallback=uuid8');
});

test('G10: 보내지 못해도 태스크 쓰기는 성공하고 기록에 failed 와 까닭이 남는다', () => {
  const project = fixture('task-mcp-g10-failed-');
  const groupId = setup(project, '보내기 실패');

  const output = withSendFailure(() => callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'replace', text: '적기는 성공했습니다',
  }, WORKER));
  assert.match(output, /업데이트됨: .* \(내용 수정\)\./, '워커의 쓰기는 그대로 성공합니다.');
  assert.match(output, /매니저 패널로 보내지 못했습니다\(send 실패\(가짜\)\)\. message_list 로 확인하십시오\./);

  const log = logOf(project, groupId);
  assert.equal(log.length, 1);
  assert.equal(log[0].state, 'failed');
  assert.equal(log[0].reason, 'send 실패(가짜)');
  assert.equal(log[0].sent_at, null);
  assert.ok(log[0].line, '보내려던 글은 기록에 남습니다.');
  assert.equal(sendLog(project).length, 0);

  // 태스크 쪽 쓰기가 실제로 들어갔는지 봅니다.
  const task = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, WORKER);
  assert.match(task, /적기는 성공했습니다/);
  console.log('write_succeeds_on_send_failure=true');
  console.log('log_state=failed');
});

test('G10: 요약은 200자에서 자르고 정제하며 append 는 새로 붙인 글이 요약이 된다', () => {
  const project = fixture('task-mcp-g10-summary-');
  const groupId = setup(project, '요약 규칙');

  // (가) 정제 — 백틱 · 작은따옴표는 공백으로, 둘째 줄부터는 버립니다.
  const dirty = `오프닝 카드 3종. ${'`'}스크린샷${'`'} 3장과 ${"'"}따옴표${"'"}\n둘째 줄은 요약에 안 들어갑니다`;
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'replace', text: dirty,
  }, WORKER);
  let log = logOf(project, groupId);
  assert.equal(log[0].summary, '오프닝 카드 3종. 스크린샷 3장과 따옴표');
  assert.doesNotMatch(log[0].summary, /[`'\n]/);

  // (나) append — 새로 붙인 글의 첫 줄이 요약입니다.
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'append', text: '두 번째로 붙인 글',
  }, WORKER);
  log = logOf(project, groupId);
  assert.equal(log[1].summary, '두 번째로 붙인 글', 'append 라도 새 글이 요약입니다.');

  // (다) 대조군 — result 를 안 적은 호출은 result 전체의 첫 줄을 씁니다.
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, status: 'completed',
  }, WORKER);
  log = logOf(project, groupId);
  assert.equal(log[2].event, 'completed');
  assert.equal(log[2].summary, '오프닝 카드 3종. 스크린샷 3장과 따옴표', 'result 첫 줄로 물러섭니다.');

  // (라) 길이 — 200자에서 자릅니다.
  const long = fixture('task-mcp-g10-summary-long-');
  const longGroup = setup(long, '긴 요약');
  callTool(PROJECT_SERVER, long, 'task_update', {
    group_id: longGroup, number: 1, field: 'result', mode: 'replace', text: '가'.repeat(260),
  }, WORKER);
  const longLog = logOf(long, longGroup);
  assert.equal(longLog[0].summary.length, 200);
  assert.equal(longLog[0].summary, '가'.repeat(200));
  console.log('summary_clean=true');
  console.log('summary_prefers_this_call=true');
  console.log('summary_limit=200');
});

test('G10: 매니저 자기 보고와 매니저 없는 그룹은 줄도 전송도 없다', () => {
  const project = fixture('task-mcp-g10-no-line-');

  const selfGroup = setup(project, '자기 보고', [
    { name: 'MNGR3', surface: MANAGER, ref: 'surface:32', roles: ['manager', 'worker'] },
  ], MANAGER);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: selfGroup, number: 1, field: 'result', mode: 'replace', text: '매니저가 직접 했습니다',
  }, MANAGER);
  assert.equal(logOf(project, selfGroup).length, 0);
  assert.equal(sendLog(project).length, 0);

  const soloGroup = setup(project, '매니저 없음', [
    { name: 'WRKR301[claude]', surface: WORKER, ref: 'surface:70', roles: ['worker'] },
  ]);
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: soloGroup, number: 1, field: 'result', mode: 'replace', text: '받을 사람이 없습니다',
  }, WORKER);
  assert.equal(logOf(project, soloGroup).length, 0);
  assert.equal(sendLog(project).length, 0);
  console.log('self_report_lines=0');
  console.log('no_manager_lines=0');
});

test('G10: 받는 매니저가 태스크를 열면 읽음이 되고 다른 패널이 열면 그대로다', () => {
  const project = fixture('task-mcp-g10-read-');
  const groupId = setup(project, '읽음 표시');
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'replace', text: '읽어 주십시오',
  }, WORKER);

  // 보낸 사람이 열어도 읽음이 되지 않습니다 — to 가 아니기 때문입니다.
  callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, WORKER);
  assert.equal(logOf(project, groupId)[0].state, 'delivered');
  callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, TESTER);
  assert.equal(logOf(project, groupId)[0].state, 'delivered');

  callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, MANAGER);
  const log = logOf(project, groupId);
  assert.equal(log[0].state, 'read');
  assert.ok(log[0].read_at);
  console.log('read_on_manager_task_get=true');
  console.log('read_needs_to_surface=true');
});

test('G10: message_list 는 상태별로 답하고 실패에는 까닭을 보인다', () => {
  const project = fixture('task-mcp-g10-list-');
  const groupId = setup(project, '기록 조회');
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'replace', text: '보낸 보고',
  }, WORKER);
  withSendFailure(() => callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, field: 'result', mode: 'append', text: '못 보낸 보고',
  }, WORKER));

  // 기본은 read 가 아닌 것 전부입니다.
  const base = callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId }, MANAGER);
  assert.match(base, /안 읽은 것 2건 \/ 기록 전체 2건/);
  assert.match(base, /\[보냄\]/);
  assert.match(base, /\[실패\] — 까닭 send 실패\(가짜\)/);

  const failed = callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'failed' }, MANAGER);
  assert.match(failed, /실패 1건 \/ 기록 전체 2건/);
  assert.match(failed, /못 보낸 보고/);
  // 번호로 가립니다 — 「못 보낸 보고」가 「보낸 보고」를 품고 있어 글자로는 못 가립니다.
  assert.match(failed, /^ {2}2\. \[실패\]/m);
  assert.doesNotMatch(failed, /^ {2}1\. /m, '보낸 줄(1번)은 failed 목록에 없어야 합니다.');

  const delivered = callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'delivered' }, MANAGER);
  assert.match(delivered, /보냄 1건 \/ 기록 전체 2건/);
  assert.match(delivered, /^ {2}1\. \[보냄\]/m);
  assert.doesNotMatch(delivered, /^ {2}2\. /m);

  const all = callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'all' }, MANAGER);
  assert.match(all, /전부 2건 \/ 기록 전체 2건/);

  callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, MANAGER);
  assert.match(
    callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId }, MANAGER),
    /안 읽은 보고 없음/,
  );
  assert.match(
    callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'read' }, MANAGER),
    /\[읽음\]/,
  );

  // 쌓아 두던 시절의 값은 더 이상 받지 않습니다.
  assert.match(
    callToolError(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'queued' }, MANAGER),
    /state 는 delivered \| failed \| read \| all 중 하나여야 합니다/,
  );
  console.log('message_list_states=delivered,failed,read,all');
});

test('G10: 그룹을 마감해도 오류가 없고 듣는 매니저 파일이 생기지 않는다', () => {
  const project = fixture('task-mcp-g10-done-');
  const groupId = setup(project, '마감');
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId, number: 1, status: 'completed', field: 'result', mode: 'replace', text: '끝',
  }, WORKER);

  const closed = callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: groupId, status: 'done',
  }, MANAGER);
  assert.match(closed, /그룹 업데이트/);
  assert.doesNotMatch(closed, /듣는 매니저/);
  assert.equal(fs.existsSync(path.join(mcpTaskRoot(project), 'LISTENERS.json')), false);
  // 기록은 마감 뒤에도 그대로 읽힙니다.
  assert.match(
    callTool(PROJECT_SERVER, project, 'message_list', { group_id: groupId, state: 'all' }, MANAGER),
    /전부 1건/,
  );
  console.log('group_done_no_listeners_file=true');
});

test('G10: 듣기 등록 도구가 더 이상 없다', () => {
  const project = fixture('task-mcp-g10-no-listen-');
  const error = callToolError(PROJECT_SERVER, project, 'task_group_listen', { group_id: 'x' }, MANAGER);
  assert.match(error, /알 수 없는 도구: task_group_listen/);
  console.log('task_group_listen_removed=true');
});

// polls 는 Enter 전에 글이 보이는지 읽은 횟수, reads 는 Enter 뒤 제출을 확인한 횟수입니다.
for (const [script, polls, keys, reads, state, reason] of [
  ['busy', 1, 1, 1, 'delivered', null],
  ['idle-empty', 1, 1, 1, 'delivered', null],
  ['idle-stuck-once', 1, 2, 2, 'delivered', null],
  ['idle-stuck-twice', 1, 2, 2, 'failed', '입력창에 남음(Enter 2회)'],
  ['read-error', 1, 1, 1, 'delivered', '확인 못 함: read-screen 실패(가짜)'],
  ['idle-stuck-wrapped', 1, 2, 2, 'failed', '입력창에 남음(Enter 2회)'],
  ['idle-stuck-stale-marker', 1, 2, 2, 'failed', '입력창에 남음(Enter 2회)'],
  ['busy-codex', 1, 1, 1, 'delivered', null],
  ['text-late', 3, 1, 1, 'delivered', null],
  ['text-never', 10, 1, 1, 'delivered', null],
]) {
  test(`G10: 보낸 뒤 확인 ${script} — ${state}, 글 확인 ${polls}회, Enter ${keys}회, 읽기 ${reads}회`, () => {
    const project = fixture(`task-mcp-g10-${script}-`);
    const groupId = setup(project, script);
    process.env.TASK_MCP_FAKE_SCREEN = script;
    let output;
    try {
      output = callTool(PROJECT_SERVER, project, 'task_update', {
        group_id: groupId, number: 1, status: 'completed',
        field: 'result', mode: 'replace', text: '확인 결과와 관계없이 완료 결과를 저장했습니다.',
      }, WORKER);
    } finally {
      delete process.env.TASK_MCP_FAKE_SCREEN;
    }
    const commands = commandLog(project);
    // Enter 는 글이 보이는지 읽은 뒤에만 나갑니다. 글과 같은 읽기에 걸리면 줄바꿈이 되기 때문입니다(2026-10-12 실측).
    assert.deepEqual(commands.map((entry) => entry.op), [
      'send', ...Array(polls).fill('read-screen'), 'send-key', 'read-screen', ...(keys === 2 ? ['send-key', 'read-screen'] : []),
    ]);
    assert.deepEqual(commands.filter((entry) => entry.op === 'send-key').map((entry) => entry.key), Array(keys).fill('Enter'));
    assert.deepEqual(commands.filter((entry) => entry.op === 'read-screen').map((entry) => entry.lines), Array(polls + reads).fill(20));
    assert.ok(commands.every((entry) => entry.surface === MANAGER));
    assert.equal(commands[0].text.includes('\n'), false, '보고 본문에 빈 줄을 덧붙이지 않습니다.');
    const [entry] = logOf(project, groupId);
    assert.equal(entry.state, state);
    assert.equal(entry.reason, reason);
    assert.equal(Boolean(entry.sent_at), state === 'delivered');
    assert.equal(logOf(project, groupId).length, 1);
    if (script === 'idle-stuck-once') assert.match(output, /보고를 보냈습니다\. \(Enter 를 한 번 더 보냈습니다\)/);
    else assert.doesNotMatch(output, /Enter 를 한 번 더 보냈습니다/);
    if (state === 'failed') assert.ok(output.includes(`보내지 못했습니다(${reason})`));
    const task = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }, WORKER);
    assert.match(task, /\(completed\)/);
    assert.match(task, /확인 결과와 관계없이 완료 결과를 저장했습니다\./);
    console.log(`screen=${script} ops=${commands.map((entry) => entry.op).join(',')} state=${state} reason=${reason}`);
  });
}

test('G10: 두 입력 프롬프트와 두 작업 중 마커를 보고 제출된 대화는 재전송하지 않는다', () => {
  const text = '[task-mcp] WRKR2100 (surface:79) 이 2026-10-09-시험 task-1 완료 보고입니다.';
  for (const prompt of ['❯', '›']) {
    assert.equal(reportIsInInput(`${prompt} ${text}\n\n`, text), true);
    assert.equal(reportIsInInput(`${prompt}\n  ${text.slice(0, 40)}\n  나머지 입력`, text), true);
    assert.equal(reportIsInInput(`${prompt} 다른 입력`, text), false);
    assert.equal(reportIsInInput(`${prompt} ${text}\n응답했습니다.\n${prompt} `, text), false);
    assert.equal(reportIsInInput(`\u001b[32m${prompt}\u001b[0m ${text}`, text), true);
    assert.equal(reportIsInInput(`esc to interrupt\n${prompt} ${text}`, text), true);
    assert.equal(reportIsInInput(`${prompt} ${text}\nesc to interrupt`, text), false);
    assert.equal(reportIsInInput(`Working (2s)\n${prompt} ${text}`, text), false);
    assert.equal(reportIsInInput(`${prompt} ${text}\nWorking (2s)`, text), true);
    for (const marker of ['esc to interrupt', 'Working (2s)']) {
      const padding = Array(19).fill('이전 줄').join('\n');
      assert.equal(reportIsInInput(`${marker}\n${padding}\n${prompt} ${text}`, text), true, '꼬리 20줄 밖의 옛 마커는 무시합니다.');
    }
  }
  assert.equal(reportIsInInput(text, text), false, '프롬프트 없는 대화 줄만으로는 입력창에 남았다고 판단하지 않습니다.');
});

test('G10: 글이 보이는지는 마커와 무관하게 마지막 프롬프트 아래만 봅니다', () => {
  const text = '[task-mcp] WRKR2100 (surface:79) 이 2026-10-12-시험 task-1 완료 보고입니다.';
  for (const prompt of ['❯', '›']) {
    assert.equal(reportIsVisible(`${prompt} ${text}`, text), true);
    assert.equal(reportIsVisible(`${prompt} ${text}\nesc to interrupt`, text), true, '일하는 중이어도 글이 입력창에 들어갔으면 보인 것입니다.');
    assert.equal(reportIsVisible(`• Working (3s)\n\n${prompt} ${text}`, text), true);
    assert.equal(reportIsVisible(`${prompt}\n  ${text.slice(0, 40)}\n  접힌 둘째 줄`, text), true);
    assert.equal(reportIsVisible(`${prompt} `, text), false, '아직 안 들어간 빈 입력창입니다.');
    assert.equal(reportIsVisible(`${prompt} 다른 입력`, text), false);
    assert.equal(reportIsVisible(`${text}\n응답했습니다.\n${prompt} `, text), false, '지난 대화에 같은 글이 있어도 입력창에 보인 것이 아닙니다.');
  }
  assert.equal(reportIsVisible(text, text), false, '프롬프트가 없으면 보였다고 하지 않습니다.');
});

test('G10: 끝에서 7·13·19번째 줄의 낡은 마커는 남은 보고를 가리지 않습니다', () => {
  const text = '[task-mcp] WRKR2100의 완료 보고가 입력창에 남아 있습니다.';
  for (const prompt of ['❯', '›']) {
    for (const fromEnd of [7, 13, 19]) {
      const lines = [...Array(14).fill('지난 턴의 대화'), '─', `${prompt} ${text}`, '  접힌 입력 둘째 줄', '  접힌 입력 셋째 줄', '─', '  ? for shortcuts'];
      lines[lines.length - fromEnd] = '✻ Harmonizing… (esc to interrupt)';
      assert.equal(reportIsInInput(lines.join('\n'), text), true, `${prompt}: 끝에서 ${fromEnd}번째 낡은 마커`);
    }
    const quoted = '[task-mcp] Working (과 esc to interrupt를 포함한 보고입니다.';
    assert.equal(reportIsInInput(`${prompt} ${quoted}`, quoted), true, '프롬프트 줄의 보고 본문은 상태줄이 아닙니다.');
  }
});

test('G10: Working 진행 줄은 마지막 프롬프트 위 3줄 안에서만 인정합니다', () => {
  const text = '[task-mcp] codex 입력창에 대기하는 보고입니다.';
  for (const marker of ['Working (3s)', '  Working (3s)', ' • Working (3s)', '  · Working (3s)', '* Working (3s)', '- Working (3s)', '\u001b[32m• Working (3s)\u001b[0m']) {
    for (const distance of [1, 2, 3, 4]) {
      const screen = [marker, ...Array(distance - 1).fill(''), `› ${text}`].join('\n');
      assert.equal(reportIsInInput(screen, text), distance > 3, `${marker}: 프롬프트 위 ${distance}줄`);
    }
  }
  assert.equal(reportIsInInput(`지난 출력: Working (3s)\n› ${text}`, text), true);
  assert.equal(reportIsInInput(`Working (3s)\n› 이전 입력\n응답 1\n응답 2\n› ${text}`, text), true, '마지막 프롬프트를 기준으로 합니다.');
});

test('G10: 실제 어댑터는 글이 보인 뒤에 Enter 를 보내고, 확인 읽기마다 지정한 시간만 기다리며 20줄을 요청합니다', () => {
  const savedWait = process.env.TASK_MCP_CONFIRM_WAIT_MS;
  const text = '[task-mcp] 보고 전송과 실제 어댑터 읽기 순서를 확인하는 글입니다.';
  const read = ['read-screen', '--surface', MANAGER, '--scrollback', '--lines', '20'];
  try {
    for (const [configured, expected] of [[undefined, 1000], ['0', 0], ['12', 12], ['invalid', 1000], ['-1', 1000]]) {
      if (configured === undefined) delete process.env.TASK_MCP_CONFIRM_WAIT_MS;
      else process.env.TASK_MCP_CONFIRM_WAIT_MS = configured;
      const calls = [];
      const cmux = makeCmux({
        fake: false,
        run(args) { calls.push(args); return args[0] === 'read-screen' ? `❯ ${text}` : ''; },
        wait(ms) { calls.push(['wait', ms]); },
      });
      assert.deepEqual(cmux.send(MANAGER, text), { ok: false, reason: '입력창에 남음(Enter 2회)' });
      assert.deepEqual(calls, [
        ['send', '--surface', MANAGER, text],
        ['wait', 200], read,
        ['send-key', '--surface', MANAGER, 'Enter'], ['wait', expected], read,
        ['send-key', '--surface', MANAGER, 'Enter'], ['wait', expected], read,
      ]);
    }
    // 글이 늦게 보이는 패널 — 0.2초 간격으로 다시 읽고, 보인 뒤에야 Enter 가 나갑니다. 끝까지 안 보이면 열 번 뒤 Enter 입니다.
    for (const [visibleAt, expectedPolls] of [[3, 3], [Infinity, 10]]) {
      process.env.TASK_MCP_CONFIRM_WAIT_MS = '0';
      const calls = [];
      let readCount = 0;
      const cmux = makeCmux({
        fake: false,
        run(args) {
          calls.push(args[0]);
          if (args[0] !== 'read-screen') return '';
          readCount += 1;
          return readCount >= visibleAt && readCount <= expectedPolls ? `❯ ${text}` : '지난 턴의 대화\n❯ ';
        },
        wait(ms) { calls.push(`wait ${ms}`); },
      });
      assert.deepEqual(cmux.send(MANAGER, text), { ok: true, retried: false });
      assert.deepEqual(calls, [
        'send', ...Array(expectedPolls).fill(['wait 200', 'read-screen']).flat(),
        'send-key', 'wait 0', 'read-screen',
      ]);
    }
    process.env.TASK_MCP_CONFIRM_WAIT_MS = '5';
    const started = performance.now();
    let reads = 0;
    const nativeWait = makeCmux({ fake: false, run: (args) => (args[0] === 'read-screen' && (reads += 1) === 1 ? `❯ ${text}` : '') });
    assert.equal(nativeWait.send(MANAGER, text).ok, true);
    assert.ok(performance.now() - started >= 205, '실제 동기 대기(글 확인 200ms + 확인 5ms)도 적용됩니다. 외부 실행은 주입 함수로 막았습니다.');
  } finally {
    if (savedWait === undefined) delete process.env.TASK_MCP_CONFIRM_WAIT_MS;
    else process.env.TASK_MCP_CONFIRM_WAIT_MS = savedWait;
  }
});

test('G10: 읽기 오류 reason은 첫 줄만 쓰고 접두사를 포함해 120자로 자릅니다', () => {
  for (const message of ['첫 줄\r\nstderr 전문\n둘째 오류', `${'긴'.repeat(160)}\n경로와 stderr 전문`, '\u001b[31m읽기\t오류\u001b[0m\nstderr']) {
    const cmux = makeCmux({
      fake: false, wait() {},
      run(args) { if (args[0] === 'read-screen') throw new Error(message); return ''; },
    });
    const result = cmux.send(MANAGER, '보고');
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.ok(result.reason.length <= 120);
    assert.doesNotMatch(result.reason, /[\r\n\t\u001b]|stderr|둘째|전문/);
    if (message.startsWith('첫')) assert.equal(result.reason, '확인 못 함: 첫 줄');
    if (message.startsWith('긴')) assert.equal(result.reason.length, 120);
    if (message.startsWith('\u001b')) assert.equal(result.reason, '확인 못 함: 읽기 오류');
  }
});

test('G10: 읽기 오류는 stderr의 첫 비어 있지 않은 줄을 우선 쓰고 없으면 message를 씁니다', () => {
  const message = 'Command failed: /fixture/cmux read-screen\n명령의 두 번째 줄';
  for (const [stderr, expected] of [
    ['\r\n  \t\r\n\u001b[31mread-screen\tboom 첫 줄\u001b[0m\r\n숨겨야 할 둘째 줄', '확인 못 함: read-screen boom 첫 줄'],
    [Buffer.from('\nread-screen buffer 오류\n숨겨야 할 둘째 줄'), '확인 못 함: read-screen buffer 오류'],
    [`${'긴'.repeat(160)}\n숨겨야 할 둘째 줄`, `확인 못 함: ${'긴'.repeat(160)}`.slice(0, 120)],
    ['', `확인 못 함: ${message.split('\n')[0]}`],
    ['\r\n \t\n\u001b[0m', `확인 못 함: ${message.split('\n')[0]}`],
    [undefined, `확인 못 함: ${message.split('\n')[0]}`],
  ]) {
    const cmux = makeCmux({
      fake: false, wait() {},
      run(args) {
        if (args[0] === 'read-screen') throw Object.assign(new Error(message), { stderr });
        return '';
      },
    });
    const result = cmux.send(MANAGER, '보고');
    assert.deepEqual(result, { ok: true, retried: false, reason: expected });
    assert.ok(result.reason.length <= 120);
    assert.doesNotMatch(result.reason, /[\r\n\t\u001b]|둘째/);
  }
});

test('G10: 가짜 busy 두 가지와 낡은 마커 대본은 지정된 프롬프트 위치를 재현합니다', () => {
  const savedEnv = Object.fromEntries(['CLAUDE_PROJECT_DIR', 'TASK_MCP_FAKE_SCREEN'].map((key) => [key, process.env[key]]));
  try {
    // 읽기 횟수는 Enter 전 글 확인 1회가 더해진 수입니다.
    for (const [script, expectedPrompt, expectedReads] of [['busy', 0, 2], ['busy-codex', 2, 2], ['idle-stuck-stale-marker', 7, 3]]) {
      process.env.CLAUDE_PROJECT_DIR = fixture(`task-mcp-g10-screen-${script}-`);
      process.env.TASK_MCP_FAKE_SCREEN = script;
      const cmux = makeCmux({ fake: true });
      const screens = [];
      const readScreen = cmux.readScreen.bind(cmux);
      cmux.readScreen = (surface) => { const screen = readScreen(surface); screens.push(screen); return screen; };
      assert.equal(cmux.send(MANAGER, '[task-mcp] 화면 위치 검사 보고').ok, script !== 'idle-stuck-stale-marker');
      assert.equal(screens.length, expectedReads);
      const lines = screens[0].split('\n');
      assert.equal(lines.findIndex((line) => /^[❯›]/.test(line)), expectedPrompt);
      if (script === 'busy') assert.match(lines[2], /esc to interrupt/);
      else if (script === 'busy-codex') assert.equal(lines[0], '• Working (3s • esc to interrupt)');
      else {
        assert.equal(lines[0], '✻ Harmonizing… (esc to interrupt)');
        assert.equal(screens[1], screens[0]);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('G10: 접힌 가짜 입력창은 6줄로 잘라선 안 잡히고 20줄에서 잡히며 기다리지 않습니다', () => {
  const project = fixture('task-mcp-g10-wrapped-window-');
  const savedEnv = Object.fromEntries(['CLAUDE_PROJECT_DIR', 'TASK_MCP_FAKE_SCREEN', 'TASK_MCP_CONFIRM_WAIT_MS'].map((key) => [key, process.env[key]]));
  process.env.CLAUDE_PROJECT_DIR = project;
  process.env.TASK_MCP_FAKE_SCREEN = 'idle-stuck-wrapped';
  process.env.TASK_MCP_CONFIRM_WAIT_MS = '60000';
  try {
    const cmux = makeCmux({ fake: true, wait() { assert.fail('가짜 어댑터가 기다렸습니다.'); } });
    const text = '[task-mcp] '.padEnd(300, '보고');
    cmux.sendText(MANAGER, text);
    const screen = cmux.readScreen(MANAGER);
    assert.equal(screen.split('\n').length, 9);
    assert.equal(screen.split('\n').filter((line) => /보고/.test(line)).length, 5);
    assert.equal(reportIsInInput(screen.split('\n').slice(-6).join('\n'), text), false);
    assert.equal(reportIsInInput(screen, text), true);
    assert.equal(cmux.send(MANAGER, text).ok, false);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
