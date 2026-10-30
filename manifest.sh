# my-dot-claude 관리 대상 목록 — install.sh / update.sh 가 공유하는 단일 원천.
# 경로는 ~/.claude/ 기준 상대경로. 폴더는 통째로, 파일은 그 파일만.

# AGENTS.md = 규칙 원본(Claude·codex 공용). CLAUDE.md = 「@AGENTS.md」 연결부 + Claude 전용 각주.
# settings.json 은 관리하지 않는다 — 자동 모드 환경 설명(autoMode)에 회사 배포 주소·민감 파일 위치가
# 들어가는데 이 레포는 공개라서다. 설정·훅 배선은 기기마다 직접 둔다.
TARGETS=(
  "AGENTS.md"
  "CLAUDE.md"
  "skills"
  "tools"
)

# skills 중 수집하지 않는 것 — 외부에서 받은 사본과 codex 전용 심볼릭 링크.
# 자작이 아닌 스킬을 새로 설치하면 여기에 한 줄 추가한다.
SKILL_EXCLUDES=(
  "refactoring-ui"
  "supabase"
  "supabase-postgres-best-practices"
  "sui-dev-skills"
  "vercel-react-best-practices"
  "vercel-react-native-skills"
  "web-design-guidelines"
  "agent-browser"
  "building-components"
  "find-skills"
  "workflow"
  "synced"   # Claude 앱이 동기화하는 Anthropic 스킬 사본
  ".trash"   # Claude 앱이 지운 동기화 스킬 보관
)

# tools 중 수집하지 않는 것 — 자작이 아닌 실행 파일·대용량 바이너리.
TOOL_EXCLUDES=(
  "obscura"  # 외부 브라우저 실행 파일 두 개(약 181MB)
)
