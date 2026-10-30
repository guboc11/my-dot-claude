// task-mcp 쌓기 모델 — 상태·종류·파일 이름·전이·명단 규칙의 단일 원천.
//
// 설계: .claude/plans/2026-09-18-task-mcp-stack-model-overhaul/SPEC.md 2-1 · 2-2 · 3-1 · 3-2 · 5-1 ~ 5-5.
// lib.mjs 와 tools/*.mjs 가 이 파일을 불러 쓴다. 규칙을 두 군데 적지 않으려고 따로 뗀 파일이다.
//
// lib.mjs 가 이 파일을 되부를 때(B2-3) 순환 import 가 생긴다. STATUSES·MARK 같은 값은
// `export { STATUSES } from './model.mjs'` 꼴의 재수출로만 넘긴다 — `const X = model.X` 로 받으면
// 적재 순서에 따라 초기화 전 접근이 된다. 함수는 끌어올려지므로 순환에서도 안전하다.

import { execFileSync } from 'node:child_process';

import { slug } from './lib.mjs';

export const STATUSES = ['draft', 'pending', 'in_progress', 'completed'];
export const MARK = { draft: '[.]', pending: '[ ]', in_progress: '[~]', completed: '[x]' };
export const KINDS = ['work', 'test', 'review', 'feedback', 'onboard', 'research'];
export const ROLES = ['manager', 'worker', 'tester', 'reviewer'];

// KIND 가 역할을 정한다(SPEC 3-2). 빈 배열은 「누구든」이다.
export const KIND_ROLES = {
  work: ['worker'],
  feedback: ['worker'],
  test: ['tester'],
  review: ['reviewer'],
  onboard: [],
  research: [],
};

// work·feedback 은 지정 배정이라 빈 assignee 를 아무도 못 집는다(note-2 §25).
export function assigneeRule(kind) {
  return kind === 'work' || kind === 'feedback' ? 'mine' : 'mine_or_empty';
}

export function canTake(kind, assignee, surface) {
  const owned = String(assignee || '');
  if (assigneeRule(kind) === 'mine') return !!owned && owned === surface;
  return !owned || owned === surface;
}

export function kindsForRoles(roles) {
  const mine = Array.isArray(roles) ? roles : [];
  return KINDS.filter((kind) => {
    const required = KIND_ROLES[kind];
    return required.length === 0 || required.some((role) => mine.includes(role));
  });
}

// 그룹 전체에서 선행이 끝난 pending을 고릅니다. 역할·배정은 호출부가 별도로 봅니다.
export function receivablePending(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.number));
  return tasks.filter((task) => task.status === 'pending'
    && task.depends_on.every((dependency) => completed.has(dependency)))
    .sort((a, b) => b.priority - a.priority || a.number - b.number);
}

export function isBatch(value) {
  return typeof value === 'string' && /^b[1-9]\d*$/.test(value);
}

export function isKind(value) {
  return KINDS.includes(value);
}

export function isStatus(value) {
  return STATUSES.includes(value);
}

// 파일 이름: task-{번호}-{배치}-{종류}-{상태}-[태그]-{제목}.json (태그 없으면 [태그] 생략)
export function taskFileName(number, batch, kind, status, content, tag) {
  if (!isBatch(batch)) throw new Error(`batch 는 b 뒤에 양의 정수여야 합니다 (예: b1). 받은 값: ${batch ?? '(없음)'}`);
  if (!isKind(kind)) throw new Error(`kind 는 ${KINDS.join(' | ')} 중 하나여야 합니다. 받은 값: ${kind ?? '(없음)'}`);
  if (!isStatus(status)) throw new Error(`status 는 ${STATUSES.join(' | ')} 중 하나여야 합니다. 받은 값: ${status ?? '(없음)'}`);
  const t = tag ? `-[${slug(tag, 20)}]` : '';
  return `task-${number}-${batch}-${kind}-${status}${t}-${slug(content, 40)}.json`;
}

// 옛 꼴과 새 꼴을 모두 읽는다(SPEC 2-2). 번호 다음 토큰이 네 상태 값 가운데 하나이면 옛 꼴이고
// b{정수} 이면 새 꼴이다. 상태 값은 b{정수} 꼴이 될 수 없으므로 구별이 결정적이다.
// 둘 중 어느 쪽도 아니면 태스크 파일로 읽지 않고 null 을 돌려준다.
export function parseTaskFileName(file) {
  const head = /^task-(\d+)-(.+)\.json$/.exec(String(file ?? ''));
  if (!head) return null;
  const number = Number(head[1]);
  const tokens = head[2].split('-');

  if (isStatus(tokens[0])) {
    return { number, batch: '', kind: 'work', status: tokens[0], legacy: true };
  }
  if (isBatch(tokens[0]) && isKind(tokens[1]) && isStatus(tokens[2])) {
    return { number, batch: tokens[0], kind: tokens[1], status: tokens[2], legacy: false };
  }
  return null;
}

