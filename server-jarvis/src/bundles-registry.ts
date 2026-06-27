// ═══════════════════════════════════════════════════════════════
// ── Bundle registration — single entry point for all surfaces ──
// ═══════════════════════════════════════════════════════════════
// Chat, cron, agent, and MCP adapters register tools through here so
// new bundles are added once instead of per-surface copy-paste.

import type { ToolRuntime } from "./tool-runtime";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { registerShellBundle } from "./shell-bundle";
import { registerWebBundle } from "./web-bundle";
import { registerMetaBundle } from "./meta-bundle";
import { registerTaskBundle } from "./task-bundle";
import { registerMcpClientBundle } from "./mcp-client-bundle";
import { registerInteractiveBundle } from "./interactive-bundle";

/** Register the standard Jarvis tool bundles on a fresh runtime. */
export function registerStandardBundles(runtime: ToolRuntime): void {
  registerFilesystemBundle(runtime);
  registerShellBundle(runtime);
  registerWebBundle(runtime);
  registerMetaBundle(runtime);
  registerTaskBundle(runtime);
  registerMcpClientBundle(runtime);
  registerInteractiveBundle(runtime);
}