# task-mcp — 매뉴얼

task MCP는 프로젝트 안의 파일로 캠페인·태스크 그룹·태스크·백로그를 관리합니다.
매니저는 명단과 작업 명세를 준비하고, 워커·테스터·리뷰어는 자신의 역할에 맞는 태스크를
받아 수행합니다. 작업 결과를 태스크에 적으면 도구가 매니저 패널로 요약을 보내고 전송 결과를 기록합니다.

## 한 라운드가 지나는 길

처음 쓰는 세션은 이 순서를 먼저 봅니다. 각 단계의 규칙은 아래 절에 있습니다.

| 순서 | 누가 | 무엇을 |
|---|---|---|
| 1 | 매니저 | `task_group_add`로 그룹을 만들고 `members`에 이름·UUID·역할을 등록합니다. 명단에 없는 패널은 읽기만 되고 쓰기는 거절됩니다. |
| 수시 | 매니저 | 관리자에게 들은 배경·결정은 `task_group_context_add`로 그룹 맥락 문서에 적습니다. |
| 2 | 매니저 | `task_add`로 태스크를 만듭니다. `batch`와 `kind`는 필수이고, 배경은 `description`, 무엇을 어떤 기준으로 할지는 `spec`, 어떻게 할지는 `instruction`에 나눠 적습니다. |
| 3 | 매니저 | `spec`이 비거나 work·feedback의 `assignee`가 비면 도구가 `draft` 상태로 만듭니다. 채운 뒤 `task_update`로 `pending`에 올려야 워커가 집습니다. |
| 4 | 워커 | `task_next`로 받습니다. 목록에서 골라 가는 것이 아니라 도구가 역할·배정·선행을 보고 내줍니다. 원하는 번호가 있으면 `number`로 지정합니다. |
| 5 | 워커 | 일을 마치면 `field:"result"`에 결과를 적고 같은 호출에 `status:"completed"`를 넣습니다. 그 순간 매니저 패널로 보고가 갑니다. |
| 6 | 테스터·리뷰어 | 배치 끝에서 `test`와 `review`를 받아 `outcome`을 적습니다. `test`는 pass·fail, `review`는 approve·reject입니다. |
| 7 | 도구 | `review`가 거절하면 대상마다 `feedback` 태스크를 `draft` 상태로 만듭니다. 매니저가 `spec`을 채워 올립니다. |
| 8 | 매니저 | 라운드를 마치면 `task_group_update`에 `status:"done"`을 넘겨 그룹을 닫습니다. 그룹은 저절로 닫히지 않습니다. |

끝난 태스크는 고칠 수 없습니다. 되돌아가는 길은 상태를 되돌리는 것이 아니라 새 태스크를
쌓는 것입니다. 이것이 이 도구의 기본 성질이며 아래 설명은 모두 그 위에 있습니다.

## 호출 방법

정식 MCP 연결이 보이면 도구 이름으로 직접 호출하십시오. 연결되지 않은 환경에서는
레포 루트에서 `mcp-call`을 사용합니다.

```sh
# 프로젝트 서버의 도구 목록을 확인합니다.
node .claude/tools/mcp-call.mjs .claude/tools/task-mcp/server.mjs --tools

# 전체 태스크를 조회합니다.
node .claude/tools/mcp-call.mjs .claude/tools/task-mcp/server.mjs task_list '{"all":true}'

# 전역 서버로 지정한 태스크를 읽습니다.
node .claude/tools/mcp-call.mjs ~/.claude/tools/task-mcp/server.mjs task_get '{"group_id":"2026-09-18-topic","number":1}'
```

개발 사본을 검사할 때는 서버 경로의 `task-mcp`를 `task-mcp-next`로 바꿉니다.
임시 프로젝트를 `CLAUDE_PROJECT_DIR`로 지정하면 상대 서버 경로도 그 프로젝트 아래에서
찾으므로, 레포 루트에서 `SERVER="$PWD/.claude/tools/task-mcp-next/server.mjs"`처럼
서버의 절대경로를 지정하십시오.
JSON 인자를 파일에 저장했다면 `@args.json`으로 넘깁니다.
호출 형식과 종료 코드는 [mcp-call 매뉴얼](../mcp-call.MANUAL.md)을 따릅니다.

프로젝트 위치는 `CLAUDE_PROJECT_DIR`를 우선하고, 없으면 현재 작업 폴더를 사용합니다.
호출 패널의 정체는 `CMUX_SURFACE_ID`로 전달합니다. Codex의 stdio MCP 설정에서는
`.codex/config.toml`의 `[mcp_servers.task]`에 `env_vars = ["CMUX_SURFACE_ID"]`를 지정해
해당 환경변수가 서버에 전달되도록 합니다. 설정을 바꾼 뒤에는 세션을 다시 시작해야 합니다.
이 값이 없을 때 다른 방법으로 패널을 추측하지 않습니다.

## 저장 구조

```text
.claude/mcp-task/
└── {YYYY-MM-DD}-{TOPIC}/
    ├── TASK_GROUP.json
    ├── MANAGER_MESSAGE_QUEUE.jsonl
    ├── task-{N}-{BATCH}-{KIND}-{STATUS}-[{TAG}]-{TITLE}.json
    ├── notes/note-{N}-{TITLE}.md
    ├── context/context-{N}-{TITLE}.md
    ├── plans/plan-{N}-{TITLE}.md
    └── researches/research-{YYYY-MM-DD}-{TOPIC}/

.claude/mcp-task-campaign/
└── {YYYY-MM-DD}-{NAME}/
    ├── campaign-main-context/
    │   ├── MAIN_CONTEXT.md
    │   ├── INDEX.md
    │   └── context-{N}-{TITLE}.md
    ├── campaign-notes/{TOPIC}/note-{N}-{TITLE}.md
    └── task-group-{YYYY-MM-DD}-{GROUP}/
        ├── TASK_GROUP.json
        ├── MANAGER_MESSAGE_QUEUE.jsonl
        ├── task-{N}-{BATCH}-{KIND}-{STATUS}-[{TAG}]-{TITLE}.json
        ├── notes/
        ├── context/
        ├── plans/
        └── researches/

.claude/mcp-task-backlog/
└── item-{N}-[{TAG}]-{TITLE}.json

.claude/tasks -> mcp-task
.claude/campaigns -> mcp-task-campaign
```

맨 아래의 두 심볼릭 링크는 이관 후에도 실행 중인 옛 서버가 같은 장부를 읽도록 남깁니다.
`group_id`는 경로가 아니라 폴더 이름 하나입니다. 캠페인 안의 그룹에는 `task-group-`가
붙으며, 옛 ID로 호출해도 접두사가 붙은 실물 그룹을 찾습니다.

### 이름 규칙

새 캠페인·그룹·조사 폴더의 날짜는 도구가 한국 시간(KST)으로 붙입니다. 호출자는 날짜를
뺀 주제를 넘기십시오. 입력 앞에 날짜가 연속해서 붙어 있으면 모두 떼고 오늘 날짜를 붙이며,
응답에 뗀 날짜를 알립니다. 공백과 문장 부호는 파일 이름에서 하이픈으로 정리합니다.

