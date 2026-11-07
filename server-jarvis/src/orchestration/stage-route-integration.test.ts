import { describe, expect, test } from "bun:test";
import { defaultConfig, normalizeConfig } from "../config";
import { RoutePlan } from "./route-plan";
import { resolveStageRoute, runStageRoute, type StageTarget } from "./stage-route-policy";
import { requestStageTarget } from "./stage-target-request";

const target = (provider: StageTarget["provider"], model: string): StageTarget => ({ provider, model });

function localConfig() {
  const cfg = defaultConfig();
  cfg.active_backend = "llama_cpp";
  cfg.orchestrator.allow_cloud_helpers = false;
  return cfg;
}

describe("production stage route runner", () => {
  test("tries candidates in order, returns the first usable answer, and skips the rest", async () => {
    const a = target("ollama", "model-a");
    const b = target("ollama", "model-b");
    const c = target("ollama", "model-c");
    const calls: StageTarget[] = [];
    const plan = new RoutePlan();

    const answer = await runStageRoute([a, b, c], {
      cfg: localConfig(),
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      onRejected: () => {},
    }, async (candidate: StageTarget) => {
      calls.push(candidate);
      plan.add({
        stage: "executor",
        provider: candidate.provider,
        model: candidate.model,
        choice: calls.length === 1 ? "configured" : "fallback",
        outcome: calls.length === 1 ? "http_error" : "success",
        duration_ms: 1,
      });
      return calls.length === 1
        ? { usable: false, reason: "model-a failed" }
        : { usable: true, value: "answer from B" };
    });

    expect(answer).toBe("answer from B");
    expect(calls).toEqual([a, b]);
    expect(plan.summary().answered_by?.model).toBe("model-b");
  });

  test("an explicit empty fallback list makes one request and does not build another tail", async () => {
    const a = target("ollama", "model-a");
    const cfg = normalizeConfig({
      orchestrator: {
        stage_models: { executor: a },
        fallback_chains: { executor: [] },
      },
    });
    const candidates = resolveStageRoute(cfg, "executor", {
      fallbacks: [target("ollama", "automatic-pool"), target("openrouter", "paid-tail")],
    }, new Set());
    let inferenceCalls = 0;
    let poolSelections = 0;
    let catalogRequests = 0;
    let paidTailCalls = 0;

    await expect(runStageRoute(candidates, {
      cfg,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      onRejected: () => {},
    }, async () => {
      inferenceCalls += 1;
      return { usable: false, reason: "primary failed" };
    })).rejects.toThrow("primary failed");

    expect(inferenceCalls).toBe(1);
    expect(poolSelections).toBe(0);
    expect(catalogRequests).toBe(0);
    expect(paidTailCalls).toBe(0);
  });

  test("rejects blocked cloud targets before inference and keeps local answers local", async () => {
    const cloud = target("openrouter", "cloud-model");
    const local = target("ollama", "local-model");
    const rejected: Array<{ target: StageTarget; reason: string }> = [];
    const calls: StageTarget[] = [];
    const plan = new RoutePlan();

    await runStageRoute([cloud, local], {
      cfg: localConfig(),
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      onRejected: (rejectedTarget: StageTarget, reason: string) => {
        rejected.push({ target: rejectedTarget, reason });
        plan.reject(rejectedTarget, reason, "executor");
      },
    }, async (candidate: StageTarget) => {
      calls.push(candidate);
      plan.add({ stage: "executor", provider: candidate.provider, model: candidate.model, choice: "fallback", outcome: "success", duration_ms: 1 });
      return { usable: true, value: "local answer" };
    });

    expect(rejected).toEqual([{ target: cloud, reason: "cloud_helpers_disabled" }]);
    expect(calls).toEqual([local]);
    expect(plan.summary().left_machine).toBe(false);
    expect(plan.summary().preflight_rejections).toEqual([{
      stage: "executor", provider: "openrouter", model: "cloud-model", reason: "cloud_helpers_disabled",
    }]);
    expect(plan.attempts.map((attempt) => attempt.model)).toEqual(["local-model"]);
  });

  test("fails an exhausted chain with the last candidate reason", async () => {
    const calls: StageTarget[] = [];

    await expect(runStageRoute([target("ollama", "A"), target("ollama", "B")], {
      cfg: localConfig(),
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      onRejected: () => {},
    }, async (candidate: StageTarget) => {
      calls.push(candidate);
      return { usable: false, reason: `${candidate.model} failed` };
    })).rejects.toThrow("B failed");

    expect(calls.map((candidate) => candidate.model)).toEqual(["A", "B"]);
  });

  test("does not advance after caller or stage cancellation", async () => {
    for (const abortSource of ["caller", "stage"] as const) {
      const caller = new AbortController();
      const stage = new AbortController();
      const signal = AbortSignal.any([caller.signal, stage.signal]);
      const calls: string[] = [];

      await expect(runStageRoute([target("ollama", "A"), target("ollama", "B")], {
        cfg: localConfig(),
        signal,
        deadline: Date.now() + 5_000,
        onRejected: () => {},
      }, async (candidate: StageTarget) => {
        calls.push(candidate.model);
        (abortSource === "caller" ? caller : stage).abort("cancelled");
        return { usable: false, reason: "cancelled" };
      })).rejects.toThrow();

      expect(calls).toEqual(["A"]);
    }
  });

  test("stops before inference when the shared deadline is exhausted", async () => {
    let calls = 0;

    await expect(runStageRoute([target("ollama", "A")], {
      cfg: localConfig(),
      signal: new AbortController().signal,
      deadline: Date.now() - 1,
      onRejected: () => {},
    }, async () => {
      calls += 1;
      return { usable: true, value: "too late" };
    })).rejects.toThrow();

    expect(calls).toBe(0);
  });
});

