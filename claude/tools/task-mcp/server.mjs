#!/usr/bin/env node
// task-mcp — 무의존성 MCP stdio 서버 (프로젝트별 파일 기반 태스크)
//
// 저장: <project>/.claude/mcp-task/{YYYY-MM-DD}-{slug(group)}/task-{number}-{status}.json
//   - 태스크 1개 = JSON 파일 1개. status를 파일명·내용 양쪽에 기록(파일 트리로 한눈에 파악).
//   - 상태 변경 시 파일을 rename (task-2-pending.json -> task-2-in_progress.json).
//   - 완료 항목도 지우지 않고 누적.
// project 경로: CLAUDE_PROJECT_DIR > process.cwd()
// stdout에는 JSON-RPC만, 로그는 stderr로.

import { GROUP_STATUSES, projectDir } from './lib.mjs';
// 태스크 상태 넷은 model.mjs 가 원천이다. lib.mjs 의 옛 세 값은 B2-3 의 연결에서 재수출로 바뀐다.
import { KINDS, ROLES, STATUSES } from './model.mjs';
import {
  toolGroupAdd,
  toolGroupGet,
  toolGroupList,
  toolGroupUpdate,
  toolGroupResearch,
} from './tools/group.mjs';
import {
  toolGroupNoteAdd,
  toolGroupNoteGet,
  toolGroupNoteList,
  toolGroupNoteUpdate,
} from './tools/note.mjs';
import {
  toolGroupContextAdd,
  toolGroupContextGet,
  toolGroupContextList,
  toolGroupContextUpdate,
} from './tools/context.mjs';
import {
  PLAN_SECTION_KEYS,
  toolGroupPlanAdd,
  toolGroupPlanGet,
  toolGroupPlanList,
  toolGroupPlanUpdate,
} from './tools/plan.mjs';
import {
  LONG_FIELDS,
  toolAdd,
  toolGet,
  toolList,
  toolNext,
  toolUpdate,
} from './tools/task.mjs';
import {
  MESSAGE_STATES,
  toolMessageList,
} from './tools/message.mjs';
import {
  toolCampaignAdd,
  toolCampaignList,
  toolCampaignContextAdd,
  toolCampaignMainContextGet,
  toolCampaignMainContextUpdate,
  toolCampaignContextGet,
  toolCampaignContextUpdate,
  toolCampaignRead,
} from './tools/campaign.mjs';

import {
  BACKLOG_TAGS,
  BACKLOG_STATES,
  toolBacklogAdd,
  toolBacklogList,
  toolBacklogUpdate,
  toolBacklogDrop,
  toolBacklogPromote,
} from './tools/backlog.mjs';

const log = (...a) => process.stderr.write(`[task-mcp] ${a.join(' ')}\n`);

const MEMBER_SCHEMA = {
  type: 'array',
  description: '그룹 명단. 매니저는 한 명뿐이고 surface 는 UUID 가 정본이며 surface:N 을 주면 도구가 UUID 로 바꿔 저장한다.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: '패널 이름. 갱신은 이 이름으로 맞춘다' },
      surface: { type: 'string', description: 'cmux surface — UUID 또는 surface:N' },
      roles: {
        type: 'array',
        items: { type: 'string', enum: ROLES },
        description: 'manager · worker · tester · reviewer 중 하나 이상. 겸임은 둘 이상',
      },
      scope: { type: 'string', description: '워커의 분야·경계(선택). 도구는 읽기만 한다' },
      remove: { type: 'boolean', description: 'true면 그 이름을 명단에서 뺀다(update 전용)' },
    },
    required: ['name'],
  },
};