| 대상 | 이름과 값의 규칙 |
|---|---|
| 태스크 파일 | `task-{N}-{BATCH}-{KIND}-{STATUS}-[{TAG}]-{TITLE}.json`입니다. 태그가 비면 `[{TAG}]` 부분도 생략합니다. 태그는 20자, 제목은 40자까지 사용합니다. |
| 배치 | `b` 뒤에 양의 정수를 붙입니다. `b1`, `b2`처럼 사용하며 새 태스크에는 항상 필요합니다. |
| 종류 | `work`, `test`, `review`, `feedback`, `onboard`, `research` 중 하나입니다. |
| 태스크 상태 | `draft`, `pending`, `in_progress`, `completed` 중 하나입니다. |
| 캠페인 소속 그룹 | `task-group-{YYYY-MM-DD}-{GROUP}`입니다. 캠페인 아래에서는 이 접두사가 붙은 폴더만 그룹으로 읽습니다. |
| 독립 그룹 | `{YYYY-MM-DD}-{TOPIC}`입니다. `.claude/mcp-task/` 아래에 만듭니다. |
| 맥락 문서·주제 노트 | 각각 `context-{N}-{TITLE}.md`, `note-{N}-{TITLE}.md`이며 제목은 60자까지 사용합니다. 번호는 각 저장 폴더에서 이어집니다. |
| 그룹 맥락 문서 | `context/context-{N}-{TITLE}.md`입니다. 번호는 그룹의 context/ 안에서 이어집니다. 앞머리는 제목 전체를 보존하고 파일 이름의 제목만 60자로 자릅니다. |
| 조사 폴더 | 그룹의 `researches/research-{YYYY-MM-DD}-{TOPIC}/`에 만듭니다. |
| 백로그 | `item-{N}-[{TAG}]-{TITLE}.json`입니다. 태그는 `테스트`, `QA`, `도구개발`, `리서치`, `audit`, `문서정리` 중 하나입니다. |

캠페인 자료 폴더의 이름을 예약어로 막지 않습니다. 그룹과 자료는 접두사로 구분합니다.
옛 태스크 이름 `task-{N}-{STATUS}-[{TAG}]-{TITLE}.json`도 계속 읽습니다.
번호 다음 값이 상태이면 옛 이름, 배치이면 새 이름입니다. 기존 파일을 일괄 개명할 필요는 없습니다.

## 레코드와 문서

### TASK_GROUP.json

그룹 레코드는 `id`, `title`, `about`, `status`, `campaign`, `members`, `created_at`,
`updated_at`을 저장합니다. 독립 그룹의 `campaign`은 `null`입니다. 그룹 상태는 `pending`,
`in_progress`, `done` 중 하나입니다. 첫 `task_next`가 그룹을 진행 중으로 올리고,
완료 처리는 매니저가 명시합니다.

`members`의 각 항목은 `name`, `surface`, `ref`, `roles`, `scope`, `session`으로 구성됩니다.
`surface`에는 패널을 고유하게 식별하는 UUID를 저장합니다. 등록할 때 `surface:29`처럼 넘기면
cmux에서 UUID를 찾아 저장하고, 원래 번호는 `ref`에 남깁니다. 번호를 찾지 못하면 거절합니다.

역할은 `manager`, `worker`, `tester`, `reviewer` 중 하나 이상을 지정합니다. 겸임할 때는
`roles` 배열에 함께 넣습니다. 매니저는 그룹당 0명 또는 1명이며, 두 번째 매니저는 등록할 수
없습니다. `members`를 생략하고 그룹을 만들면 호출 패널이 매니저로 등록됩니다.

명단 수정은 `name`으로 항목을 찾습니다. 같은 이름이면 갱신하고, 없는 이름이면 추가합니다.
`{ "name": "WRKR", "remove": true }`는 해당 항목을 제거합니다. 패널을 다시 열어 UUID가
바뀌었다면 같은 이름으로 새 주소를 등록하십시오. `scope`는 담당 분야를 설명하는 글이며,
도구가 작업을 선택하는 조건으로 사용하지 않습니다. `session`은 기존 명단과의 호환을 위해
남아 있는 값이며 보고를 전송할 때 사용하지 않습니다.

### 태스크 JSON

| 칸 | 의미와 기본값 |
|---|---|
| `number` | 그룹 안에서 가장 큰 번호 다음 값을 사용합니다. |
| `content` | 필수 한 줄 제목입니다. |
| `tag` | 분류 태그이며 기본은 빈 문자열입니다. |
| `batch` | 필수 배치 번호입니다. |
| `kind` | 태스크 종류이며 기본은 `work`입니다. |
| `status` | 명세나 필수 배정이 비면 `draft`, 준비되어 있으면 `pending`입니다. `status:"draft"`를 명시할 수도 있습니다. |
| `description` | 배경과 맥락입니다. 기본은 빈 문자열입니다. |
| `spec` | 수행할 일과 받아들임 조건입니다. 모든 종류에서 작업을 시작하기 전에 채워야 합니다. |
| `instruction` | 수행 방법과 주의 사항입니다. 기본은 빈 문자열입니다. |
| `memo` | 작업 중 기록입니다. 기본은 빈 문자열입니다. |
| `result` | 작업 결과입니다. 기본은 빈 문자열입니다. 매니저 보고에도 사용합니다. |
| `outcome` | test는 `pass` 또는 `fail`, review는 `approve` 또는 `reject`를 사용합니다. 기본은 `null`입니다. |
| `rejected` | review가 거절한 태스크 번호 배열입니다. 기본은 빈 배열입니다. |
| `target` | 이 작업이 다루는 태스크 번호 배열입니다. 기본은 빈 배열입니다. |
| `caused_by` | 이 작업을 발생시킨 review 번호입니다. 기본은 `null`입니다. null이 아닌 값을 새로 주면 양의 정수인지, 같은 그룹에 존재하는 review 번호인지 검사합니다. |
| `depends_on` | 먼저 완료되어야 하는 태스크 번호 배열입니다. test·review의 기본값은 아래에서 설명합니다. |
| `priority` | 큰 값부터 선택하며 기본은 0입니다. |
| `activeForm` | 진행 중 표시할 라벨입니다. 기본은 `content`입니다. |
| `owner` | 태스크를 만든 패널입니다. 목록의 담당자 필터에는 사용하지 않습니다. |
| `assignee` | 수행할 패널의 UUID입니다. 생성·변경 시 비어 있지 않은 값은 그룹 명단과 해당 kind를 맡는 역할을 검사합니다. kind만 바꿔도 저장된 assignee를 새 kind로 다시 검사합니다. 앞뒤 공백이나 surface 번호는 거절합니다. work·feedback은 배정해야 시작할 수 있습니다. |
| `group_id` | 소속 그룹의 ID입니다. |
| `created_at` · `updated_at` | 생성·수정 시각을 각각 ISO 형식으로 저장합니다. |

