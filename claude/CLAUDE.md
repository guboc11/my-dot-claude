@AGENTS.md

# Claude Code 전용 각주

규칙 원본은 같은 폴더의 AGENTS.md 한 벌입니다(codex는 ~/.codex/AGENTS.md 링크로 같은 파일을 읽습니다). 아래는 Claude Code 도구에만 해당하는 내용입니다.

## 5. 개발 서버 실행 — Claude Code 갈래

server mcp로 띄울 수 없는 서버나 프로그램 같은 경우는 Bash 도구의 run_in_background: true로 각 서버를 개별 실행한다. 이렇게 해야 Claude Code TUI 하단의 background tasks에 표시되어 사용자가 확인할 수 있다. 쉘 내부 &로 백그라운드 처리하면 TUI에 안 보이므로 금지.
단, 그 프로젝트에 세트 기반 서버관리 MCP(예: digital-guestbook-v3의 server-mcp — mcp__server__set_up 등)가 있으면 세트 서버(fe/api)는 그 도구로 띄운다 — 현황·env·URL을 장부로 관리하므로 run_in_background를 대체한다. 일회성 명령(빌드·테스트·curl)은 그대로 run_in_background.
