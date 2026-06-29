import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SessionMemory,
  mergeSharedContextHints,
  toolCallCacheKey,
  toolCallDisplayKey,
} from "./session-memory";
import type { SessionMemoryConfig } from "../config";

function makeConfig(overrides: Partial<SessionMemoryConfig> = {}): SessionMemoryConfig {
  return {
    enabled: true,
    tool_result_ttl_ms: 60_000,
    max_tool_results: 8,
    max_file_snapshots: 4,
    max_failure_patterns: 4,
    session_ttl_ms: 60_000,
    persist: false,
    ...overrides,
  };
}

describe("session-memory", () => {
  test("toolCallCacheKey is stable for equivalent args", () => {
    const a = toolCallCacheKey("read_file", { path: "src/a.ts", limit: 10 }, "/workspace");
    const b = toolCallCacheKey("read_file", { limit: 10, path: "src/a.ts" }, "/workspace");
    expect(a).toBe(b);
    expect(toolCallDisplayKey("read_file", { path: "src/a.ts" })).toBe("read_file:src/a.ts");
  });

  test("records read_file output and serves cache hits", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "sess-1",
      toolName: "read_file",
      args: { path: "src/auth.ts" },
      result: { output: "export const auth = true;", is_error: false },
      workspacePath: "/workspace",
    });

    const cached = memory.lookupCachedToolResult("sess-1", "read_file", { path: "src/auth.ts" }, "/workspace");
    expect(cached).toContain("export const auth");

    const hints = memory.toSharedContextHints("sess-1");
    expect(hints?.prior_tool_results?.["read_file:src/auth.ts"]).toContain("export const auth");
  });

  test("invalidates cached reads after write_file", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "sess-2",
      toolName: "read_file",
      args: { path: "src/auth.ts" },
      result: { output: "old content", is_error: false },
    });
    memory.recordToolResult({
      sessionId: "sess-2",
      toolName: "write_file",
      args: { path: "src/auth.ts", content: "new content" },
      result: { output: "written", is_error: false },
    });

    expect(memory.lookupCachedToolResult("sess-2", "read_file", { path: "src/auth.ts" })).toBeUndefined();
  });

  test("records pipeline failures into failure patterns", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordPipelineOutcome("sess-3", {
      outcome: "failed",
      errorCode: "empty_completion",
      error: "synthesizer returned empty content",
    });

    const hints = memory.toSharedContextHints("sess-3");
    expect(hints?.failure_patterns?.[0]).toContain("empty_completion");
    expect(memory.getLastOutcome("sess-3")).toContain("failed");
  });

  test("mergeSharedContextHints combines conductor and memory layers", () => {
    const merged = mergeSharedContextHints(
      {
        relevant_memories: ["Conductor memory"],
        prior_tool_results: { "grep:auth": "1 match" },
      },
      {
        failure_patterns: ["read_file failed: ENOENT"],
        prior_tool_results: { "read_file:src/a.ts": "content" },
      },
    );

    expect(merged?.relevant_memories).toContain("Conductor memory");
    expect(merged?.failure_patterns?.[0]).toContain("ENOENT");
    expect(merged?.prior_tool_results?.["read_file:src/a.ts"]).toBe("content");
    expect(merged?.prior_tool_results?.["grep:auth"]).toBe("1 match");
  });

  test("persists and reloads session memory from disk", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-memory-"));
    try {
      const cfg = makeConfig({ persist: true });
      const writer = new SessionMemory(() => cfg, tempRoot);
      writer.recordToolResult({
        sessionId: "disk-sess",
        toolName: "grep",
        args: { pattern: "Coordinator" },
        result: { output: "3 matches", is_error: false },
      });

      const reader = new SessionMemory(() => cfg, tempRoot);
      expect(reader.getSessionState("disk-sess")).toBeUndefined();
      const cached = reader.lookupCachedToolResult("disk-sess", "grep", { pattern: "Coordinator" });
      expect(cached).toBe("3 matches");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});