`spec`을 생략하거나 비워 만들면 `spec 이 비어 draft 로 만들었습니다`라고 안내합니다.
work·feedback의 `assignee`를 생략하면 거절하지 않고 draft로 만들며,
`assignee 가 없어 draft 로 만들었습니다`라는 안내와 worker 명단을 붙입니다.
준비가 끝난 뒤 매니저나 생성자가 `pending`으로 올리십시오.

### 보고 기록과 직통 전달

`task_update`로 `result`를 적거나 `completed`로 바꾸거나 `outcome`을 적으면 도구가
그 자리에서 매니저 패널로 보고 한 줄을 보냅니다. `memo`는 보고 사건이 아닙니다.
`event`는 `result`, `completed`, `outcome` 중 하나이며, 한 호출에 여러 사건이 포함되어도
보고는 한 건입니다. `completed`가 있으면 event는 `completed`, 그 밖에 outcome이 있으면
`outcome`입니다. 매니저가 없거나 매니저 자신이 수정하면 보고 기록과 전송을 만들지 않습니다.

보고는 `cmux send`로 글을 넣고, 그 글이 매니저 입력창에 보인 뒤에 대문자 `Enter`를 한 번 보내
전달합니다. 보내기 전에 매니저가 쉬는지 일하는지 판정하지 않습니다. 글을 넣은 뒤에는
`read-screen --scrollback --lines 20`으로 꼬리 20줄을 0.2초 간격으로 최대 열 번 읽어, 마지막 입력
프롬프트(`❯` 또는 `›`)부터 아래에 보고의 앞 40자가 보이면 그때 `Enter`를 보냅니다. 받는 패널이 글을
읽기 전에 `Enter`가 닿으면 같은 읽기에 글과 합쳐져 줄바꿈으로 들어가고, 그 뒤의 `Enter` 한 번은
씹히기 때문입니다(2026-10-12 실측). 열 번 읽어도 안 보이거나 읽기가 실패하면 그대로 `Enter`를 보냅니다.
`Enter`를 보낸 뒤 다시 꼬리 20줄을 읽습니다. 마지막 입력 프롬프트 아래 줄의 `esc to interrupt`(Claude Code 상태줄)와
위 3줄 안에서 `Working (`로 시작하는 줄(codex 진행 줄, 앞의 공백·불릿 허용)만 작업 중 마커로 봅니다.
이때 보고는 다음 입력으로 대기하는 정상 상황이므로 보낸 것으로 기록합니다. 다른 자리에 찍힌
지난 턴의 마커는 무시하며, 프롬프트가 없으면 보낸 것으로 기록합니다. 유휴 상태에서 마지막 입력 프롬프트에
보고의 앞 40자가 남아 있으면 `Enter`를 한 번 더 보내고 다시 읽습니다. 두 번째에도 남아 있으면
`failed`와 `입력창에 남음(Enter 2회)`를 기록합니다. 제출 확인 읽기는 최대 두 번입니다.
실제 어댑터는 제출 확인 읽기 직전에 `TASK_MCP_CONFIRM_WAIT_MS`만큼 기다리며 기본은 1000ms입니다.
가짜 어댑터는 기다리지 않습니다. 20줄 창은 여러 줄로 접힌 입력과 그 아래 경계선·상태줄을 포함합니다.
cmux 실행 파일은 `CMUX_BUNDLED_CLI_PATH`를 우선 사용합니다.

보내는 한 줄의 형식은 다음과 같습니다. outcome이 있으면 event 뒤에 괄호로 붙이고,
요약이 비어 있으면 요약과 그 앞 공백을 생략합니다.

```text
[task-mcp] {from.name} ({from.ref 또는 surface 앞 8자}) 이 {group_id} task-{N} ({kind}) 의 {event}{outcome이 있으면 " (" + outcome + ")"} 를 적었습니다. {요약} task_get {group_id} {N}
```

`from`은 보고한 패널, `to`는 그룹 명단에 있는 매니저입니다. 각각 `name`, `surface`, `ref`를
기록합니다. 표시할 이름과 ref는 그룹 members에서 가져오며, ref가 비면 surface의 앞 8자를
표시합니다. 본문 전체는 전송하지 않고 `task_get`으로 읽습니다.

요약은 다음 순서로 정합니다.

1. 이번 호출이 `field:"result"`로 text를 적었으면 **이번 text의 첫 비어 있지 않은 줄**을 사용합니다. append로 덧붙여도 새 글이 요약입니다.
2. completed만 또는 outcome만 기록한 호출처럼 새 result text가 없으면 저장된 result의 첫 비어 있지 않은 줄을 사용합니다. result도 비면 요약은 빈 문자열입니다.
3. 백틱·작은따옴표·CR은 공백으로 바꾸고, 연속 공백을 하나로 줄인 뒤 양 끝을 다듬습니다. 최대 **200자**까지만 사용합니다.

`MANAGER_MESSAGE_QUEUE.jsonl`이라는 파일 이름은 유지하지만, 내용은 보고의 전송 결과를 남기는
로그입니다. JSON 레코드를 한 줄에 한 건씩 저장하며 각 레코드의 필드는 다음과 같습니다.

```text
{ id, at, group_id, task, kind, event, outcome, from:{name,surface,ref}, to:{name,surface,ref}, summary, line, state, reason, sent_at, read_at }
```

`line`에는 전송을 시도한 한 줄을 기록합니다. 전송에 성공하면 `state:"delivered"`와 `sent_at`을
남기고 reason은 null입니다. 다만 화면 읽기에 실패하면 `delivered`를 유지하고 reason에
`확인 못 함: …`을 기록합니다. stderr의 첫 비어 있지 않은 줄을 우선 사용하고, stderr가 비어 있으면
오류 메시지의 첫 줄을 사용합니다. 공백을 정리하며 접두사를 포함해
120자로 자릅니다. 전송에 실패하면 `state:"failed"`와 reason을 남기며 sent_at은
null입니다. 실패 이유는 `cmux 없음`, `send 실패: …`, `입력창에 남음(Enter 2회)`입니다.
**전송에 실패해도 워커의 태스크 쓰기는
성공합니다.** 성공과 실패의 도구 응답은 각각 다음과 같습니다.

```text
매니저 패널({to.ref 또는 surface 앞 8자})로 보고를 보냈습니다.
매니저 패널로 보내지 못했습니다({reason}). message_list 로 확인하십시오.
```

입력창에 남아 `Enter`를 한 번 더 보낸 뒤 성공했으면 성공 문구 뒤에
`(Enter 를 한 번 더 보냈습니다)`를 붙입니다.

로그의 state는 `delivered`(보냄), `failed`(못 보냄), `read`(읽음) 세 값입니다.
failed에는 실패 이유인 reason이 남습니다. 받는 매니저가 `task_get`으로 해당 태스크를
열면 보고의 state를 `read`로 바꾸고 `read_at`을 채웁니다.
`message_list`의 기본 조회는 read가 아닌 보고, 즉 delivered와 failed입니다.
state 인자에 `delivered`, `failed`, `read`, `all` 중 하나를 지정해 조회 범위를 고릅니다.
목록에는 상태와 실패 이유가 표시됩니다.

