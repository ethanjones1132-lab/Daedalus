// ═══════════════════════════════════════════════════════════════
// ── Jarvis MCP stdio server (Claude delegate + external clients) ──
// ═══════════════════════════════════════════════════════════════
// Spawned by Claude CLI via --mcp-config. Reuses mcp-adapter with the
// filesystem/git/task-control bundles (no shell / Task-spawning).

import { loadConfig } from "./config";
import {
  createDelegateMcpAdapter,
  DELEGATE_MCP_SESSION_GRANTS_ENV,
  DELEGATE_MCP_WORKSPACE_ENV,
  runMcpStdioLoop,
} from "./mcp-adapter";

function parseSessionGrants(raw: string | undefined, fallback: string[]): string[] {
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const roots = parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return roots.length > 0 ? roots : fallback;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const workspacePath =
    process.env[DELEGATE_MCP_WORKSPACE_ENV]?.trim()
    || process.env.CLAUDE_PROJECT_DIR?.trim()
    || process.cwd();
  const allowedRoots = parseSessionGrants(
    process.env[DELEGATE_MCP_SESSION_GRANTS_ENV],
    [workspacePath],
  );

  const adapter = createDelegateMcpAdapter(loadConfig(), {
    workspacePath,
    allowedRoots,
  });

  await runMcpStdioLoop(adapter);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`jarvis-mcp-stdio: ${message}\n`);
  process.exit(1);
});
