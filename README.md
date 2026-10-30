# my-dot-claude

`~/.claude/` 글로벌 영역에서 **내가 만든 것만** 골라 버전 관리하는 레포.
에이전트 행동 규칙(AGENTS.md — Claude Code·codex 공용), 자작 스킬, 자작 도구(MCP 서버와 스크립트)를 담는다.
대화 기록·시크릿·캐시 같은 머신 상태, 기기별 설정(settings.json), 외부에서 받은 스킬·실행 파일은 범위 밖이다.

## 구조

```
claude/          ~/.claude/ 의 미러 (관리 대상만)
  AGENTS.md      글로벌 행동 규칙 원본 — Claude Code와 codex가 같은 파일을 읽는다
  CLAUDE.md      「@AGENTS.md」 연결부 + Claude Code 전용 각주
  skills/        자작 스킬
  tools/         자작 도구 — {이름}-mcp/ 폴더는 MCP 서버 하나
manifest.sh      관리 대상·제외 목록 (두 스크립트의 단일 원천)
install.sh       레포 → 홈 설치 (+ codex 규칙 연결)
update.sh        홈 → 레포 수집
LEGACY/          은퇴한 스킬·자료 보관
```

## 규칙 파일 한 벌

규칙은 `~/.claude/AGENTS.md` 하나만 고친다.

- Claude Code는 `~/.claude/CLAUDE.md`를 읽고, 그 첫 줄 `@AGENTS.md`가 원본을 불러온다.
  Claude Code 도구에만 해당하는 내용(Bash `run_in_background` 등)만 `CLAUDE.md` 각주에 둔다.
- codex는 `~/.codex/AGENTS.md`를 읽는데, 이 파일은 `~/.claude/AGENTS.md`를 가리키는 링크다.
  `install.sh`가 기존 파일을 `.bak-{시각}`으로 옮기고 링크를 만든다.
- 사본을 두 벌 두면 한쪽만 고쳐져 두 에이전트가 다른 규칙으로 일하게 된다. 그래서 링크로 묶는다.

## 설치 (새 기기 · 타인)

```sh
git clone https://github.com/guboc11/my-dot-claude
cd my-dot-claude
./install.sh --dry-run   # 무엇이 복사·등록되는지 먼저 확인
./install.sh
```

- 홈의 다른 파일은 지우지 않고, 덮어쓰는 파일은 `~/.claude/.install-backup/`에 백업된다.
- MCP 등록은 `claude/tools/`의 `{이름}-mcp` 폴더에서 자동 유도해 user 스코프로 추가한다.
  이름이 `-mcp`로 끝나지 않는 도구(`document-template`·`manage-env`·`md-convert`·`web-search`)는
  자동 등록 대상이 아니라 필요하면 직접 등록한다.
- `~/.codex/`가 있으면 `~/.codex/AGENTS.md`를 원본 링크로 바꾼다(기존 파일은 백업). 없으면 건너뛴다.
- `settings.json`(권한·모델·훅 배선)은 이 레포가 관리하지 않는다. 자동 모드 환경 설명에 회사 배포 주소·민감 파일
  위치가 들어가는데 이 레포는 공개라서다. reminder-mcp의 UserPromptSubmit 훅 같은 배선은 기기마다
  `~/.claude/settings.json`에 직접 넣는다(각 도구 MANUAL 참고).
- 설치 후 Claude Code·codex 재시작 필요.

## 평소 흐름 (소유자)

1. `~/.claude/`에서 그냥 작업한다 (스킬 추가, 도구 수정, 규칙 갱신).
2. `./update.sh` — 관리 대상만 레포로 수집된다 (`--dry-run`으로 미리보기 가능).
3. `git diff`로 확인하고 커밋·푸시한다. 스크립트는 절대 커밋하지 않는다.

- 홈에서 지운 파일은 수집 때 레포에서도 지워진다(미러). 삭제 확정은 커밋이 한다.
- 외부에서 받은 스킬은 수집하지 않는다 — 새로 받으면 `manifest.sh`의
  `SKILL_EXCLUDES`에 이름을 추가한다. Claude 앱이 동기화하는 `synced/`·`.trash/`도 여기서 뺀다.
- 자작이 아닌 도구·대용량 실행 파일(예: `obscura`)은 `TOOL_EXCLUDES`에 이름을 추가한다.
- 잘 안 쓰는 스킬은 레포 `LEGACY/skills/`로 옮긴 뒤 홈에서 빼면 다음 수집 때 `claude/skills/`에서도 빠진다.

## 자작 도구

| 이름 | 역할 |
|---|---|
| task-mcp | 캠페인·태스크 그룹·태스크·백로그 장부. 역할별로 태스크를 받고 결과를 매니저 패널에 보낸다 |
| server-mcp | 멀티 에이전트가 서로 안 밟게 로컬 서버 세트를 띄우고 장부로 관리 |
| docs-explorer-mcp | 레포 Markdown 문서를 폴더·문서·절 순서로 찾고 읽는 읽기 전용 지도 |
| prototype-mcp | 프로토타입 시안 생명주기(생성·설계서·스토리보드·서버·마무리) |
| notepad-mcp | 사람용 메모장 — 적을 때 해석하지 않는다 |
| reminder-mcp | 세션별 리마인드를 매 턴 다시 넣어 줌 (글로벌 UserPromptSubmit 훅과 한 쌍) |
| papercup-mcp | 같은 LAN의 Claude끼리 쪽지·파일을 직접 주고받음 |
| document-template | 규칙 폴더별 문서 형식(템플릿) 장부와 생성 |
| manage-env | 환경 변수 파일 관리 — 응답에 값을 싣지 않고 이름·경로·명령만 |
| md-convert | md 원본 → 인쇄용 pdf |
| web-search | 여러 에이전트가 한 작업대를 나눠 쓰는 웹 조사 |
| watch-worker | 워커 패널을 지켜보다 상태가 바뀌면 끝나며 매니저를 깨우는 감시 스크립트 |
| mcp-call.mjs | MCP를 등록할 수 없는 환경용 stdio MCP 호출기 |
| copy-lint.mjs | 코퍼스에 실재하지 않는 카피 표현 검출기 |

도구는 Node로 돌고, 저장은 실행 시점의 프로젝트 `.claude/` 아래에 한다 — 코드 한 벌로
모든 프로젝트에서 동작한다. `node_modules`는 수집하지 않으니 필요한 도구(md-convert 등)는 그 폴더에서 설치한다.