### 백로그 항목

백로그는 그룹을 정하기 전에 보관하는 작업입니다. `number`, `title`, `tag`, `body`, `state`,
`created_at`, `updated_at`을 저장합니다. 상태는 `open`, `done`, `promoted`, `dropped` 중
하나입니다. 기본 목록에는 open만 보이고, `state:"all"`이면 전부 보입니다.

`backlog_drop`은 항목을 dropped로 바꾸고 파일을 남깁니다. `backlog_promote`는 제목을
태스크의 `content`로, 본문을 `spec`으로, 태그를 `tag`로 넘기며 `kind:"work"`를 사용합니다.
배치를 생략하면 b1입니다. `group_id`가 있으면 해당 그룹을 사용하고, 없으면 `topic`으로
그룹을 만든 뒤 태스크를 추가합니다. 둘 다 없으면 거절합니다.
새 그룹을 만드는 요청에 비어 있지 않은 `assignee`를 함께 주면 그룹 생성 전에 거절합니다.
먼저 그룹과 명단을 등록한 뒤 `group_id`로 승격하거나, 담당자 없이 draft로 승격하십시오.
담당자를 생략한 승격도 draft로 접수하며, 태스크 생성이 성공한 뒤 항목을 promoted로 바꿉니다.
어느 태스크로 승격했는지를 저장하는 별도 칸은 없습니다.

### 캠페인 문서와 그룹 노트·맥락·계획서

`MAIN_CONTEXT.md`는 캠페인 제목·상태·설명을 담습니다. `상태:`로 시작하는 줄이 캠페인 상태의
원본이며 `campaign_main_context_update`의 `status`로 바꿉니다.
상태 줄이 없으면 제목 다음 빈 줄 뒤에 삽입합니다.

캠페인 맥락 문서·주제 노트·그룹 노트·맥락·계획서의 앞머리에는 `number`, `title`, `author`,
`created_at`, `updated_at`이 있습니다. 제목을 바꾸면 앞머리와 파일 이름도 바뀝니다.
캠페인 본 맥락의 문서는 INDEX에 문서마다 한 줄을, 주제 노트는 주제 폴더마다 한 줄을
등록합니다. 본 맥락 문서 제목을 바꾸면 차례 링크도 갱신합니다.

그룹 맥락은 독립 그룹과 캠페인 소속 그룹 모두 `context/`에 저장합니다. 별도 INDEX나
MAIN_CONTEXT는 만들지 않으며 `task_group_context_list`로 목록을 읽습니다. 번호 없는 문서와
하위 폴더는 읽거나 세지 않습니다. 도구 밖에서 만든 `CONTEXT.md`와 자료는 그대로 둡니다.
추가할 때는 `text`, 본문을 고칠 때는 `field:"body"`와 `mode`를 사용합니다.

계획서는 다음 여섯 칸을 고정 순서로 사용합니다.

| 칸 | `section` | 적을 내용 |
|---|---|---|
| 왜 | `why` | 문제와 배경을 적습니다. |
| 스펙 | `spec` | 입출력과 받아들임 조건을 적습니다. |
| 합의 | `agreement` | 결정한 범위와 제외한 범위를 적습니다. |
| 단계 | `steps` | 수행 순서를 적습니다. |
| 검증 | `verification` | 검사 방법과 통과 조건을 적습니다. |
| 미결 | `open` | 아직 정하지 못한 사항을 적습니다. |

새 계획서는 각 칸이 `<!-- 비어 있음 -->`으로 시작합니다. get은 빈칸 개수와 이름을,
list는 계획서마다 빈칸 개수를 보여줍니다. update는 지정한 section만 고칩니다.

## 편집 계약

`task_update`, `task_group_note_update`, `task_group_context_update`, `task_group_plan_update`,
`campaign_main_context_update`, `campaign_context_update`는 같은 편집 규칙을 사용합니다.
태스크의 긴 글은 `description`, `spec`, `instruction`, `memo`, `result` 중 하나를 `field`로
지정합니다. 노트와 맥락 문서는 `field:"body"`, 계획서는 `section`으로 대상을 지정합니다.

| `mode` | 인자 | 동작 |
|---|---|---|
| `append` | `text`, 선택 인자 `at`·`gap` | 끝에 붙입니다. `at:"start"`이면 앞에 붙입니다. 양쪽 글 사이에는 빈 줄 하나를 두며, `gap:false`를 주면 줄바꿈 하나만 둡니다. |
| `edit` | `old`, `new`, 선택 인자 `replace_all` | 일치하는 문자열을 바꿉니다. 여러 곳이면 `replace_all:true`를 주거나 old를 더 길게 지정합니다. |
| `edit` | `insert_after`, `text` | 해당 본문 줄 다음에 삽입합니다. 0은 맨 앞입니다. |
| `replace` | `text` | 지정한 칸 전체를 교체합니다. 빈 문자열을 주면 비웁니다. |

`gap`은 `append`에서만 쓰며 다른 `mode`에 주면 거절합니다. 표에 행을 한 줄씩 붙일 때 쓰십시오.
기본값인 빈 줄 하나가 마크다운 표를 행마다 끊기 때문입니다. 붙이는 글이 표 행인지 도구가
알아서 판정하지 않으므로, 표를 이어 붙일 때는 부르는 쪽이 `gap:false`를 지정합니다.

```json
{ "group_id": "2026-09-18-topic", "number": 2, "field": "body", "mode": "append",
  "gap": false, "text": "| 12:30 | WRKR3 | 어긋남 | … |" }
```

제목·상태처럼 짧은 값은 해당 인자로 직접 바꿉니다. 본문을 고칠 때는 mode를 함께 지정합니다.
예를 들어 작업 결과를 적고 완료하는 호출은 다음과 같습니다.

워커는 result의 첫 줄에 **200자 안의 한 문장 요약**을 쓰고, 상세 결과와 검증 근거는 다음
줄부터 적으십시오. 결과와 `status:"completed"`는 한 번의 `task_update`에 함께 넣습니다.
이렇게 하면 완료 보고 한 줄에 이번 결과의 요약이 담깁니다.

```json
{
  "group_id": "2026-09-18-topic",
  "number": 5,
  "field": "result",
  "mode": "replace",
  "text": "구현과 관련 검증을 완료했습니다.\n검증 결과를 여기에 적습니다.",
  "status": "completed"
}
```

위 인자는 `task_update`에 넘깁니다. completed가 된 뒤에는 result도 고칠 수 없으므로
결과를 먼저 적거나 완료 상태와 같은 호출에 포함하십시오.
백로그의 `body`는 이 편집 계약에 포함되지 않으며 `backlog_update`에서 통째로 교체합니다.

get 도구는 긴 글의 줄 앞에 `  12│ ` 형태의 번호를 붙입니다. 이 번호는 파일에 저장하지 않습니다.
계획서 get은 전체 본문에 연속 번호를 붙이지만, update의 insert_after는 **선택한 section의
본문 안에서** 1부터 셉니다. 다른 문서의 앞머리는 본문 줄 번호에 포함하지 않습니다.
MAIN_CONTEXT는 파일 전체가 편집 대상이므로 제목과 상태 줄도 번호에 포함합니다.

