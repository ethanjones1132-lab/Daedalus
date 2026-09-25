import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseConductorSessionState,
  parseSessionMemoryState,
  writeJsonAtomic,
} from "./session-runtime-persistence";

function legacyTaskRun(sessionId: string) {
  return {
    taskRunId: "task_legacy",
    sessionId,
    objective: "preserve the legacy TaskPlan",
    requirement: "full_execution",
    depth: "standard",
    estimatedComplexity: "medium",
    turnCount: 2,
    status: "active",
    evidenceCount: 0,
    remainingWork: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function sessionMemoryState(sessionId: string) {
  return {
    sessionId,
    lastActiveAt: 1_000,
    toolResults: {
      good: {
        key: "good",
        displayKey: "read_file:src/good.ts",
        toolName: "read_file",
        output: "ok",
        timestamp: 900,
        ttlMs: 5_000,
        isError: false,
      },
      bad: {
        key: "bad",
        displayKey: "read_file:src/bad.ts",
        toolName: "read_file",
        output: "bad",
        timestamp: Number.NaN,
        ttlMs: 5_000,
        isError: false,
      },
    },
    fileSnapshots: {
      "src/good.ts": {
        path: "src/good.ts",
        content: "ok",
        timestamp: 900,
      },
      "src/bad.ts": {
        path: "src/bad.ts",
        content: "bad",
        timestamp: Number.POSITIVE_INFINITY,
      },
    },
    discoveredFacts: {
      good: {
        key: "good",
        value: "known",
        source: "read_file",
        confidence: 1,
        timestamp: 900,
      },
      bad: {
        key: "bad",
        value: "unknown",
        source: "read_file",
        confidence: 2,
        timestamp: 900,
      },
    },
    failureHistory: [
      { pattern: "known failure", count: 2, lastSeen: 900, source: "read_file" },
      { pattern: "bad failure", count: 0, lastSeen: Number.NaN },
    ],
    taskRun: "invalid",
  };
}

describe("session runtime persistence", () => {
  test("rejects invalid top-level Session runtime envelopes", () => {
    for (const value of [null, [], "state", 7]) {
      expect(parseSessionMemoryState(value, "sess-1", 1_000).ok).toBe(false);
      expect(parseConductorSessionState(value, "sess-1", 1_000).ok).toBe(false);
    }

    expect(parseSessionMemoryState(
      { ...sessionMemoryState("wrong"), toolResults: [] },
      "sess-1",
      1_000,
    ).ok).toBe(false);
    expect(parseConductorSessionState({
      sessionId: "sess-1",
      turns: 1,
      messages: {},
      lastActiveAt: 1_000,
    }, "sess-1", 1_000).ok).toBe(false);
  });

  test("omits malformed Session-memory entries while retaining valid siblings", () => {
    const result = parseSessionMemoryState(sessionMemoryState("sess-1"), "sess-1", 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.state.toolResults)).toEqual(["good"]);
    expect(Object.keys(result.state.fileSnapshots)).toEqual(["src/good.ts"]);
    expect(Object.keys(result.state.discoveredFacts)).toEqual(["good"]);
    expect(result.state.failureHistory).toEqual([
      { pattern: "known failure", count: 2, lastSeen: 900, source: "read_file" },
    ]);
    expect(result.state.taskRun).toBeUndefined();
  });

  test("rejects non-finite counters and invalid TaskRun fields", () => {
    expect(parseSessionMemoryState({
      ...sessionMemoryState("sess-1"),
      lastActiveAt: Number.POSITIVE_INFINITY,
    }, "sess-1", 1_000).ok).toBe(false);

    const invalidTaskRuns = [
      "invalid",
      { ...legacyTaskRun("sess-1"), schemaVersion: 3 },
      { ...legacyTaskRun("sess-1"), sessionId: "other" },
      { ...legacyTaskRun("sess-1"), turnCount: Number.NaN },
      { ...legacyTaskRun("sess-1"), requirement: "unknown" },
      { ...legacyTaskRun("sess-1"), status: "unknown" },
    ];
    for (const taskRun of invalidTaskRuns) {
      const result = parseSessionMemoryState({
        ...sessionMemoryState("sess-1"),
        taskRun,
      }, "sess-1", 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.taskRun).toBeUndefined();
    }
  });

  test("retains valid legacy TaskPlan normalization", () => {
    const result = parseSessionMemoryState({
      sessionId: "sess-legacy",
      lastActiveAt: 1_000,
      toolResults: {},
      fileSnapshots: {},
      discoveredFacts: {},
      failureHistory: [],
      taskRun: legacyTaskRun("sess-legacy"),
    }, "sess-legacy", 2_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.taskRun?.schemaVersion).toBe(1);
    expect(result.state.taskRun?.reconstruction).toBe("reconstruction_required");
    expect(result.state.taskRun?.objective).toBe("preserve the legacy TaskPlan");
  });

  test("rejects malformed Conductor messages and non-finite optional state", () => {
    for (const message of [
      { role: "tool", content: "not a Conductor role" },
      { role: "assistant", content: null },
      "not a message",
    ]) {
      expect(parseConductorSessionState({
        sessionId: "sess-1",
        turns: 1,
        messages: [message],
        lastActiveAt: 1_000,
      }, "sess-1", 1_000).ok).toBe(false);
    }

    expect(parseConductorSessionState({
      sessionId: "sess-1",
      turns: 1,
      messages: [],
      lastActiveAt: 1_000,
      cachedPrefixTokens: Number.NaN,
    }, "sess-1", 1_000).ok).toBe(false);
  });

  test("keeps the prior complete state when replacement fails before rename", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-runtime-atomic-"));
    const path = join(root, "state.json");
    try {
      writeJsonAtomic(path, { version: 1, marker: "prior" });
      const prior = readFileSync(path, "utf-8");

      expect(() => writeJsonAtomic(path, { version: 2, marker: "secret" }, {
        beforeRename() {
          throw new Error("injected failure");
        },
      })).toThrow("injected failure");

      expect(readFileSync(path, "utf-8")).toBe(prior);
      expect(readdirSync(root)).toEqual(["state.json"]);

      writeJsonAtomic(path, { version: 2, marker: "healed" });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ version: 2, marker: "healed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
