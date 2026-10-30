// 검사들이 함께 쓰는 뼈대. 실물 장부를 건드리지 않도록 CLAUDE_PROJECT_DIR 은 언제나 임시 폴더다.
//
// 2026-09-18 개편에서 g1-split-parity 가 은퇴하면서 그것만 쓰던 여섯(makeLegacyReadView ·
// callToolDirect · normalize · snapshotProject · countTaskFiles · countCampaigns)을 뺐다.
// LEGACY_SERVER 는 남긴다 — mcp-task-root-compat 의 심볼릭 링크 검사가 옛 서버를 실제로 띄워 본다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// 서버 경로는 이 파일 위치에서 역산한다 — 도구 폴더를 사본으로 복사해 개발할 때
// 이름을 박아 두면 사본의 테스트가 원자리 서버를 부른다 (2026-09-18 실측).
export const PROJECT_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
export const LEGACY_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy-server.mjs');
const MCP_CALL = path.join(REPO, '.claude', 'tools', 'mcp-call.mjs');

export function mcpTaskRoot(project) {
  return path.join(project, '.claude', 'mcp-task');
}

export function legacyTaskRoot(project) {
  return path.join(project, '.claude', 'tasks');
}

export function mcpTaskGroupDir(project, groupId) {
  return path.join(mcpTaskRoot(project), groupId);
}

export function legacyTaskGroupDir(project, groupId) {
  return path.join(legacyTaskRoot(project), groupId);
}

export function makeProject(prefix = 'task-mcp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeProject(project) {
  fs.rmSync(project, { recursive: true, force: true });
}

export function callTool(server, project, name, args = {}, surface = 'surface:g1') {
  return execFileSync(
    process.execPath,
    [MCP_CALL, server, name, JSON.stringify(args)],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trimEnd();
}

export function callToolAsync(server, project, name, args = {}, surface = 'surface:g1') {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [MCP_CALL, server, name, JSON.stringify(args)],
      {
        cwd: REPO,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          error.stdout = stdout;
          reject(error);
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

export function callToolError(server, project, name, args = {}, surface = 'surface:g1') {
  const result = spawnSync(
    process.execPath,
    [MCP_CALL, server, name, JSON.stringify(args)],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status === 0) throw new Error(`${name} 호출이 성공했지만 오류를 예상했습니다.`);
  return String(result.stdout || '').trimEnd();
}

export function listToolsOutput(server, project) {
  return execFileSync(
    process.execPath,
    [MCP_CALL, server, '--tools'],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: 'surface:g1' },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trimEnd();
}

export function listTools(server, project) {
  return listToolsOutput(server, project).split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split('(')[0]);
}