describe("single stage target transport", () => {
  test("dispatches the exact structured model to Ollama and returns its streaming response", async () => {
    let receivedUrl = "";
    let receivedModel = "";
    let receivedAuthorization = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        receivedUrl = new URL(request.url).pathname;
        receivedModel = String((await request.json() as { model?: unknown }).model ?? "");
        receivedAuthorization = request.headers.get("authorization") ?? "";
        return new Response("data: {\"choices\":[]}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const cfg = localConfig();
    cfg.ollama.base_url = `http://127.0.0.1:${server.port}`;
    const model = "org/model:tag";

    try {
      const response = await requestStageTarget(cfg, target("ollama", model), { model: "ignored", stream: true }, new AbortController().signal);

      expect(response.status).toBe(200);
      expect(receivedUrl).toBe("/v1/chat/completions");
      expect(receivedModel).toBe(model);
      expect(receivedAuthorization).toBe("Bearer ollama");
      expect(await response.text()).toContain("data:");
    } finally {
      server.stop(true);
    }
  });

  test("adapts an explicit Anthropic-native OpenCode Go target at its exact endpoint", async () => {
    let receivedPath = "";
    let receivedModel = "";
    let receivedApiKey = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        receivedPath = new URL(request.url).pathname;
        receivedModel = String((await request.json() as { model?: unknown }).model ?? "");
        receivedApiKey = request.headers.get("x-api-key") ?? "";
        return new Response([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_1","model":"minimax-m3"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"explicit route answer"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const cfg = defaultConfig();
    cfg.opencode_go.base_url = `http://127.0.0.1:${server.port}`;
    cfg.opencode_go.api_key = "test-go-key";
    try {
      const response = await requestStageTarget(
        cfg,
        target("opencode_go", "minimax-m3"),
        { model: "wrong-model", messages: [{ role: "user", content: "say hello" }], stream: true, max_tokens: 64 },
        new AbortController().signal,
      );
      const stream = await response.text();
      expect(receivedPath).toBe("/messages");
      expect(receivedModel).toBe("minimax-m3");
      expect(receivedApiKey).toBe("test-go-key");
      expect(stream).toContain('"content":"explicit route answer"');
    } finally {
      server.stop(true);
    }
  });
});
