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
  test("persists a task contract and resumes its full depth on continue", () => {
    const memory = new SessionMemory(() => makeConfig());
    const first = memory.beginTaskRun("sess-task", {
      message: "Perform a comprehensive architecture audit",
      requirement: "workspace_read",
      workspacePath: "C:\\Projects\\Versutus",
      depth: "deep",
      estimatedComplexity: "high",
    });

    const continued = memory.beginTaskRun("sess-task", {
      message: "continue",
      requirement: "conversational",
      workspacePath: "C:\\Projects\\Versutus",
      depth: "standard",
      estimatedComplexity: "medium",
    });

    expect(continued.taskRunId).toBe(first.taskRunId);
    expect(continued.objective).toBe(first.objective);
    expect(continued.requirement).toBe("workspace_read");
    expect(continued.depth).toBe("deep");
    expect(continued.estimatedComplexity).toBe("high");
    expect(continued.turnCount).toBe(2);
  });

  test("persists and unions session root grants across continuation turns", () => {
    const memory = new SessionMemory(() => makeConfig());
    const first = memory.beginTaskRun("sess-grants", {
      message: "Inspect C:\\Projects\\one",
      requirement: "workspace_read",
      sessionGrants: ["C:\\Projects\\one"],
    });
    const continued = memory.beginTaskRun("sess-grants", {
      message: "continue with D:\\Data",
      requirement: "workspace_read",
      sessionGrants: ["D:\\Data", "C:\\Projects\\one"],
    });

    expect(first.sessionGrants).toEqual(["C:\\Projects\\one"]);
    expect(continued.taskRunId).toBe(first.taskRunId);
    expect(continued.sessionGrants).toEqual(["C:\\Projects\\one", "D:\\Data"]);
  });

  // P5.3d: getSessionGrants/revokeSessionGrant back the workspace-grants chip.
  test("getSessionGrants reads the persisted grants; empty for a session with none", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.beginTaskRun("sess-grants-read", {
      message: "Inspect C:\\Projects\\one",
      requirement: "workspace_read",
      sessionGrants: ["C:\\Projects\\one", "D:\\Data"],
    });

    expect(memory.getSessionGrants("sess-grants-read")).toEqual(["C:\\Projects\\one", "D:\\Data"]);
    expect(memory.getSessionGrants("sess-never-seen")).toEqual([]);
  });

  test("revokeSessionGrant removes exactly one root and leaves the rest of the task run intact", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.beginTaskRun("sess-grants-revoke", {
      message: "Inspect C:\\Projects\\one",
      requirement: "full_execution",
      sessionGrants: ["C:\\Projects\\one", "D:\\Data"],
    });

    const remaining = memory.revokeSessionGrant("sess-grants-revoke", "C:\\Projects\\one");

    expect(remaining).toEqual(["D:\\Data"]);
    expect(memory.getSessionGrants("sess-grants-revoke")).toEqual(["D:\\Data"]);
    // Revoking a grant must not touch the rest of the task-run contract.
    const task = memory.getTaskRun("sess-grants-revoke");
    expect(task?.requirement).toBe("full_execution");
    expect(task?.status).toBe("active");
  });

  test("revoking a grant from a session with no task run is a no-op, not an error", () => {
    const memory = new SessionMemory(() => makeConfig());
    expect(memory.revokeSessionGrant("sess-nonexistent", "C:\\anything")).toEqual([]);
  });

  test("keeps task-run state ephemeral when persistence is disabled", () => {
    const memory = new SessionMemory(() => makeConfig({ enabled: false, persist: false }));
    const task = memory.beginTaskRun("ephemeral-task", {
      message: "read the repository",
      requirement: "workspace_read",
      depth: "standard",
    });

    const updated = memory.updateTaskRun("ephemeral-task", {
      status: "completed",
      evidenceCount: 1,
      lastOutcome: "success",
    });

    expect(updated?.taskRunId).toBe(task.taskRunId);
    expect(updated?.status).toBe("completed");
    expect(memory.getTaskRun("ephemeral-task")?.evidenceCount).toBe(1);
  });

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

  test("scopes retrieved tool results and file facts to the active workspace", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "workspace-switch",
      toolName: "read_file",
      args: { path: "README.md" },
      result: { output: "Jarvis is a Tauri desktop platform with a Bun server.", is_error: false },
      workspacePath: "C:\\Projects\\home-base-recovered",
    });
    memory.recordToolResult({
      sessionId: "workspace-switch",
      toolName: "read_file",
      args: { path: "README.md" },
      result: { output: "Versutus is an Expo React Native mobile application.", is_error: false },
      workspacePath: "C:\\Projects\\Versutus",
    });

    const jarvisHints = memory.toSharedContextHints(
      "workspace-switch",
      "c:/projects/home-base-recovered/",
    );
    expect(jarvisHints?.prior_tool_results?.["read_file:README.md"]).toContain("Tauri desktop");
    expect(jarvisHints?.prior_tool_results?.["read_file:README.md"]).not.toContain("Expo");
    expect(jarvisHints?.relevant_memories?.join("\n")).toContain("home-base-recovered/README.md");
    expect(jarvisHints?.relevant_memories?.join("\n")).not.toContain("Versutus/README.md");
    expect(memory.lookupCachedToolResult(
      "workspace-switch",
      "read_file",
      { path: "README.md" },
      "c:/projects/home-base-recovered/",
    )).toContain("Tauri desktop");

    const versutusHints = memory.toSharedContextHints("workspace-switch", "C:\\Projects\\Versutus");
    expect(versutusHints?.prior_tool_results?.["read_file:README.md"]).toContain("Expo React Native");
    expect(versutusHints?.prior_tool_results?.["read_file:README.md"]).not.toContain("Tauri desktop");
  });

  test("a failed read_file records a failure pattern, not a snapshot, fact, or cache hit", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "sess-failed-read",
      toolName: "read_file",
      args: { path: "src/missing.ts" },
      result: { output: "", error: "File not found: /workspace/src/missing.ts", is_error: true },
      workspacePath: "/workspace",
    });

    expect(memory.lookupCachedToolResult(
      "sess-failed-read",
      "read_file",
      { path: "src/missing.ts" },
      "/workspace",
    )).toBeUndefined();

    const state = memory.getSessionState("sess-failed-read")!;
    expect(Object.keys(state.fileSnapshots)).toHaveLength(0);
    expect(Object.keys(state.discoveredFacts)).toHaveLength(0);
    expect(state.failureHistory[0]?.pattern).toContain("read_file failed: File not found");
  });

  // 2026-07-18 23:42 incident: "Now complete phase 2 please" failed because
  // the turn had no idea IMPLEMENTATION_PLAN.md had been written one turn
  // earlier — the synthesizer asked the user for the Phase 2 requirements that
  // were sitting in that file. Successful writes must become durable session
  // facts so continuation turns know where this session's artifacts live.
  test("successful writes surface as artifact hints for later turns", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "artifact-sess",
      toolName: "write_file",
      args: { path: "IMPLEMENTATION_PLAN.md" },
      result: { output: "wrote 22000 bytes", is_error: false },
      workspacePath: "C:\\Users\\ethan\\Downloads\\Perihelion",
    });

    const hints = memory.toSharedContextHints("artifact-sess", "C:\\Users\\ethan\\Downloads\\Perihelion");
    const artifactHint = (hints?.relevant_memories ?? []).find((m) => m.includes("IMPLEMENTATION_PLAN.md"));
    expect(artifactHint).toBeDefined();
    expect(artifactHint).toContain("written");
  });

  test("failed writes leave no artifact hint", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "artifact-fail-sess",
      toolName: "write_file",
      args: { path: "broken.md" },
      result: { output: "EACCES: permission denied", is_error: true },
      workspacePath: "/workspace",
    });

    const hints = memory.toSharedContextHints("artifact-fail-sess", "/workspace");
    expect((hints?.relevant_memories ?? []).find((m) => m.includes("broken.md"))).toBeUndefined();
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

  // ── 2026-07-18 live incident (session livefire-conductor): the executor's
  // verify read AFTER a successful edit_file served the PRE-EDIT cached
  // content, so the synthesizer truthfully-but-wrongly reported "changes did
  // not persist" about an edit that IS on disk. Cause: invalidateFile
  // compares a forward-slash-normalized path against displayKey/output built
  // from raw BACKSLASH args — includes() can never match on Windows paths.
  test("invalidates cached reads after an edit with Windows backslash paths", () => {
    const memory = new SessionMemory(() => makeConfig());
    const winPath = "C:\\Users\\ethan\\workspace\\math.js";
    memory.recordToolResult({
      sessionId: "sess-win",
      toolName: "read_file",
      args: { path: winPath },
      result: { output: "module.exports = { subtract };", is_error: false },
    });
    memory.recordToolResult({
      sessionId: "sess-win",
      toolName: "edit_file",
      args: { path: winPath, old_string: "subtract };", new_string: "subtract, add };" },
      result: { output: `Edited ${winPath}`, is_error: false },
    });

    expect(memory.lookupCachedToolResult("sess-win", "read_file", { path: winPath })).toBeUndefined();
  });

  test("invalidation is separator- and case-insensitive across mixed path styles", () => {
    const memory = new SessionMemory(() => makeConfig());
    memory.recordToolResult({
      sessionId: "sess-mixed",
      toolName: "read_file",
      args: { path: "C:/Users/Ethan/Workspace/Math.js" },
      result: { output: "old", is_error: false },
    });
    memory.recordToolResult({
      sessionId: "sess-mixed",
      toolName: "write_file",
      args: { path: "C:\\users\\ethan\\workspace\\math.js", content: "new" },
      result: { output: "written", is_error: false },
    });

    expect(
      memory.lookupCachedToolResult("sess-mixed", "read_file", { path: "C:/Users/Ethan/Workspace/Math.js" }),
    ).toBeUndefined();
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
      writer.beginTaskRun("disk-sess", {
        message: "comprehensively audit the repo",
        requirement: "workspace_read",
        depth: "deep",
        estimatedComplexity: "high",
      });

      const reader = new SessionMemory(() => cfg, tempRoot);
      expect(reader.getSessionState("disk-sess")).toBeUndefined();
      const cached = reader.lookupCachedToolResult("disk-sess", "grep", { pattern: "Coordinator" });
      expect(cached).toBe("3 matches");
      expect(reader.getTaskRun("disk-sess")?.depth).toBe("deep");
      expect(reader.getTaskRun("disk-sess")?.objective).toContain("comprehensively audit");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