편집 검증에 실패하면 파일을 쓰지 않습니다. 아래 여섯 오류 문구를 그대로 반환합니다.

```text
field 에는 mode 가 있어야 합니다 (append | edit | replace)
old 를 찾지 못했습니다
old 가 N 군데에 있습니다. replace_all:true 로 전부 바꾸거나 old 를 더 길게 주십시오
old 와 new 가 같습니다
줄이 N 개뿐입니다
append 플래그는 없어졌습니다. mode:"append" 를 쓰십시오
```

오류 문구의 N은 실제 일치 수 또는 줄 수입니다. 옛 `append:true`와 update의 옛 `body` 인자는
사용하지 않습니다. 태스크의 description·instruction도 update에서는 field와 mode로 고칩니다.

## 도구 36개

`?`는 선택 인자이며, 표시가 없으면 필수입니다. 다음 표의 이름과 인자 순서는 실제
`--tools` 출력과 같습니다. 선택 인자라도 함께 주어야 하는 조건은 각 사용법을 따릅니다.

### 그룹 5개

| 도구 | 역할 |
|---|---|
| `task_group_add(topic, campaign?, about?, title?, members?)` | 그룹과 TASK_GROUP.json을 만듭니다. |
| `task_group_update(group_id, title?, about?, status?, members?)` | 그룹 값과 명단을 갱신합니다. |
| `task_group_get(group_id)` | 그룹 정보와 태스크·노트·맥락·계획서·조사 목록을 읽습니다. 「다음」은 역할·배정과 무관하게 선행이 모두 완료된 pending을 priority 내림차순·number 오름차순으로 고른 첫 항목입니다. |
| `task_group_list(campaign?, all?)` | 명단·진행 상태·다음 태스크·문서 수를 보여줍니다. 「다음」은 그룹 전체에서 선행이 모두 완료된 pending을 priority 내림차순·number 오름차순으로 고르며 역할·배정은 보지 않습니다. 기본 목록에서 done 그룹은 숨깁니다. |
| `task_group_research(group_id, topic)` | 날짜가 붙은 빈 조사 폴더를 만들고 경로를 돌려줍니다. |

### 그룹 노트 4개