// 상태 전이(SPEC 5-3). in_progress 로 직접 가는 길은 없다 — task_next 만 올린다.
export const TRANSITIONS = {
  draft: ['pending'],
  pending: ['draft', 'in_progress'],
  // in_progress 에서 pending 으로 돌아가는 길은 담당자 본인이 잘못 집은 것을 놓아주는 자리다(백로그 12).
  // 겸임 매니저가 번호가 앞선 자기 work 를 먼저 집고 나면 review 를 집을 길이 없던 것이 계기다.
  in_progress: ['pending', 'completed'],
  completed: [],
};

export function canTransition(from, to) {
  if (!isStatus(from) || !isStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

function rolesOf(record, surface) {
  return memberOf(record, surface)?.roles || [];
}

function isManager(record, surface) {
  return rolesOf(record, surface).includes('manager');
}

// 상태를 바꿔도 되는지 본다. 어긋나면 아무것도 쓰지 않고 throw 한다.
// task 는 { owner, assignee, spec, kind, legacy } 이고 caller 는 부른 패널의 UUID 다.
export function transitionGuard({ from, to, task = {}, caller = '', record = null, storedAssignee }) {
  if (from === 'completed') throw new Error('completed 태스크는 바꿀 수 없습니다.');
  if (to === 'in_progress') throw new Error('in_progress 는 task_next 로만 갑니다.');
  if (!canTransition(from, to)) throw new Error(`${from} 에서 ${to} 로는 갈 수 없습니다.`);

  const manager = isManager(record, caller);

  if (from === 'draft' && to === 'pending') {
    if (!manager && caller !== task.owner) {
      throw new Error('draft 를 pending 으로 올리는 것은 매니저나 만든 패널만 할 수 있습니다.');
    }
    if (!task.legacy && !String(task.spec || '').trim()) {
      throw new Error('spec 이 비어 있어 pending 으로 올릴 수 없습니다.');
    }
    // work·feedback 은 지정 배정이라 assignee 가 비면 pending 이 되어도 아무도 못 집는다.
    if (assigneeRule(task.kind || 'work') === 'mine' && !String(task.assignee || '').trim()) {
      throw new Error('assignee 가 비어 있어 pending 으로 올릴 수 없습니다. members 의 worker 를 지정해 주십시오.');
    }
    return true;
  }

  if (from === 'pending' && to === 'draft') {
    if (!manager && caller !== task.owner) {
      throw new Error('pending 을 draft 로 내리는 것은 매니저나 만든 패널만 할 수 있습니다.');
    }
    return true;
  }

  // in_progress -> pending. 잘못 집은 것을 놓아주는 자리라 담당자 본인만 쓴다(백로그 12).
  // 매니저에게도 열지 않는다 — 남이 하던 일을 빼앗는 길이 되기 때문이다.
  //
  // 권한은 **이번 호출이 바꾸기 전에 저장돼 있던 담당자**로 본다. 바뀐 뒤의 값으로 보면
  // 남이 assignee 에 자기 UUID 를 함께 실어 남의 일을 반환할 수 있다(리뷰 29 실측).
  // 그래서 호출부가 `storedAssignee` 를 준다. 없으면 task.assignee 로 물러선다.
  if (from === 'in_progress' && to === 'pending') {
    const owner = String(storedAssignee ?? task.assignee ?? '');
    if (!owner || owner !== caller) {
      throw new Error('진행 중인 태스크를 pending 으로 되돌리는 것은 담당자 본인만 할 수 있습니다.');
    }
    // 되돌리는 호출은 담당자를 옮기는 자리가 아니다. 담당자를 바꾸려면 따로 부른다.
    // 빈 문자열도 「바뀐 값」이다 — 비우는 것을 빼 두면 그 길로 담당자가 사라졌다(리뷰 28).
    // 두 값은 **원문 그대로** 견준다. 다듬어서 견주면 앞뒤에 공백이 붙은 같은 UUID 가 통과하고
    // 공백째 저장돼, 엄격히 견주는 task_next 가 그 사람을 못 알아본다(리뷰 28 두 번째 실측).
    // 인자를 생략하면 task.assignee 가 저장된 값 그대로라 여기서 걸리지 않는다.
    const next = String(task.assignee ?? '');
    if (next !== owner) {
      throw new Error('되돌리는 호출에서는 담당자를 바꿀 수 없습니다. assignee 변경은 따로 부르십시오.');
    }
    return true;
  }

  // in_progress -> completed. assignee 가 비어 있는 옛 태스크는 누구든 끝낼 수 있게 둔다.
  const assignee = String(task.assignee || '');
  if (assignee && assignee !== caller && !manager) {
    throw new Error('이 태스크를 completed 로 바꾸는 것은 담당자나 매니저만 할 수 있습니다.');
  }
  return true;
}

const SURFACE_REF = /^(?:surface:)?(\d+)$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function normalizeMemberEntry(entry) {
  const raw = String(entry?.surface ?? '');
  const isRef = SURFACE_REF.test(raw);
  return {
    name: String(entry?.name ?? ''),
    // UUID 가 정본이다. surface:N 은 사람이 읽는 표시라 ref 로 옮긴다(note-5 §2-2 (2)).
    surface: isRef ? '' : raw,
    ref: isRef ? `surface:${SURFACE_REF.exec(raw)[1]}` : (entry?.ref ?? null),
    roles: Array.isArray(entry?.roles) ? [...entry.roles] : [],
    scope: entry?.scope ?? '',
    session: entry?.session ?? null,
  };
}

// 옛 레코드(worker·manager 두 칸)를 members 꼴로 읽는다. 파일은 쓰지 않는다(SPEC 3-1).
export function normalizeMembers(record) {
  if (!record || typeof record !== 'object') return [];
  if (Array.isArray(record.members)) return record.members.map(normalizeMemberEntry);

  const out = [];
  if (record.manager) out.push(normalizeMemberEntry({ ...record.manager, roles: ['manager'] }));
  if (record.worker) out.push(normalizeMemberEntry({ ...record.worker, roles: ['worker'] }));
  return out;
}

// 매니저 수만 본다. 옛 레코드에서 온 항목은 surface 가 비어 있어 전체 검사를 그대로 걸 수 없고,
// 합친 명단에 매니저가 둘이 되는 것만 막으면 되는 자리가 있다(group_update 의 갱신 뒤).
export function assertSingleManager(members) {
  const managers = (Array.isArray(members) ? members : [])
    .filter((entry) => Array.isArray(entry?.roles) && entry.roles.includes('manager'));
  if (managers.length > 1) {
    throw new Error(`매니저는 그룹당 한 명입니다. 받은 매니저 ${managers.length}명: ${managers.map((m) => m.name).join(', ')}`);
  }
  return members;
}

export function validateMembers(members) {
  if (!Array.isArray(members)) throw new Error('members 는 배열이어야 합니다.');
  for (const entry of members) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('members 항목은 { name, surface, roles } 형식이어야 합니다.');
    }
    if (!String(entry.name ?? '').trim()) throw new Error('members 항목에 name 이 필요합니다.');
    if (!String(entry.surface ?? '').trim()) throw new Error(`members 항목 "${entry.name}" 에 surface 가 필요합니다.`);
    const roles = entry.roles;
    if (!Array.isArray(roles) || !roles.length) {
      throw new Error(`members 항목 "${entry.name}" 의 roles 는 ${ROLES.join(' | ')} 중 하나 이상이어야 합니다.`);
    }
    for (const role of roles) {
      if (!ROLES.includes(role)) {
        throw new Error(`roles 는 ${ROLES.join(' | ')} 중 하나여야 합니다. 받은 값: ${role}`);
      }
    }
  }
  return assertSingleManager(members);
}

