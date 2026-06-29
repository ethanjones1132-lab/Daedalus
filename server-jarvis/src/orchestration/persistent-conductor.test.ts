import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  PersistentConductor,
  __resetPersistentConductorCachesForTests,
} from "./persistent-conductor";
import { conductorCacheSnapshot, __resetConductorCacheMetricsForTests } from "./conductor-metrics";
import type { JarvisConfig } from "../config";
import { defaultConfig } from "../config";
import { __resetOllamaHealthCacheForTests } from "../ollama";

const originalFetch = globalThis.fetch;

function makeConfig(overrides: Partial<JarvisConfig["orchestrator"]["conductor"]> = {}): JarvisConfig {
  const cfg = defaultConfig();
  cfg.orchestrator.conductor = {
    ...cfg.orchestrator.conductor,
    ...overrides,
  };
  return cfg;
}

function mockOllamaChat(responses: string[]) {
  let call = 0;
  (globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return Response.json({
        models: [{ name: "gemma4:e2b" }],
      });
    }
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = responses[call] ?? responses[responses.length - 1];
      call += 1;
      return Response.json({
        message: { role: "assistant", content },
        done: true,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPersistentConductorCachesForTests();
  __resetOllamaHealthCacheForTests();
  __resetConductorCacheMetricsForTests();
});

describe("PersistentConductor", () => {
  test("accumulates session messages across turns for KV prefix reuse", async () => {
    const chatBodies: unknown[] = [];
    (globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "gemma4:e2b" }] });
      }
      if (url.endsWith("/api/chat")) {
        chatBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({
          message: {
            role: "assistant",
            content: JSON.stringify({
              task_type: "general",
              pipeline: ["synthesizer"],
              topology: "linear",
              context: {
                needs_workspace_inspection: false,
                needs_memory: true,
                estimated_complexity: "low",
              },
              coordinator_rationale: "ok",
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg = makeConfig({ persist_sessions: false });
    const conductor = new PersistentConductor(() => cfg);

    await conductor.routeTurn({
      sessionId: "sess-a",
      request: "first request",
      turnNumber: 1,
    });
    await conductor.routeTurn({
      sessionId: "sess-a",
      request: "second request",
      turnNumber: 2,
      lastOutcome: "success",
    });

    expect(chatBodies).toHaveLength(2);
    const first = chatBodies[0] as { messages: Array<{ role: string }> };
    const second = chatBodies[1] as { messages: Array<{ role: string }> };
    expect(first.messages).toHaveLength(2);
    expect(second.messages.length).toBeGreaterThan(2);
    expect(second.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  test("reports cache hit metrics on turn 2+ (Track A)", async () => {
    mockOllamaChat([
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t1"}',
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t2"}',
    ]);

    const cfg = makeConfig({ persist_sessions: false });
    const conductor = new PersistentConductor(() => cfg);

    const first = await conductor.routeTurn({
      sessionId: "cache-sess",
      request: "first",
      turnNumber: 1,
    });
    const second = await conductor.routeTurn({
      sessionId: "cache-sess",
      request: "second",
      turnNumber: 2,
      lastOutcome: "success",
    });

    expect(first.cacheHit).toBe(false);
    expect(first.kvGeneration).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.kvGeneration).toBe(2);
    expect(second.prefixTokensEstimated).toBeGreaterThan(0);

    const snapshot = conductorCacheSnapshot();
    expect(snapshot.window_size).toBe(2);
    expect(snapshot.cache_hit_rate).toBe(0.5);
  });

  test("markApiFallback clears cache-hit eligibility on next turn", async () => {
    mockOllamaChat([
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t1"}',
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t2"}',
    ]);

    const cfg = makeConfig({ persist_sessions: false });
    const conductor = new PersistentConductor(() => cfg);

    await conductor.routeTurn({
      sessionId: "fallback-sess",
      request: "first",
      turnNumber: 1,
    });
    conductor.markApiFallback("fallback-sess");
    const afterFallback = await conductor.routeTurn({
      sessionId: "fallback-sess",
      request: "after api fallback",
      turnNumber: 2,
    });

    expect(afterFallback.cacheHit).toBe(false);
    expect(conductor.getSessionState("fallback-sess")?.apiFallbackUsed).toBe(false);
  });

  test("prefers fallback_model when primary conductor model is not installed", async () => {
    (globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return Response.json({ models: [{ name: "gemma4:e4b" }] });
      }
      if (url.includes("/api/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.model).toBe("gemma4:e4b");
        return Response.json({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "route_pipeline",
                arguments: {
                  task_type: "general",
                  pipeline: ["synthesizer"],
                  topology: "linear",
                  context: {
                    needs_workspace_inspection: false,
                    needs_memory: true,
                    estimated_complexity: "low",
                  },
                  coordinator_rationale: "fallback tier",
                },
              },
            }],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg = makeConfig({ persist_sessions: false });
    const conductor = new PersistentConductor(() => cfg);
    const result = await conductor.routeTurn({
      sessionId: "fallback-model",
      request: "quick question",
      turnNumber: 1,
    });

    expect(result.model).toBe("gemma4:e4b");
    expect(JSON.parse(result.content).pipeline).toEqual(["synthesizer"]);
  });

  test("falls back availability check when model is missing", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return Response.json({ models: [{ name: "other-model:latest" }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg = makeConfig();
    const conductor = new PersistentConductor(() => cfg);
    expect(await conductor.isAvailable()).toBe(false);
  });

  test("prunes old turn pairs when max_turns_in_cache is exceeded", async () => {
    mockOllamaChat([
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t1"}',
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t2"}',
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"t3"}',
    ]);

    const cfg = makeConfig({ persist_sessions: false, max_turns_in_cache: 1 });
    const conductor = new PersistentConductor(() => cfg);

    for (let i = 1; i <= 3; i++) {
      await conductor.routeTurn({
        sessionId: "prune-sess",
        request: `request ${i}`,
        turnNumber: i,
      });
    }

    const state = conductor.getSessionState("prune-sess");
    expect(state).toBeDefined();
    const nonSystem = state!.messages.filter((m) => m.role !== "system");
    expect(nonSystem).toHaveLength(2);
  });

  test("persists and reloads session state from disk", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-conductor-"));

    mockOllamaChat([
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"persisted"}',
      '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"follow-up"}',
    ]);

    try {
      const cfg = makeConfig({ persist_sessions: true });
      const conductorA = new PersistentConductor(() => cfg, tempRoot);
      await conductorA.routeTurn({
        sessionId: "disk-sess",
        request: "persist me",
        turnNumber: 1,
      });

      const conductorB = new PersistentConductor(() => cfg, tempRoot);
      expect(conductorB.getSessionState("disk-sess")).toBeUndefined();

      await conductorB.routeTurn({
        sessionId: "disk-sess",
        request: "follow-up",
        turnNumber: 2,
      });

      const loaded = conductorB.getSessionState("disk-sess");
      expect(loaded?.messages.length).toBeGreaterThan(2);
      expect(loaded?.messages.some((m) => m.content.includes("persist me"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});