#!/usr/bin/env bash
# install.sh — 레포(claude/) → ~/.claude/ 설치. 새 기기 복원·타인 설치용.
#
# 원칙:
#   1. 지우지 않는다 — --delete 없음. 홈에 있던 다른 파일은 절대 건드리지 않는다.
#   2. 덮어쓰는 파일은 먼저 백업한다 (~/.claude/.install-backup/{시각}/).
#   3. MCP 등록은 tools/ 폴더 이름에서 유도한다 — {이름}-mcp 폴더마다 user 스코프 등록.
#   4. --dry-run 이면 무엇이 복사·등록될지만 보여주고 아무것도 바꾸지 않는다.
#   5. 규칙 원본은 ~/.claude/AGENTS.md 한 벌이다 — codex 는 ~/.codex/AGENTS.md 링크로 같은 파일을 읽는다.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_DIR/claude"
DEST="$HOME/.claude"
# shellcheck source=manifest.sh
source "$REPO_DIR/manifest.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ ! -d "$SRC" ]; then
  echo "오류: $SRC 가 없습니다. update.sh 로 먼저 수집했는지 확인하세요." >&2
  exit 1
fi

RSYNC_FLAGS=(-a --exclude .DS_Store)
if [ "$DRY" = 1 ]; then
  RSYNC_FLAGS+=(-n -v)
  echo "── dry-run: 실제로는 아무것도 바꾸지 않습니다 ──"
else
  BACKUP_DIR="$DEST/.install-backup/$(date +%Y%m%d-%H%M%S)"
  RSYNC_FLAGS+=(--backup --backup-dir="$BACKUP_DIR")
  mkdir -p "$DEST"
fi

echo "== 1/3 파일 복사: $SRC → $DEST =="
for t in "${TARGETS[@]}"; do
  if [ -d "$SRC/$t" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC/$t/" "$DEST/$t/"
  elif [ -f "$SRC/$t" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC/$t" "$DEST/$t"
  else
    echo "  (건너뜀 — 레포에 없음: $t)"
  fi
done
if [ "$DRY" = 0 ] && [ -d "${BACKUP_DIR:-/nonexistent}" ]; then
  echo "  덮어쓴 파일 백업: $BACKUP_DIR"
fi

echo "== 2/3 MCP user 스코프 등록 (tools/{이름}-mcp 폴더에서 유도) =="
if ! command -v claude >/dev/null 2>&1; then
  echo "  claude CLI 가 없어 등록을 건너뜁니다. 설치 후 아래를 직접 실행하세요:"
  for d in "$SRC"/tools/*-mcp/; do
    name="$(basename "$d")"; name="${name%-mcp}"
    echo "    claude mcp add --scope user $name -- node ~/.claude/tools/${name}-mcp/server.mjs"
  done
else
  for d in "$SRC"/tools/*-mcp/; do
    name="$(basename "$d")"; name="${name%-mcp}"
    if claude mcp get "$name" >/dev/null 2>&1; then
      echo "  이미 등록됨: $name (건너뜀)"
    elif [ "$DRY" = 1 ]; then
      echo "  등록 예정: claude mcp add --scope user $name -- node ~/.claude/tools/${name}-mcp/server.mjs"
    else
      claude mcp add --scope user "$name" -- node "$DEST/tools/${name}-mcp/server.mjs"
    fi
  done
fi

echo "== 3/3 codex 규칙 연결 (~/.codex/AGENTS.md → ~/.claude/AGENTS.md) =="
CODEX_DIR="$HOME/.codex"
CODEX_RULES="$CODEX_DIR/AGENTS.md"
if [ ! -d "$CODEX_DIR" ]; then
  echo "  ~/.codex 가 없어 건너뜁니다 (codex 를 쓰지 않는 기기)."
elif [ -L "$CODEX_RULES" ] && [ "$(readlink "$CODEX_RULES")" = "$DEST/AGENTS.md" ]; then
  echo "  이미 연결됨 (건너뜀)"
elif [ "$DRY" = 1 ]; then
  [ -e "$CODEX_RULES" ] && echo "  백업 예정: $CODEX_RULES → $CODEX_RULES.bak-$(date +%Y%m%d)"
  echo "  연결 예정: ln -s $DEST/AGENTS.md $CODEX_RULES"
else
  if [ -e "$CODEX_RULES" ] || [ -L "$CODEX_RULES" ]; then
    mv "$CODEX_RULES" "$CODEX_RULES.bak-$(date +%Y%m%d-%H%M%S)"
    echo "  기존 파일 백업: $CODEX_RULES.bak-…"
  fi
  ln -s "$DEST/AGENTS.md" "$CODEX_RULES"
  echo "  연결함: $CODEX_RULES → $DEST/AGENTS.md"
fi

echo
echo "완료. Claude Code·codex 를 재시작하세요."
echo "(settings.json 은 이 레포가 관리하지 않습니다 — 훅 배선이 필요한 도구는 ~/.claude/settings.json 에 직접 연결하세요.)"