export function memberOf(record, surface) {
  const me = String(surface || '');
  if (!me) return null;
  return normalizeMembers(record).find((entry) => entry.surface && entry.surface === me) || null;
}

// 옛 명단(surface 가 비고 ref 만 있는 항목)만 남은 그룹인지 본다. 거절 문구에 안내를 덧붙일 때 쓴다.
export function hasLegacyMembers(record) {
  const members = normalizeMembers(record);
  return members.length > 0 && members.every((entry) => !entry.surface);
}

export function requireOwner(owner) {
  if (!String(owner || '').trim()) {
    throw new Error('cmux 패널 밖에서는 정체를 알 수 없어 거절합니다.');
  }
  return owner;
}

// 테스트용 고정 tree 출력. TASK_MCP_FAKE_CMUX=1 이면 이것을 읽는다.
export const FAKE_TREE = [
  'window window:1 00000000-0000-4000-8000-000000000000 [current]',
  '  surface surface:1 11111111-1111-4111-8111-111111111111 [terminal] "FAKE-MNGR[claude]"',
  '  surface surface:2 22222222-2222-4222-8222-222222222222 [terminal] "FAKE-WRKR[claude]"',
  '  surface surface:3 33333333-3333-4333-8333-333333333333 [terminal] "FAKE-TESTER[claude]"',
].join('\n');

export function cmuxBinary() {
  return process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
}

export function defaultRunTree() {
  if (process.env.TASK_MCP_FAKE_CMUX === '1') return FAKE_TREE;
  return execFileSync(cmuxBinary(), ['tree', '--all', '--id-format', 'both'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

// surface:N 을 UUID 로 바꾼다. UUID 를 그대로 주면 조회하지 않는다(note-5 §2-2 (2)).
export function resolveSurface(value, runTree = defaultRunTree) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('surface 값이 비어 있습니다.');
  if (UUID.test(raw)) return { surface: raw, ref: null };

  const ref = SURFACE_REF.exec(raw);
  if (!ref) throw new Error(`surface 는 UUID 이거나 surface:N 꼴이어야 합니다. 받은 값: ${raw}`);

  const number = ref[1];
  let tree;
  try {
    tree = String(runTree());
  } catch (cause) {
    throw new Error(`cmux tree 를 부르지 못해 surface:${number} 를 UUID 로 바꿀 수 없습니다: ${cause.message}`);
  }
  const found = new RegExp(`surface\\s+surface:${number}\\s+([0-9A-Fa-f-]{36})`).exec(tree);
  if (!found) throw new Error(`surface:${number} 패널을 cmux 에서 찾지 못했습니다.`);
  return { surface: found[1], ref: `surface:${number}` };
}
