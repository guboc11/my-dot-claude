// 보고 직통 — 워커가 result · completed · outcome 을 적으면 그 자리에서 매니저 패널로 보냅니다.
//
// 설계: 태스크 그룹 `task-group-2026-09-18-보고-직통-전환` 의 노트 1 「대본」 2 · 3 · 4 · 5절
// (2026-09-18 관리자님 결정).
//
// 매니저가 쉬는지 일하는지 **판정하지 않습니다.** 일하는 중이면 그 줄이 다음 입력으로 줄을 서는
// 것으로 충분합니다. 보내기 전에는 기다리지 않고, 보낸 뒤 화면만 읽어 제출 여부를 확인합니다.
// 쌓아 두는 상태 · Stop hook · 듣기 등록은 없습니다. 큐 파일은 보낸 결과만 남깁니다.
//
// cmux 가 없는 환경에서도 돌아야 하므로 send 는 주입 가능하고, TASK_MCP_FAKE_CMUX=1 이면 기록만
// 하는 가짜를 씁니다. TASK_MCP_FAKE_SEND_FAIL=1 이면 그 가짜가 실패를 돌려줍니다.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

import {
  now,
  projectDir,
  queuePath,
  requireGroup,
} from '../lib.mjs';
import { cmuxBinary } from '../model.mjs';

// 보낸 결과 둘과 읽음 하나. 보내지 않고 쌓아 두는 상태는 없습니다.
export const MESSAGE_STATES = ['delivered', 'failed', 'read'];
export const FAKE_SEND_LOG = '.task-mcp-fake-cmux.jsonl';
export const SUMMARY_LIMIT = 200;
const CONFIRM_LINES = 20;

// ── cmux 어댑터 ────────────────────────────────────────────────────────────────

// 글을 보낸 뒤 그 글이 입력창에 보일 때까지 기다리는 횟수와 간격입니다. 받는 패널이 글을 읽기 전에
// Enter 가 닿으면 같은 읽기에 「글+\r」로 합쳐져 줄바꿈이 되고, 그 뒤의 Enter 한 번은 씹힙니다
// (2026-10-12 실측 — 그룹 2026-10-12-디방-웨딩-기능-개선의 보고 5건이 이렇게 입력창에 남았습니다).
// 글이 화면에 보이면 패널이 이미 읽은 뒤이므로 그다음에 가는 Enter 는 합쳐질 수 없습니다.
const VISIBLE_POLLS = 10;
const VISIBLE_POLL_MS = 200;

function tailLines(screen) {
  return stripVTControlCharacters(String(screen)).trimEnd().split('\n').slice(-CONFIRM_LINES);
}

function lastPromptIndex(lines) {
  return lines.findLastIndex((line) => /^\s*[❯›](?:\s|$)/.test(line));
}

function textAfterPrompt(lines, prompt, text) {
  return lines.slice(prompt).join('\n').includes(text.slice(0, 40));
}

// 보낸 글이 마지막 입력 프롬프트부터 아래에 보이는지 — 작업 중 마커와 무관하게 글이 입력창에
// 들어갔는지만 봅니다. Enter 를 보내기 전의 확인입니다.
export function reportIsVisible(screen, text) {
  const lines = tailLines(screen);
  const prompt = lastPromptIndex(lines);
  return prompt >= 0 && textAfterPrompt(lines, prompt, text);
}