| 도구 | 역할 |
|---|---|
| `task_group_note_add(group_id, title, body)` | 노트 한 장을 만듭니다. |
| `task_group_note_update(group_id, number, title?, field?, mode?, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 제목이나 본문을 수정합니다. |
| `task_group_note_get(group_id, number)` | 앞머리와 줄 번호를 붙인 본문을 읽습니다. |
| `task_group_note_list(group_id)` | 번호·제목·작성자·생성 및 수정 시각을 보여줍니다. |

### 그룹 맥락 4개

| 도구 | 역할 |
|---|---|
| `task_group_context_add(group_id, title, text)` | 맥락 문서 한 장을 만듭니다. |
| `task_group_context_update(group_id, number, title?, field?, mode?, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 제목이나 본문을 수정합니다. 제목을 바꾸면 파일 이름도 바뀝니다. |
| `task_group_context_get(group_id, number)` | 앞머리와 줄 번호를 붙인 본문을 읽습니다. |
| `task_group_context_list(group_id)` | 번호·제목·작성자·생성 및 수정 시각을 보여줍니다. |

### 그룹 계획서 4개

| 도구 | 역할 |
|---|---|
| `task_group_plan_add(group_id, title)` | 여섯 고정 칸이 있는 계획서를 만듭니다. |
| `task_group_plan_update(group_id, number, section, mode, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 선택한 칸을 편집합니다. |
| `task_group_plan_get(group_id, number)` | 계획서와 비어 있는 칸의 개수·이름을 읽습니다. |
| `task_group_plan_list(group_id)` | 계획서 번호·제목·빈칸 수를 보여줍니다. |

### 태스크 5개

| 도구 | 역할 |
|---|---|
| `task_add(group_id, content, batch, kind?, tag?, description?, spec?, instruction?, activeForm?, depends_on?, priority?, assignee?, target?, caused_by?, status?)` | 기존 그룹에 태스크 한 개를 추가합니다. |
| `task_update(group_id, number, status?, tag?, content?, activeForm?, batch?, kind?, depends_on?, priority?, assignee?, target?, caused_by?, outcome?, rejected?, field?, mode?, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 값이나 긴 글을 바꾸고 결과·완료·판정을 매니저 패널로 보내며 전송 결과를 기록합니다. |
| `task_get(group_id, number)` | 태스크 전문을 읽습니다. 받는 매니저가 읽으면 해당 보고도 읽음으로 바꿉니다. |
| `task_list(group_id?, all?)` | 기본은 내 담당 태스크만 보여줍니다. group_id를 지정해도 같으며, `all:true`이면 다른 담당자의 태스크도 보여줍니다. |
| `task_next(group_id, number?)` | 내 역할과 배정·선행 조건을 통과한 다음 태스크를 받아 진행 중으로 바꿉니다. `number`를 주면 그 번호만 같은 조건으로 확인합니다. |

### 캠페인 8개

| 도구 | 역할 |
|---|---|
| `campaign_add(name, about?)` | 새 루트에 캠페인의 본 맥락과 주제 노트 폴더를 만듭니다. |
| `campaign_read(name, full?)` | 본 맥락·차례·어긋남·그룹을 읽습니다. full이면 완료 그룹도 보여줍니다. |
| `campaign_context_add(name, title, text, topic?)` | 본 맥락 문서 또는 주제 노트를 추가하고 차례에 등록합니다. |
| `campaign_main_context_get(name)` | MAIN_CONTEXT 전체를 줄 번호와 함께 읽습니다. |
| `campaign_main_context_update(name, status?, field?, mode?, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 캠페인 상태 줄 또는 본문을 수정합니다. |
| `campaign_context_get(name, number, topic?)` | 지정한 맥락 문서 또는 주제 노트를 읽습니다. |
| `campaign_context_update(name, number, topic?, title?, field?, mode?, text?, at?, gap?, old?, new?, replace_all?, insert_after?)` | 맥락 문서의 제목이나 본문을 수정합니다. |
| `campaign_list()` | 이름·상태·그룹 수·남은 태스크 수를 보여줍니다. |

### 백로그 5개

| 도구 | 역할 |
|---|---|
| `backlog_add(title, tag, body?)` | 그룹 밖에 작업 항목을 보관합니다. |
| `backlog_list(tag?, state?)` | 태그와 상태로 항목을 조회합니다. 기본 상태는 open입니다. |
| `backlog_update(number, title?, tag?, body?, state?)` | 값을 교체하고 제목·태그 변경을 파일 이름에 반영합니다. |
| `backlog_drop(number)` | 파일을 보존한 채 dropped로 바꿉니다. |
| `backlog_promote(number, group_id?, topic?, batch?, assignee?)` | 기존 그룹이나 새 그룹에 work 태스크를 만듭니다. |

### 메시지 1개

| 도구 | 역할 |
|---|---|
| `message_list(group_id, state?)` | 기본은 read가 아닌 delivered·failed 보고입니다. delivered·failed·read·all로 범위를 고르고 상태와 실패 이유를 확인합니다. |

## task_next 선택 순서와 상태 전이

먼저 호출 패널을 그룹 members에서 찾습니다. 정체가 없으면
`cmux 패널 밖에서는 정체를 알 수 없어 거절합니다`라고 안내합니다.

`task_next`뿐 아니라 `task_add`와 `task_update`도 명단에 없는 패널을 거절합니다. 파일을 쓰기
전에 막으므로 거절된 요청은 태스크도 보고도 남기지 않습니다. 명단에서 뺀 옛 패널도 같습니다.
까닭은 세 가지로 갈립니다 — 이 패널이 명단에 없거나, 그룹에 명단이 아예 없거나, 옛 명단이라
등록된 패널이 하나도 없는 경우입니다. 어느 쪽이든 다음 행동은 하나입니다.

옛 그룹을 다시 여는 절차는 아래와 같습니다. `name`으로 항목을 찾으므로 같은 이름을 주면
UUID만 채워지고 항목이 늘지 않습니다. 이때 다른 이름으로 매니저를 하나 더 넣으면 매니저가
둘이 되어 거절되므로, 기존 `manager` 항목의 이름을 그대로 쓰거나 `remove`로 뺀 뒤 등록합니다.

```json
{ "group_id": "2026-08-01-옛-그룹",
  "members": [{ "name": "MNGR3", "surface": "surface:32", "roles": ["manager"] }] }
```

위 인자를 `task_group_update`에 넘깁니다. `surface`에는 UUID나 `surface:N`을 주며, 번호를
주면 도구가 `cmux tree`에서 UUID를 찾아 저장합니다. 옛 명단에 남아 있던 표기는 그대로 두어도
되고, 담당자를 옮길 때는 `task_update`의 `assignee`로 바꿉니다. 실물 JSON을 손으로 고치는
방법은 쓰지 않습니다.

| 종류 | 맡는 역할 | 배정 조건 |
|---|---|---|
| work·feedback | worker입니다. | assignee가 내 UUID여야 합니다. 빈 값이면 아무도 받을 수 없습니다. |
| test | tester입니다. | assignee가 비었거나 내 UUID여야 합니다. |
| review | reviewer입니다. | assignee가 비었거나 내 UUID여야 합니다. |
| onboard·research | 등록된 누구나 맡을 수 있습니다. | assignee가 비었거나 내 UUID여야 합니다. |

다음 순서로 태스크를 선택합니다.

1. 호출 패널의 정체와 명단을 확인합니다.
2. 내 assignee인 in_progress 태스크가 있으면 그것을 돌려줍니다. `number`로 다른 번호를 함께 주면 두 일을 한꺼번에 잡지 않도록 거절합니다.
3. pending 중 내 역할이 맡는 종류만 남깁니다.
4. 종류별 assignee 조건을 통과한 태스크만 남깁니다.
5. depends_on의 모든 태스크가 completed인 항목만 남깁니다.
6. priority가 큰 순서, 같으면 number가 작은 순서로 선택합니다.
7. 파일 이름을 in_progress로 바꿉니다. 다른 호출이 먼저 선택했다면 다시 읽고, 비어 있던 assignee는 호출 패널로 채웁니다.

후보가 없으면 남은 일이 없는 경우, 선행 작업을 기다리는 경우, 내 역할이 맡을 일이 없는
경우를 구분해서 안내합니다. 남의 in_progress 태스크를 대신 받지 않습니다.

`number`를 주면 자동 선택 대신 그 번호만 같은 조건으로 확인합니다. 겸임한 패널이 번호가
앞선 자기 일 대신 원하는 태스크를 집을 때 씁니다. 못 집으면 그 번호가 걸린 까닭을 하나로
답합니다 — 그룹에 없는 번호, 다른 패널이 진행 중, pending이 아님, 내 역할이 맡지 않는 종류,
다른 패널에 배정됨, 선행이 끝나지 않음 여섯입니다.

| 현재 상태 | 다음 상태 | 허용 조건 |
|---|---|---|
| draft | pending | 매니저 또는 생성자가 올립니다. spec이 있어야 하며 work·feedback은 assignee도 필요합니다. |
| pending | draft | 매니저 또는 생성자가 되돌립니다. |
| pending | in_progress | task_next로만 바꿉니다. task_update로 직접 올릴 수 없습니다. |
| in_progress | pending | 담당자 본인만 되돌립니다. 매니저도 남의 일을 되돌릴 수 없습니다. 담당자와 본문이 그대로 남아 다시 집을 수 있고, 되돌림은 보고 사건이 아니라 기록에 줄이 생기지 않습니다. |
| in_progress | completed | 담당자 또는 매니저가 완료합니다. |
| completed | 변경할 수 없습니다. | 본문과 값도 더 이상 수정할 수 없습니다. 고칠 것이 있으면 `task_add`로 feedback 태스크를 새로 만듭니다. |
| 옛 cancelled 등 표 밖 상태 | 변경할 수 없습니다. | 읽기만 지원합니다. |

옛 태스크에는 spec 칸이 없었으므로 상태 전이에서 spec 조건을 요구하지 않습니다.
새 태스크는 모든 종류에 명세를 작성하십시오.

`depends_on`을 생략했을 때의 기본값은 종류마다 다릅니다. `test`는 그 배치에 **이미 있는**
work·feedback 번호 전부를 받고, `review`는 거기에 **같은 배치의 test까지** 받습니다. 검증이
끝나기 전에 판정이 열리지 않게 하려는 것입니다. 그래서 한 배치를 깔 때는 work·feedback을
먼저 만들고 test를 만든 뒤 review를 만듭니다. review를 test보다 먼저 만들면 그 순간에는
test가 없으므로 기본값에 들어가지 않고, 뒤늦게 더한 test도 자동으로 따라가지 않습니다.
그럴 때는 매니저가 `task_update`의 `depends_on`으로 직접 잇습니다.

`depends_on`에 그 그룹에 없는 번호를 주면 거절합니다. 없는 번호를 받아 두면 그 태스크는
아무도 못 집는 채 pending으로 남고 목록에서는 여느 pending과 똑같이 보이기 때문입니다.

**배치는 흐름을 막지 않습니다.** 배치에는 별도의 완료 상태가 없고, 앞 배치의 검증이 도는
중에도 워커는 다음 배치의 일을 집습니다. 순서가 필요하면 `depends_on`으로 잇습니다. 검증에서
나온 수정은 feedback 태스크로 가고 하던 일을 멈추지 않습니다.

그룹 상태 `pending`과 캠페인 상태 줄의 「일시 중단」 표시도 `task_next`를 막지 않습니다.
둘 다 사람이 읽는 표시이며, 첫 `task_next`가 그룹을 진행 중으로 올립니다.

실제로 일을 멈추려면 태스크를 `draft`로 내립니다. 다만 상태에 따라 길이 다릅니다. 아직 아무도
받지 않은 `pending` 태스크는 매니저나 만든 패널이 바로 `draft`로 내립니다. 이미 누군가 받아
`in_progress`인 태스크는 담당자 본인이 먼저 `pending`으로 되돌린 뒤에야 내릴 수 있습니다.
`in_progress`에서 `draft`로 한 번에 가는 길은 없고, 남이 진행 중인 일을 대신 되돌릴 수도
없습니다. 아직 만들지 않은 일은 만들지 않는 것이 가장 단순한 멈춤입니다.

### review 거절과 feedback

리뷰어가 `outcome:"reject"`와 `rejected:[5,7]`을 기록하면 도구가 각 번호에 대한 feedback
태스크를 draft로 만듭니다. 원래 작업의 담당자를 유지하고, review와 같은 배치를 사용합니다.
`target`에는 원래 번호를, `caused_by`에는 review 번호를 넣습니다. review의 result는
feedback의 description으로 복사하고, spec은 비워 둡니다.

매니저는 수정 범위를 spec에 적고 pending으로 올립니다. 같은 review와 대상 번호로 이미
feedback이 있으면 다시 만들지 않습니다. 원래 담당자가 비어 있으면 배정도 채워야 합니다.
수정 후 검증이 필요하면 매니저가 test·review를 추가합니다. 도구가 다음 검사를 자동 생성하지는
않습니다. 태스크 간 작업 순서는 depends_on으로 정합니다.

## 보고를 받는 법

매니저는 별도 수신 등록을 하지 않습니다. 그룹 members에 manager 역할과 받을 패널의 UUID를
정확히 기록하십시오. 패널을 다시 열어 UUID가 바뀌었다면 `task_group_update`의 members로
같은 이름의 주소를 갱신하십시오.

워커가 결과와 완료를 기록하면 패널에 다음과 같은 한 줄이 도착합니다. 매니저가 일하는
중이어도 그 자리에서 보내며 패널의 다음 입력으로 대기합니다.

```text
[task-mcp] WRKR (surface:70) 이 2026-09-18-topic task-5 (work) 의 completed 를 적었습니다. 구현과 관련 검증을 완료했습니다. task_get 2026-09-18-topic 5
```

매니저는 줄 끝의 그룹과 번호로 `task_get`을 호출해 상세 결과를 읽습니다. 받는 매니저가
열었을 때 해당 태스크 보고의 state를 `read`로 바꾸고 `read_at`을 채웁니다.
`message_list`만 보거나 다른 패널이 태스크를 여는 것은 매니저의 읽음 처리가 아닙니다.

전송 실패는 `message_list({group_id, state:"failed"})`로 확인합니다. 상태와 reason을 읽고
cmux 실행 파일과 그룹 명단의 매니저 UUID를 확인하십시오. 실패한 보고를 나중에 자동으로
다시 보내지는 않습니다. 태스크에 저장된 결과는 `task_get`으로 확인합니다.

`message_list`의 머리 줄은 무엇을 걸러 보이는지 밝힙니다. `state`를 생략하면 「안 읽은 것
N건 / 기록 전체 M건」이고, `all`이면 「전부 N건」, `failed`면 「실패 N건」입니다. 앞의 수는
지금 보이는 줄이고 뒤의 수는 그 그룹의 기록 전체입니다.

**감시 도구는 예비입니다.** 보고는 워커가 적는 순간 도구가 보내므로 매니저가 감시를 걸어야
일이 굴러가는 것이 아닙니다. 감시는 보고가 올 수 없는 자리를 잡습니다 — 워커가 권한 물음에
막히거나 용량 오류를 만나거나 입력이 씹히거나 프로세스가 끝나면 `result`를 적지 못하고,
그런 자리는 기록에도 남지 않습니다. 절차는 `_MANUALS/multi-worker-panel-management.md`에
있습니다. 감시에 쓸 패널은 관리자에게 이 팀 몫으로 배정받은 것만 씁니다.

임시 프로젝트에서 전송을 검사할 때는 `TASK_MCP_FAKE_CMUX=1`을 지정합니다.
실제 패널로 보내는 대신 임시 프로젝트의 `.task-mcp-fake-cmux.jsonl`에 기록합니다.
`TASK_MCP_FAKE_SEND_FAIL=1`도 함께 지정하면 전송 실패를 재현합니다.
`TASK_MCP_FAKE_SCREEN`은 `busy`, `idle-empty`(기본값), `idle-stuck-once`, `idle-stuck-twice`,
`read-error`, `idle-stuck-wrapped`, `idle-stuck-stale-marker`, `busy-codex`, `text-late`, `text-never`의
열 가지입니다. 앞의 여섯 대본은 각각 Claude Code 작업 중, 빈 입력창, 한 번 남음, 두 번 남음, 읽기 오류,
다섯 줄로 접힌 입력창을 재현합니다. `idle-stuck-stale-marker`는 프롬프트 위 7번째 줄에 지난 턴의
마커가 있지만 보고가 남은 화면을 두 번 돌려줘 failed가 됩니다. `busy-codex`는 프롬프트 위 2줄의
Working 진행 줄을 보여줘 읽기 한 번 뒤 delivered가 됩니다. 모든 대본은 `Enter` 전의 읽기에서 글이
입력창에 들어간 화면을 돌려주되, `text-late`는 세 번째 읽기부터 보여 주고 `text-never`는 끝까지 보여
주지 않아 열 번 읽은 뒤 `Enter`가 나가며 둘 다 delivered가 됩니다. 가짜 기록에는 `op` 칸으로 구분한
`send`, `send-key`(키 이름 포함), `read-screen`(lines:20) 호출이 한 줄씩 남습니다.

## 캠페인 사용 흐름

1. campaign_list에서 캠페인 이름과 상태를 확인하고 campaign_read로 본 맥락을 읽습니다.
2. 공통 결정이나 배경을 추가할 때는 campaign_context_add를 사용합니다. topic을 생략하면 본 맥락 문서, topic을 주면 해당 주제의 노트가 됩니다.
3. 기존 문서는 campaign_context_get으로 읽고 campaign_context_update로 제목이나 본문을 수정합니다. 캠페인 상태는 campaign_main_context_update의 status로 바꿉니다.
4. 작업 묶음은 campaign을 지정한 task_group_add로 만들고 명단을 등록합니다. 조사 자료가 필요하면 task_group_research로 폴더를 만든 뒤 그 안에 문서를 작성합니다.
5. 매니저는 같은 배치의 work를 만들고 spec·assignee를 채웁니다. worker가 작업을 수행하면 tester의 test와 reviewer의 review가 선행 조건에 따라 이어집니다.
6. review가 거절한 작업은 feedback으로 처리하고, 이후 검사는 새 태스크와 depends_on으로 연결합니다. 그룹 밖에서 발견한 다음 작업은 backlog_add로 보관합니다.

campaign_read는 본 맥락 → 차례 → 차례와 실물의 어긋남 → 태스크 그룹 순서로 보여줍니다.
그룹을 숨기는 기준은 TASK_GROUP.json의 status가 done인지 여부입니다. 태스크가 0개이거나
태스크만 모두 완료되어도 그룹이 done이 아니면 계속 보입니다. `full:true`는 완료 그룹도
보여줍니다. 차례에 없는 문서나 실물이 없는 링크는 알리며 자동으로 고치지 않습니다.

## 옛 자리 읽기와 이관

| 옛 저장 대상 | 현재 규칙 |
|---|---|
| GROUP.json | TASK_GROUP.json을 먼저 읽고, 없으면 옛 파일을 읽습니다. 쓰기가 닿으면 새 이름에 쓰고 옛 파일을 제거합니다. |
| worker·manager 명단 | 읽을 때 members로 해석합니다. surface:N만 있는 항목은 UUID를 다시 등록해야 합니다. |
| .claude/campaigns | 새 루트가 있으면 .claude/mcp-task-campaign을 사용하고, 없으면 옛 루트를 읽고 씁니다. 새 캠페인 생성은 새 루트를 사용합니다. |
| 옛 태스크 파일 이름 | 영구적으로 읽기를 지원합니다. 배치가 없는 옛 태스크도 읽으며, batch를 지정해 수정하면 새 이름을 사용합니다. |
| campaign-context·main-context·README.md | 캠페인 조회에서 읽지 않습니다. 이관 스크립트가 본 맥락 문서를 옮깁니다. |
| 캠페인 plans.md·researches.md·researches/ | 캠페인 조회에서 읽지 않습니다. 조사 폴더 이관은 스크립트가 처리합니다. |
| 그룹 NOTES.md·plans.md | 노트·계획서 목록에서 읽지 않습니다. notes/와 plans/를 사용합니다. |
| .claude/tasks | 새·옛 독립 그룹을 함께 읽습니다. 옛 실물 그룹을 수정할 때 그룹 전체를 mcp-task로 복사하고 새 사본만 고칩니다. |

같은 독립 그룹이 새·옛 루트에 있으면 새 루트를 우선하고 내용을 임의로 합치지 않습니다.
옛 캠페인의 날짜 없는 이름은 그대로 호출합니다. 일반 목록 조회는 옛 문서를
이관하지 않습니다. 다만 받는 매니저의 task_get은 해당 보고에 읽음 기록을 남깁니다.

이관 순서·dry-run·실행 기록·되돌리는 방법은 [이관 매뉴얼](migrate/README.md)을 따릅니다.
01 그룹 레코드, 02 캠페인 루트, 03 캠페인 맥락, 04 그룹 접두사, 05 조사 폴더 순서입니다.
기본 실행은 dry-run이며 실제 장부의 `--apply`는 매니저가 수행합니다.
워커와 테스터는 실물 dry-run 결과를 검산하고, 실제 이관 후에는 경로와 파일 수를 다시 확인합니다.

## 안전한 운영

- 없는 그룹에는 태스크를 추가할 수 없습니다. 먼저 task_group_add로 그룹을 만드십시오.
- 상태·판정·본문은 도구 계약을 통해 수정하고, 완료된 태스크 파일은 보존하십시오.
- 실물에 대한 쓰기 테스트는 하지 않습니다. `CLAUDE_PROJECT_DIR`가 임시 프로젝트를 가리키는 환경에서 검사하십시오.
- 전체 테스트는 `node --test .claude/tools/task-mcp/test/*.test.mjs`로 실행합니다. 개발 사본은 task-mcp-next 경로를 사용합니다.
- 이관용 심볼릭 링크는 실행 중인 옛 서버를 위해 유지합니다. 제거는 별도 전환 절차를 따릅니다.
- 매뉴얼과 서버 계약을 대조할 때는 실제 --tools 출력의 이름·인자·선택 표시를 확인하십시오.

### 코드를 바꾼 뒤 — 교체와 재연결과 재시작은 서로 다릅니다

셋을 같은 것으로 보면 새 계약이 안 보이는데도 고쳤다고 판단하게 됩니다. 순서대로 확인합니다.

1. **교체** — 서버 파일을 새 것으로 바꿉니다. 이미 떠 있는 MCP 프로세스는 옛 코드를 메모리에 물고 있으므로 이것만으로는 아무것도 달라지지 않습니다.
2. **재연결** — 세션에서 `/mcp`로 서버를 다시 붙입니다. 서버 프로세스가 새로 떠서 새 코드가 돕니다.
3. **세션 재시작** — 재연결해도 세션이 이미 불러 둔 도구 스키마는 옛 인자 목록으로 남을 수 있습니다. 새 인자를 그대로 주면 서버가 받아들이지만 화면에는 옛 계약이 보입니다. 스키마 표시까지 갱신하려면 세션을 다시 시작합니다.

무엇이 실제로 도는지는 `node .claude/tools/mcp-call.mjs <서버 절대경로> --tools`로 확인합니다.
이 호출은 매번 새 프로세스를 띄우므로 세션의 캐시와 무관하게 지금 파일의 계약을 보여 줍니다.
`.codex/config.toml`의 `env_vars` 같은 설정을 바꿨다면 codex 패널은 세션을 다시 시작해야
그 값이 서버에 닿습니다.

## 그룹은 사람이 닫는다

태스크를 모두 완료해도 그룹은 자동으로 done이 되지 않습니다. 매니저는 라운드를 마칠 때
`task_group_update`에 `status:"done"`을 넘겨 그룹을 닫습니다. 닫힌 그룹은 기본 목록에서
숨겨집니다.

중단하는 그룹도 done으로 닫고 about에 중단 이유와 남은 작업을 적습니다. 진행하지 못한
태스크의 상태를 완료로 바꾸지 마십시오.

다시 시작할 때는 그룹 상태를 되돌리고 명단부터 확인합니다. 이관으로 옮겨 온 옛 그룹의
명단에는 워커와 매니저 두 자리만 있고 UUID가 비어 있습니다. 그 상태로는 아무도 일을 받거나
쓸 수 없으므로 위의 복구 절차대로 지금 패널의 UUID를 채웁니다. 테스터와 리뷰어, 둘째 워커는
옛 레코드에 자리가 없었으므로 새로 등록합니다. 보고를 받을 매니저의 UUID도 함께 확인합니다.

버려진 draft가 그 배치의 test를 막고 있으면, 매니저가 까닭을 노트에 적고 그 test의
`depends_on`에서 그 번호를 뺍니다. 하지 않은 일을 완료로 바꾸거나 새 상태를 만들지 않습니다.

설계의 단일 진실원천은 `.claude/plans/2026-09-18-task-mcp-stack-model-overhaul/SPEC.md`입니다.
2026-09-18 보고 전달 개정은 그룹 `task-group-2026-09-18-보고-직통-전환`의 노트 1 「대본」을
따릅니다. 그 노트의 관리자님 결정과 M-25·M-28이 이전 보고 전달 규칙보다 우선합니다.