const TOOLS = [
  {
    name: 'backlog_add',
    description: '그룹 밖 백로그에 태그가 있는 항목을 추가합니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: '백로그 제목' },
        tag: { type: 'string', enum: BACKLOG_TAGS, description: '분류 태그' },
        body: { type: 'string', description: '백로그 본문' },
      },
      required: ['title', 'tag'],
    },
  },
  {
    name: 'backlog_list',
    description: '백로그의 번호·태그·제목·상태를 보여줍니다. 기본은 open이며 state:"all"이면 전부 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        tag: { type: 'string', enum: BACKLOG_TAGS, description: '이 태그만 조회합니다.' },
        state: { type: 'string', enum: [...BACKLOG_STATES, 'all'], description: '조회할 상태' },
      },
    },
  },
  {
    name: 'backlog_update',
    description: '백로그의 값을 교체합니다. 제목·태그를 바꾸면 파일 이름도 바뀝니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        number: { type: 'integer', minimum: 1, description: '백로그 번호' },
        title: { type: 'string', description: '새 제목' },
        tag: { type: 'string', enum: BACKLOG_TAGS, description: '새 태그' },
        body: { type: 'string', description: '새 본문 전체' },
        state: { type: 'string', enum: BACKLOG_STATES, description: '새 상태' },
      },
      required: ['number'],
    },
  },
  {
    name: 'backlog_drop',
    description: '백로그 상태를 dropped로 바꾸고 파일을 보존합니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { number: { type: 'integer', minimum: 1, description: '백로그 번호' } },
      required: ['number'],
    },
  },
  {
    name: 'backlog_promote',
    description: '백로그를 기존 그룹 또는 topic으로 만든 새 그룹의 work 태스크로 승격합니다. batch 기본값은 b1이며 담당자가 없으면 draft로 만듭니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        number: { type: 'integer', minimum: 1, description: '백로그 번호' },
        group_id: { type: 'string', description: '태스크를 넣을 기존 그룹. 없으면 topic으로 그룹을 만듭니다.' },
        topic: { type: 'string', description: '새 그룹 주제' },
        batch: { type: 'string', description: '배치 번호. 생략하면 b1입니다.' },
        assignee: { type: 'string', description: '담당자 surface UUID. 생략하면 draft로 만듭니다.' },
      },
      required: ['number'],
    },
  },
  {
    name: 'task_group_add',
    description: '태스크 그룹 폴더와 TASK_GROUP.json을 만든다. 이름의 날짜는 도구가 KST 기준으로 붙이며, members를 생략하면 호출 패널이 매니저로 들어간다. 매니저는 그룹당 한 명이라 둘째가 오면 거절한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        topic: { type: 'string', description: '날짜를 빼고 넘기는 그룹 주제' },
        campaign: { type: 'string', description: '소속 캠페인 이름(선택)' },
        about: { type: 'string', description: '그룹이 하는 일 설명(선택)' },
        title: { type: 'string', description: '대시보드 표시 제목(선택)' },
        members: MEMBER_SCHEMA,
      },
      required: ['topic'],
    },
  },
  {
    name: 'task_group_update',
    description: '그룹 제목·설명·상태·명단을 하나 이상 바꾼다. members는 name으로 맞춰 그 사람만 갱신하고 없는 이름은 더하며 remove:true면 뺀다. 매니저는 그룹당 한 명이다. 레코드 없는 옛 그룹은 이 도구를 명시 호출했을 때만 TASK_GROUP.json을 만든다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '그룹 폴더 이름' },
        title: { type: 'string', description: '대시보드 표시 제목(선택)' },
        about: { type: 'string', description: '그룹 설명(선택)' },
        status: { type: 'string', enum: GROUP_STATUSES, description: '그룹 상태(선택)' },
        members: MEMBER_SCHEMA,
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_get',
    description: '그룹 정보와 태스크·노트·맥락·계획서 목록을 읽습니다. 레코드 없는 옛 그룹도 파일을 만들지 않고 읽습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { group_id: { type: 'string', description: '그룹 폴더 이름' } },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_list',
    description: '그룹을 역할별 명단·진행 상태·다음 태스크·노트·맥락·계획서와 함께 대시보드로 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        campaign: { type: 'string', description: '특정 캠페인 소속 그룹만 볼 때(선택)' },
        all: { type: 'boolean', description: 'true면 완료 그룹까지 포함' },
      },
    },
  },
  {
    name: 'task_group_note_add',
    description: '그룹 notes/ 아래에 앞머리가 있는 노트 파일 한 장을 만들고 다음 번호를 돌려준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        title: { type: 'string', description: '노트 제목' },
        body: { type: 'string', description: '노트 본문' },
      },
      required: ['group_id', 'title', 'body'],
    },
  },
  {
    name: 'task_group_note_update',
    description: '그룹 노트의 제목이나 본문을 수정합니다. 본문은 field:"body"와 mode로 편집하며 오류가 나면 파일을 쓰지 않습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '노트 번호' },
        title: { type: 'string', description: '새 제목(선택)' },
        field: { type: 'string', enum: ['body'], description: '편집할 본문 칸' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: 'field를 주면 필수인 편집 방식' },
        text: { type: 'string', description: '추가·삽입·교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치. 기본은 end입니다.' },
        gap: { type: 'boolean', description: 'append 로 이을 때 사이에 빈 줄을 둘지. 기본 true 는 문단 사이를 띄우고, false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다' },
        old: { type: 'string', description: 'edit에서 찾을 기존 문자열' },
        new: { type: 'string', description: 'edit에서 바꿀 새 문자열' },
        replace_all: { type: 'boolean', description: 'true이면 일치한 문자열을 모두 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '본문에서 삽입할 줄 번호. 0이면 맨 앞입니다.' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_note_get',
    description: '그룹 노트 한 장의 앞머리를 그대로 보여주고 본문에 줄 번호를 붙입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '노트 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_note_list',
    description: '그룹 노트의 번호·제목·작성자·생성/수정 시각을 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_context_add',
    description: '그룹 context/ 아래에 앞머리가 있는 맥락 문서 한 장을 만들고 다음 번호를 돌려줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        title: { type: 'string', description: '맥락 문서 제목' },
        text: { type: 'string', description: '맥락 문서 본문' },
      },
      required: ['group_id', 'title', 'text'],
    },
  },
  {
    name: 'task_group_context_update',
    description: '그룹 맥락 문서의 제목이나 본문을 수정합니다. 본문은 field:"body"와 mode로 편집하며 오류가 나면 파일을 쓰지 않습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '맥락 문서 번호' },
        title: { type: 'string', description: '새 제목(선택)' },
        field: { type: 'string', enum: ['body'], description: '편집할 본문 칸' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: 'field를 주면 필수인 편집 방식' },
        text: { type: 'string', description: '추가·삽입·교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치. 기본은 end입니다.' },
        gap: { type: 'boolean', description: 'append 사이의 빈 줄을 둘지 정합니다. 기본 true이며 false이면 줄바꿈 하나만 둡니다.' },
        old: { type: 'string', description: 'edit에서 찾을 기존 문자열' },
        new: { type: 'string', description: 'edit에서 바꿀 새 문자열' },
        replace_all: { type: 'boolean', description: 'true이면 일치한 문자열을 모두 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '본문에서 삽입할 줄 번호. 0이면 맨 앞입니다.' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_context_get',
    description: '그룹 맥락 문서 한 장의 앞머리를 그대로 보여주고 본문에 줄 번호를 붙입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '맥락 문서 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_context_list',
    description: '그룹 맥락 문서의 번호·제목·작성자·생성 및 수정 시각을 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_plan_add',
    description: '그룹 plans/ 아래에 왜·스펙·합의·단계·검증·미결 여섯 고정 칸과 빈칸 표시가 있는 계획서를 만든다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        title: { type: 'string', description: '계획서 제목' },
      },
      required: ['group_id', 'title'],
    },
  },
  {
    name: 'task_group_plan_update',
    description: '계획서의 여섯 고정 칸 중 section으로 지정한 칸을 mode로 편집합니다. insert_after는 그 칸 본문 안의 줄 번호입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '계획서 번호' },
        section: { type: 'string', enum: PLAN_SECTION_KEYS, description: '수정할 고정 칸' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: '편집 방식' },
        text: { type: 'string', description: '추가·삽입·교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치. 기본은 end입니다.' },
        gap: { type: 'boolean', description: 'append 로 이을 때 사이에 빈 줄을 둘지. 기본 true 는 문단 사이를 띄우고, false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다' },
        old: { type: 'string', description: 'edit에서 찾을 기존 문자열' },
        new: { type: 'string', description: 'edit에서 바꿀 새 문자열' },
        replace_all: { type: 'boolean', description: 'true이면 일치한 문자열을 모두 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '지정한 칸 본문에서 삽입할 줄 번호. 0이면 맨 앞입니다.' },
      },
      required: ['group_id', 'number', 'section', 'mode'],
    },
  },
  {
    name: 'task_group_plan_get',
    description: '계획서 앞머리와 줄 번호를 붙인 전체 본문, 칸 안의 편집 번호 안내, 안 채운 칸의 개수와 이름을 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '계획서 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_plan_list',
    description: '그룹 계획서의 번호·제목·안 채운 칸 수를 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_add',
    description: '기존 태스크 그룹에 새 태스크 1개를 파일로 추가합니다. batch는 필수이고 kind가 역할을 정합니다. spec이 비거나 work·feedback의 assignee가 비면 draft로 만들고 그 까닭을 답에 붙입니다. test·review는 depends_on을 생략하면 같은 배치의 work·feedback 번호 전부가 들어갑니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'task_group_add가 돌려준 그룹 폴더 이름' },
        content: { type: 'string', description: '한 줄 제목(목록·파일명에 표시). 짧게.' },
        batch: { type: 'string', description: '어느 묶음인가. b 뒤에 양의 정수(예: b1, b2)' },
        kind: { type: 'string', enum: KINDS, description: '태스크 종류. 기본 work. 이 값이 맡는 역할을 정합니다' },
        tag: { type: 'string', description: '분류 태그(선택, 짧게). 파일명·목록에 [태그]로 표시. 예: backend, ui, bug' },
        description: { type: 'string', description: '배경·맥락(선택). 목록엔 안 뜨고 task_get으로 조회합니다' },
        spec: { type: 'string', description: '무엇을 어떤 기준으로. 모든 종류의 필수 칸이며 비면 draft가 됩니다' },
        instruction: { type: 'string', description: '어떻게 하라(선택)' },
        activeForm: { type: 'string', description: '진행 중 표시용 현재진행형 라벨(선택)' },
        depends_on: { type: 'array', items: { type: 'integer' }, description: '먼저 completed여야 할 태스크 번호들(선택)' },
        priority: { type: 'integer', description: '우선순위. 클수록 task_next가 먼저 선택(선택, 기본 0)' },
        assignee: { type: 'string', description: '할 패널의 UUID. work·feedback은 이 값이 있어야 pending으로 올라갑니다' },
        target: { type: 'array', items: { type: 'integer' }, description: '무엇에 관한 일인가(번호 목록, 선택)' },
        caused_by: { type: 'integer', description: '어느 review 판정에서 나왔나(선택)' },
        status: { type: 'string', enum: ['draft', 'pending'], description: 'draft를 명시하면 spec이 차 있어도 draft로 둡니다' },
      },
      required: ['group_id', 'content', 'batch'],
    },
  },
  {
    name: 'task_update',
    description: '태스크의 값 칸을 바꾸거나 긴 글 칸 다섯을 field와 mode로 고칩니다. status는 draft→pending→in_progress→completed 전이만 허용하고 in_progress는 task_next만 올립니다. outcome:"reject"와 rejected를 함께 주면 거절한 번호마다 feedback 태스크를 draft로 만듭니다. completed 태스크는 바꿀 수 없습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'task_add가 돌려준 그룹 폴더명(예: 2026-07-08-auth-flow)' },
        number: { type: 'integer', description: '태스크 번호' },
        status: { type: 'string', enum: STATUSES, description: '상태 변경(선택)' },
        tag: { type: 'string', description: '태그 갱신(선택)' },
        content: { type: 'string', description: '한 줄 제목 갱신(선택)' },
        activeForm: { type: 'string', description: '현재진행형 라벨 갱신(선택)' },
        batch: { type: 'string', description: '배치 갱신(선택). b 뒤에 양의 정수' },
        kind: { type: 'string', enum: KINDS, description: '종류 갱신(선택)' },
        depends_on: { type: 'array', items: { type: 'integer' }, description: '선행 태스크 번호 배열 갱신(선택)' },
        priority: { type: 'integer', description: '우선순위 갱신(선택)' },
        assignee: { type: 'string', description: '할 패널의 UUID 갱신(선택)' },
        target: { type: 'array', items: { type: 'integer' }, description: '대상 번호 목록 갱신(선택)' },
        caused_by: { type: 'integer', description: '어느 review 판정에서 나왔나(선택)' },
        outcome: { type: 'string', enum: ['pass', 'fail', 'approve', 'reject'], description: 'test는 pass·fail, review는 approve·reject' },
        rejected: { type: 'array', items: { type: 'integer' }, description: 'review가 거절한 work 번호 목록' },
        field: { type: 'string', enum: LONG_FIELDS, description: '편집할 긴 글 칸' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: 'field를 주면 필수인 편집 방식' },
        text: { type: 'string', description: '추가·삽입·교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치. 기본은 end입니다.' },
        gap: { type: 'boolean', description: 'append 로 이을 때 사이에 빈 줄을 둘지. 기본 true 는 문단 사이를 띄우고, false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다' },
        old: { type: 'string', description: 'edit에서 찾을 기존 문자열' },
        new: { type: 'string', description: 'edit에서 바꿀 새 문자열' },
        replace_all: { type: 'boolean', description: 'true이면 일치한 문자열을 모두 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '그 칸 본문에서 삽입할 줄 번호. 0이면 맨 앞입니다.' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_get',
    description: '태스크 1개의 전문을 읽습니다. 긴 글 칸 다섯(설명·스펙·지시·메모·결과)에는 줄 번호가 붙어 field와 mode의 insert_after에 그대로 쓸 수 있습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '그룹 폴더명' },
        number: { type: 'integer', description: '태스크 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_list',
    description: '태스크 목록을 배치별로 접어 보여줍니다. group_id를 줘도 기본은 내 assignee 것만이고 all:true면 전부입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '특정 그룹만 볼 때(선택)' },
        all: { type: 'boolean', description: 'true면 다른 패널 것 포함 전체. 기본 false=내 것만(패널 격리).' },
      },
    },
  },
  {
    name: 'task_next',
    description: '그룹의 다음 태스크를 집습니다. 부른 패널을 members에서 찾아 그 역할이 맡는 kind만 보고, 내 assignee이거나 비어 있는 것 가운데 선행이 끝난 것을 priority 내림차순·number 오름차순으로 고릅니다. number를 주면 그 태스크만 같은 조건으로 확인하고 집습니다. 집는 순간 in_progress가 되고 빈 assignee는 부른 패널로 채워집니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '집을 태스크 번호(선택). 생략하면 자동으로 고릅니다. 다른 번호를 진행 중이면 거절합니다' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'campaign_add',
    description: '새 캠페인 경로에 campaign-main-context와 campaign-notes를 만듭니다. 이름의 날짜는 KST 오늘 날짜로 붙입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '날짜를 빼고 넘기는 캠페인 주제' },
        about: { type: 'string', description: 'MAIN_CONTEXT 머리말이 될 설명 — 무엇을 왜 하는 일이고 무엇은 안 할지' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_read',
    description: '캠페인을 MAIN_CONTEXT, 차례, 차례와 실물의 어긋남, 태스크 그룹 순서로 보여줍니다. 그룹 레코드의 상태가 done인 그룹은 기본 목록에서 숨깁니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        full: { type: 'boolean', description: 'true면 완료 그룹도 보여줍니다. 기본은 false입니다.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_context_add',
    description: '캠페인 맥락 문서를 추가합니다. topic이 없으면 본 맥락에 context 문서를 만들고, 있으면 주제별 노트를 만듭니다. 차례에는 본 문서마다 한 줄, 주제 폴더마다 한 줄을 등록합니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        title: { type: 'string', description: '노트 제목' },
        text: { type: 'string', description: '적을 내용' },
        topic: { type: 'string', description: '주제 폴더 이름. 생략하면 campaign-main-context에 문서를 만듭니다.' },
      },
      required: ['name', 'title', 'text'],
    },
  },
  {
    name: 'campaign_main_context_get',
    description: 'MAIN_CONTEXT.md 전체에 줄 번호를 붙여 보여줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string', description: '캠페인 이름' } },
      required: ['name'],
    },
  },
  {
    name: 'campaign_main_context_update',
    description: '캠페인 본 맥락의 상태 줄 또는 본문 전체를 편집합니다. 본문을 고칠 때는 field:"body"와 mode가 필요합니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        status: { type: 'string', description: '상태: 줄에 넣을 새 값' },
        field: { type: 'string', enum: ['body'], description: '본문 편집 대상' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: '편집 방식' },
        text: { type: 'string', description: '붙이거나 교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치' },
        gap: { type: 'boolean', description: 'append 로 이을 때 사이에 빈 줄을 둘지. 기본 true 는 문단 사이를 띄우고, false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다' },
        old: { type: 'string', description: '찾을 문자열' },
        new: { type: 'string', description: '바꿀 문자열' },
        replace_all: { type: 'boolean', description: '일치하는 문자열을 전부 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '이 줄 다음에 넣습니다. 0이면 맨 앞입니다.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_context_get',
    description: '맥락 문서의 앞머리를 보존하고 본문에 줄 번호를 붙여 보여줍니다. topic을 주면 해당 주제 노트를 읽습니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        number: { type: 'integer', minimum: 1, description: '문서 번호' },
        topic: { type: 'string', description: '주제 폴더 이름' },
      },
      required: ['name', 'number'],
    },
  },
  {
    name: 'campaign_context_update',
    description: '맥락 문서의 제목 또는 본문을 수정합니다. 제목을 바꾸면 파일 이름과 본 맥락 차례도 갱신합니다. 본문은 field:"body"와 mode로 편집합니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        number: { type: 'integer', minimum: 1, description: '문서 번호' },
        topic: { type: 'string', description: '주제 폴더 이름' },
        title: { type: 'string', description: '새 제목' },
        field: { type: 'string', enum: ['body'], description: '본문 편집 대상' },
        mode: { type: 'string', enum: ['append', 'edit', 'replace'], description: '편집 방식' },
        text: { type: 'string', description: '붙이거나 교체할 글' },
        at: { type: 'string', enum: ['end', 'start'], description: 'append 위치' },
        gap: { type: 'boolean', description: 'append 로 이을 때 사이에 빈 줄을 둘지. 기본 true 는 문단 사이를 띄우고, false 는 줄바꿈 하나만 두어 표 행을 이어 붙입니다' },
        old: { type: 'string', description: '찾을 문자열' },
        new: { type: 'string', description: '바꿀 문자열' },
        replace_all: { type: 'boolean', description: '일치하는 문자열을 전부 바꿉니다.' },
        insert_after: { type: 'integer', minimum: 0, description: '본문에서 이 줄 다음에 넣습니다. 0이면 맨 앞입니다.' },
      },
      required: ['name', 'number'],
    },
  },
  {
    name: 'task_group_research',
    description: '그룹의 researches 아래에 research-{YYYY-MM-DD}-{TOPIC} 폴더를 만들고 경로를 돌려줍니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 이름' },
        topic: { type: 'string', description: '날짜를 빼고 넘기는 리서치 주제' },
      },
      required: ['group_id', 'topic'],
    },
  },
  {
    name: 'message_list',
    description: '그룹의 보고 기록을 상태별로 보여줍니다. 보고는 워커가 적는 그 자리에서 매니저 패널로 가고 이 파일에는 그 결과가 남습니다. 기본은 아직 안 읽은 것이고 state 로 골라 봅니다. 보내지 못한 줄은 failed 와 까닭이 함께 보입니다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        state: { type: 'string', enum: [...MESSAGE_STATES, 'all'], description: '조회할 상태(delivered · failed · read · all). 기본은 read 가 아닌 것' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'campaign_list',
    description: '캠페인 목록과 각각의 상태·그룹 수·남은 태스크 수. 여기서 이름을 고른 뒤 campaign_read로 펼치는 두 걸음이 사용법이다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

const DISPATCH = {
  backlog_add: toolBacklogAdd, backlog_list: toolBacklogList,
  backlog_update: toolBacklogUpdate, backlog_drop: toolBacklogDrop,
  backlog_promote: toolBacklogPromote,
  task_group_add: toolGroupAdd, task_group_update: toolGroupUpdate,
  task_group_get: toolGroupGet, task_group_list: toolGroupList,
  task_group_note_add: toolGroupNoteAdd, task_group_note_update: toolGroupNoteUpdate,
  task_group_note_get: toolGroupNoteGet, task_group_note_list: toolGroupNoteList,
  task_group_context_add: toolGroupContextAdd, task_group_context_update: toolGroupContextUpdate,
  task_group_context_get: toolGroupContextGet, task_group_context_list: toolGroupContextList,
  task_group_plan_add: toolGroupPlanAdd, task_group_plan_update: toolGroupPlanUpdate,
  task_group_plan_get: toolGroupPlanGet, task_group_plan_list: toolGroupPlanList,
  message_list: toolMessageList,
  task_add: toolAdd, task_update: toolUpdate, task_get: toolGet, task_list: toolList,
  task_next: toolNext,
  campaign_add: toolCampaignAdd, campaign_read: toolCampaignRead,
  campaign_context_add: toolCampaignContextAdd,
  campaign_main_context_get: toolCampaignMainContextGet, campaign_main_context_update: toolCampaignMainContextUpdate,
  campaign_context_get: toolCampaignContextGet, campaign_context_update: toolCampaignContextUpdate,
  task_group_research: toolGroupResearch, campaign_list: toolCampaignList,
};

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'task-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = fn(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse fail:', line.slice(0, 120)); continue; }
    try { handle(msg); } catch (e) { log('handle error:', e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started. projectDir=${projectDir()} (CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR || '<unset>'})`);