export function reportIsInInput(screen, text) {
  const lines = tailLines(screen);
  // 대화에 다시 그려진 보고는 마지막 입력 프롬프트보다 위에 있으므로 제외합니다.
  const prompt = lastPromptIndex(lines);
  if (prompt < 0) return false;
  // 지난 턴의 출력에 찍힌 마커가 현재 입력창의 잔여 보고를 가리지 않게 합니다.
  if (lines.slice(prompt + 1).some((line) => line.includes('esc to interrupt'))) return false;
  if (lines.slice(Math.max(0, prompt - 3), prompt).some((line) => /^\s*(?:[•·*-]\s*)?Working \(/.test(line))) return false;
  return textAfterPrompt(lines, prompt, text);
}

function confirmWaitMs() {
  const configured = Number(process.env.TASK_MCP_CONFIRM_WAIT_MS ?? 1000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1000;
}

function readFailureReason(cause) {
  const stderrLine = stripVTControlCharacters(String(cause.stderr ?? '')).split(/[\r\n]/).find((line) => line.trim());
  const firstLine = (stderrLine ?? stripVTControlCharacters(String(cause.message ?? cause)).split(/[\r\n]/, 1)[0]).replace(/\s+/g, ' ').trim();
  return `확인 못 함: ${firstLine}`.slice(0, 120);
}

// 글이 입력창에 보일 때까지 짧게 여러 번 읽습니다. 끝까지 안 보이거나 읽기가 실패하면 그대로
// Enter 로 넘어갑니다 — 보낸 뒤 확인(sendAndConfirm)이 같은 실패를 reason 으로 남깁니다.
function waitUntilVisible(cmux, surface, text) {
  for (let poll = 0; poll < VISIBLE_POLLS; poll += 1) {
    cmux.wait(VISIBLE_POLL_MS);
    let screen;
    try {
      screen = cmux.readScreen(surface);
    } catch {
      return false;
    }
    if (reportIsVisible(screen, text)) return true;
  }
  return false;
}

// 순서: 글 → 글이 입력창에 보일 때까지 기다림 → Enter 한 번 → 제출 확인 → 남았으면 한 번 더.
function sendAndConfirm(cmux, surface, text) {
  let retried = false;
  try {
    cmux.sendText(surface, text);
    waitUntilVisible(cmux, surface, text);
    cmux.sendEnter(surface);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      cmux.wait(confirmWaitMs());
      let screen;
      try {
        screen = cmux.readScreen(surface);
      } catch (cause) {
        return { ok: true, retried, reason: readFailureReason(cause) };
      }
      if (!reportIsInInput(screen, text)) return { ok: true, retried };
      if (attempt === 0) {
        cmux.sendEnter(surface);
        retried = true;
      }
    }
    return { ok: false, reason: '입력창에 남음(Enter 2회)' };
  } catch (cause) {
    return { ok: false, reason: cause.code === 'ENOENT' ? 'cmux 없음' : `send 실패: ${cause.message}` };
  }
}

function realCmux({
  run = (args) => execFileSync(cmuxBinary(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  return {
    send(surface, text) {
      return sendAndConfirm(this, surface, text);
    },
    sendText(surface, text) {
      run(['send', '--surface', surface, text]);
    },
    sendEnter(surface) {
      run(['send-key', '--surface', surface, 'Enter']);
    },
    wait(ms) {
      wait(ms);
    },
    readScreen(surface) {
      return run(['read-screen', '--surface', surface, '--scrollback', '--lines', String(CONFIRM_LINES)]);
    },
  };
}

function fakeCmux() {
  const logPath = path.join(projectDir(), FAKE_SEND_LOG);
  const log = (entry) => fs.appendFileSync(logPath, `${JSON.stringify({ at: now(), ...entry })}\n`);
  let sentText = '';
  let entered = false;
  let polls = 0; // Enter 전 읽기 — 글이 보이는지
  let reads = 0; // Enter 뒤 읽기 — 제출됐는지
  // 글이 입력창에 들어가 있는 화면. Enter 전 확인과 Enter 뒤의 「남음」에 같은 꼴을 씁니다.
  const inputScreen = (script) => {
    if (script === 'busy') return `❯ ${sentText}\n${'─'.repeat(60)}\n✻ Harmonizing… (esc to interrupt)`;
    if (script === 'busy-codex') return `• Working (3s • esc to interrupt)\n\n› ${sentText}`;
    if (script === 'idle-stuck-stale-marker') {
      return ['✻ Harmonizing… (esc to interrupt)', ...Array(6).fill('지난 턴의 대화'), `❯ ${sentText}`, '─'.repeat(60), '  ? for shortcuts'].join('\n');
    }
    if (script === 'idle-stuck-wrapped') {
      const width = Math.max(40, Math.ceil(sentText.length / 5));
      const lines = Array.from({ length: 5 }, (_, index) => `${index === 0 ? '❯ ' : '  '}${sentText.slice(index * width, (index + 1) * width)}`);
      return ['─'.repeat(60), ...lines, '─'.repeat(60), '  model · context remaining', '  ? for shortcuts'].join('\n');
    }
    return `› ${sentText}\n\n`;
  };
  return {
    send(surface, text) {
      if (process.env.TASK_MCP_FAKE_SEND_FAIL === '1') {
        return { ok: false, reason: 'send 실패(가짜)' };
      }
      return sendAndConfirm(this, surface, text);
    },
    sendText(surface, text) {
      sentText = text;
      entered = false;
      polls = 0;
      reads = 0;
      log({ op: 'send', surface, text });
    },
    sendEnter(surface) {
      entered = true;
      log({ op: 'send-key', surface, key: 'Enter' });
    },
    wait() {},
    readScreen(surface) {
      log({ op: 'read-screen', surface, lines: CONFIRM_LINES });
      const script = process.env.TASK_MCP_FAKE_SCREEN || 'idle-empty';
      if (script === 'read-error') throw new Error('read-screen 실패(가짜)');
      if (!entered) {
        // Enter 전 — 글이 아직 안 보이는 패널(text-late 는 세 번째 읽기부터, text-never 는 끝까지)도 재현합니다.
        polls += 1;
        if (script === 'text-never') return '지난 턴의 대화\n❯ ';
        if (script === 'text-late' && polls <= 2) return '지난 턴의 대화\n❯ ';
        return inputScreen(script);
      }
      reads += 1;
      if (['busy', 'busy-codex', 'idle-stuck-stale-marker', 'idle-stuck-wrapped'].includes(script)) return inputScreen(script);
      if (script === 'idle-stuck-twice' || (script === 'idle-stuck-once' && reads === 1)) return inputScreen(script);
      return `${sentText}\n처리했습니다.\n❯ `;
    },
  };
}

export function makeCmux({ fake, run, wait } = {}) {
  const useFake = fake === undefined ? process.env.TASK_MCP_FAKE_CMUX === '1' : fake;
  return useFake ? fakeCmux() : realCmux({ run, wait });
}

export function readFakeSendLog(project = projectDir()) {
  try {
    return fs.readFileSync(path.join(project, FAKE_SEND_LOG), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ── 기록 파일 ──────────────────────────────────────────────────────────────────

export function readQueue(groupDir) {
  let text;
  try { text = fs.readFileSync(queuePath(groupDir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 깨진 줄은 건너뜁니다 */ }
  }
  return out;
}

export function appendLine(groupDir, entry) {
  fs.appendFileSync(queuePath(groupDir), `${JSON.stringify(entry)}\n`);
  return entry;
}

// 줄을 바꿀 때는 파일 전체를 읽어 그 줄만 고쳐 임시 파일에 쓰고 rename 합니다.
function rewriteQueue(groupDir, entries) {
  const file = queuePath(groupDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(temporary, file);
}

export function updateEntries(groupDir, match, patch) {
  const entries = readQueue(groupDir);
  const changed = [];
  const next = entries.map((entry) => {
    if (!match(entry)) return entry;
    changed.push(entry.id);
    return { ...entry, ...patch };
  });
  if (changed.length) rewriteQueue(groupDir, next);
  return changed;
}

// 받는 쪽이 그 태스크를 여는 것이 곧 읽음 표시입니다.
export function markRead(groupDir, taskNumber, surface) {
  if (!surface) return [];
  return updateEntries(
    groupDir,
    (entry) => entry.task === taskNumber
      && entry.to?.surface === surface
      && entry.state !== 'read',
    { state: 'read', read_at: now() },
  );
}

// ── 보내는 글 ──────────────────────────────────────────────────────────────────

// cmux send 는 백틱과 작은따옴표를 못 받고 줄바꿈이 섞이면 줄이 갈립니다(2026-08-26 실측).
export function cleanSummary(text) {
  const first = String(text ?? '')
    .split('\n')
    .find((line) => line.trim()) || '';
  return first
    .replace(/[`'\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_LIMIT);
}

// 사람이 읽는 표시입니다. ref 가 없으면 UUID 앞 8자를 씁니다(대본 2절).
export function personLabel(person) {
  return person?.ref || String(person?.surface || '').slice(0, 8);
}

export function buildLine(entry) {
  const judged = entry.outcome ? ` (${entry.outcome})` : '';
  const summary = entry.summary ? ` ${entry.summary}` : '';
  return `[task-mcp] ${entry.from.name} (${personLabel(entry.from)}) 이 ${entry.group_id} task-${entry.task} (${entry.kind}) 의 ${entry.event}${judged} 를 적었습니다.${summary} task_get ${entry.group_id} ${entry.task}`;
}

export function managerOf(record) {
  return (record?.members || []).find((entry) => entry.roles.includes('manager') && entry.surface) || null;
}

function personOf(record, surface) {
  const found = (record?.members || []).find((entry) => entry.surface === surface);
  if (found) return { name: found.name, surface: found.surface, ref: found.ref ?? null };
  return { name: String(surface || '').slice(0, 8), surface, ref: null };
}

// ── 보고 ───────────────────────────────────────────────────────────────────────

// 요약은 이번 호출이 result 에 적은 글의 첫 줄을 먼저 봅니다. append 로 붙였어도 새로 붙인 글이
// 요약이 되게 하려는 것입니다(대본 3절). 그 호출이 result 를 안 적었으면 result 전체의 첫 줄입니다.
export function summaryFor({ summarySource, result }) {
  const fromCall = cleanSummary(summarySource);
  return fromCall || cleanSummary(result);
}

export function report({
  groupDir, groupId, record, task, event, outcome = null, fromSurface, summarySource, cmux = makeCmux(),
}) {
  const manager = managerOf(record);
  // 받을 사람이 없거나 부른 패널이 곧 매니저이면 줄도 전송도 없습니다(대본 4절).
  if (!manager) return null;
  if (manager.surface === fromSurface) return null;

  const from = personOf(record, fromSurface);
  const to = { name: manager.name, surface: manager.surface, ref: manager.ref ?? null };
  const entries = readQueue(groupDir);
  const id = entries.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1;
  const summary = summaryFor({ summarySource, result: task.result });

  const draft = {
    id,
    at: now(),
    group_id: groupId,
    task: task.number,
    kind: task.kind,
    event,
    outcome,
    from,
    to,
    summary,
  };
  const line = buildLine(draft);

  // 판정하지 않고 그 자리에서 보냅니다. 일하는 중이면 다음 입력으로 줄을 섭니다.
  const sent = cmux.send(to.surface, line);
  const ok = Boolean(sent?.ok);
  if (!ok) {
    process.stderr.write(`[task-mcp] 보고 ${id} 를 매니저 패널로 보내지 못했습니다: ${sent?.reason || '까닭 모름'}\n`);
  }

  appendLine(groupDir, {
    ...draft,
    line,
    state: ok ? 'delivered' : 'failed',
    reason: sent?.reason || (ok ? null : '까닭 모름'),
    sent_at: ok ? now() : null,
    read_at: null,
  });
  return { id, ok, reason: sent?.reason || null, retried: Boolean(sent?.retried), to };
}

// 워커의 쓰기는 보내기가 실패해도 그대로 성공입니다. 그 사실만 답에 덧붙입니다(대본 4절).
export function reportNotice(result) {
  if (!result) return '';
  return result.ok
    ? `\n매니저 패널(${personLabel(result.to)})로 보고를 보냈습니다.${result.retried ? ' (Enter 를 한 번 더 보냈습니다)' : ''}`
    : `\n매니저 패널로 보내지 못했습니다(${result.reason}). message_list 로 확인하십시오.`;
}

// ── 기록 조회 ──────────────────────────────────────────────────────────────────

const STATE_LABEL = { delivered: '보냄', failed: '실패', read: '읽음' };

export function toolMessageList({ group_id, state }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  if (state != null && ![...MESSAGE_STATES, 'all'].includes(state)) {
    throw new Error(`state 는 ${MESSAGE_STATES.join(' | ')} | all 중 하나여야 합니다.`);
  }
  const found = requireGroup(group_id);
  const entries = readQueue(found.dir);
  const wanted = state == null
    ? entries.filter((entry) => entry.state !== 'read')
    : (state === 'all' ? entries : entries.filter((entry) => entry.state === state));

  if (!wanted.length) {
    return state == null
      ? `안 읽은 보고 없음: ${found.safe} (전부 보려면 state:"all").`
      : `보고 없음: ${found.safe} (state=${state}).`;
  }
  const lines = wanted.map((entry) => {
    const label = STATE_LABEL[entry.state] || entry.state;
    const judged = entry.outcome ? ` (${entry.outcome})` : '';
    const reason = entry.state === 'failed' && entry.reason ? ` — 까닭 ${entry.reason}` : '';
    return `  ${entry.id}. [${label}]${reason} ${entry.at} task-${entry.task} (${entry.kind}) ${entry.event}${judged} · ${entry.from.name}\n     ${entry.summary || '(요약 없음)'}`;
  });
  // 머리 줄이 무엇을 걸러 보이는지 밝힙니다. 앞뒤 수가 같으면 무엇을 본 것인지 알 수 없었습니다(백로그 14).
  const shown = state == null ? '안 읽은 것' : (state === 'all' ? '전부' : STATE_LABEL[state] || state);
  return `[${found.safe}] ${shown} ${wanted.length}건 / 기록 전체 ${entries.length}건\n${lines.join('\n')}`;
}
