import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createRouteDiagnosticService, ROUTE_DIAGNOSTIC_TIMEOUT_MS, type RouteDiagnosticInput } from "./route-diagnostics";
import type { StageTarget } from "./stage-route-policy";

const target = (provider: StageTarget["provider"], model: string): StageTarget => ({ provider, model });

function explicitInput(overrides: Partial<RouteDiagnosticInput> = {}): RouteDiagnosticInput {
  const config = defaultConfig();
  config.active_backend = "llama_cpp";
  config.orchestrator.allow_cloud_helpers = false;
  config.orchestrator.stage_models = { executor: target("ollama", "probe-a") };
  config.orchestrator.fallback_chains = { executor: [] };
  return {
    operation_id: "probe-1",
    stage: "executor",
    config,
    ...overrides,
  };
}

describe("bounded orchestration route diagnostics", () => {
  test("uses the fixed prompt, no tools, temperature zero, and a 64-token cap", async () => {
    let request: { target: StageTarget; body: Record<string, unknown> } | undefined;
    const service = createRouteDiagnosticService({
      requestTarget: async (_cfg, picked, body) => {
        request = { target: picked, body };
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });

    const result = await service.run(explicitInput());

    expect(result.status).toBe("success");
    expect(request?.target).toEqual(target("ollama", "probe-a"));
    expect(request?.body).toMatchObject({
      model: "probe-a",
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      stream: true,
      temperature: 0,
      max_tokens: 64,
    });
    expect(request?.body).not.toHaveProperty("tools");
  });

  test("tries explicit candidates in order and returns only actual attempts", async () => {
    const input = explicitInput();
    input.config.orchestrator.fallback_chains!.executor = [target("ollama", "probe-b"), target("ollama", "probe-c")];
    const calls: string[] = [];
    const service = createRouteDiagnosticService({
      requestTarget: async (_cfg, picked) => {
        calls.push(picked.model);
        return picked.model === "probe-a"
          ? new Response("provider refused", { status: 503 })
          : new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });

    const result = await service.run(input);

    expect(calls).toEqual(["probe-a", "probe-b"]);
    expect(result.attempts.map((attempt) => [attempt.model, attempt.outcome])).toEqual([
      ["probe-a", "http_error"], ["probe-b", "success"],
    ]);
    expect(result.answered_by).toMatchObject({ provider: "ollama", model: "probe-b", cloud: false });
    expect(result.left_machine).toBe(false);
  });

  test("explicit primary with an empty fallback list never asks the Automatic selector", async () => {
    let automaticSelections = 0;
    const service = createRouteDiagnosticService({
      automaticRoute: () => {
        automaticSelections += 1;
        return { primary: target("ollama", "unconfigured-pool"), fallbacks: [target("openrouter", "paid-tail")] };
      },
      requestTarget: async () => new Response("no", { status: 503 }),
    });

    const result = await service.run(explicitInput());

    expect(result.status).toBe("failed");
    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["probe-a"]);
    expect(automaticSelections).toBe(0);
  });

  test("rejects invalid stage and route config before dispatch", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async () => { dispatches += 1; return new Response("unused"); },
    });
    const invalidStage = await service.run(explicitInput({ stage: "agent_loop" as RouteDiagnosticInput["stage"] }));
    const invalidConfig = explicitInput();
    invalidConfig.config.orchestrator.stage_models = { executor: { provider: "openrouter", model: "" } } as never;
    const invalidRoute = await service.run(invalidConfig);

    expect(invalidStage).toMatchObject({ status: "failed", reason_code: "invalid_stage" });
    expect(invalidRoute).toMatchObject({ status: "failed", reason_code: "invalid_route_config" });
    expect(dispatches).toBe(0);
  });

  test("a concurrent distinct operation receives busy without dispatch", async () => {
    let release!: () => void;
    let dispatches = 0;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = createRouteDiagnosticService({
      requestTarget: async () => {
        dispatches += 1;
        await blocked;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    const first = service.run(explicitInput());
    await Promise.resolve();
    const second = await service.run(explicitInput({ operation_id: "probe-2" }));
    release();
    const settled = await first;

    expect(second).toMatchObject({ status: "failed", reason_code: "busy", attempts: [] });
    expect(settled.status).toBe("success");
    expect(dispatches).toBe(1);
  });

  test("a duplicate active operation ID is rejected", async () => {
    let release!: () => void;
    let dispatches = 0;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = createRouteDiagnosticService({
      requestTarget: async () => {
        dispatches += 1;
        await blocked;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    const first = service.run(explicitInput());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicate = await service.run(explicitInput());
    release();
    await first;

    expect(duplicate).toMatchObject({ status: "failed", reason_code: "duplicate_operation", attempts: [] });
    expect(dispatches).toBe(1);
  });

  test("a valid cancellation that arrives before run suppresses that operation without dispatch", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async () => {
        dispatches += 1;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });

    expect(service.cancel("probe-before-run")).toEqual({
      operation_id: "probe-before-run",
      cancelled: true,
    });
    const result = await service.run(explicitInput({ operation_id: "probe-before-run" }));
    const replay = await service.run(explicitInput({ operation_id: "probe-before-run" }));

    expect(result).toMatchObject({ status: "cancelled", reason_code: "cancelled", attempts: [] });
    expect(replay).toMatchObject({ status: "cancelled", reason_code: "cancelled", attempts: [] });
    expect(dispatches).toBe(0);
  });

  test("invalid cancellation IDs do not consume bounded pre-cancel capacity", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async () => {
        dispatches += 1;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    for (let index = 0; index < 256; index += 1) {
      service.cancel(`queued-${index}`);
    }

    expect(service.cancel("bad / id").cancelled).toBe(false);
    const result = await service.run(explicitInput({ operation_id: "queued-0" }));

    expect(result.status).toBe("cancelled");
    expect(dispatches).toBe(0);
  });

  test("pre-cancel markers expire within the bounded diagnostic window", async () => {
    let currentTime = 10_000;
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      now: () => currentTime,
      requestTarget: async () => {
        dispatches += 1;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    service.cancel("probe-expiring");
    currentTime += ROUTE_DIAGNOSTIC_TIMEOUT_MS;

    const result = await service.run(explicitInput({ operation_id: "probe-expiring" }));

    expect(result.status).toBe("success");
    expect(dispatches).toBe(1);
  });

  test("pre-cancel storage is bounded and evicts the oldest operation", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async () => {
        dispatches += 1;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    for (let index = 0; index < 257; index += 1) {
      service.cancel(`bounded-${index}`);
    }

    const oldest = await service.run(explicitInput({ operation_id: "bounded-0" }));
    const newest = await service.run(explicitInput({ operation_id: "bounded-256" }));

    expect(oldest.status).toBe("success");
    expect(newest.status).toBe("cancelled");
    expect(dispatches).toBe(1);
  });

  test("cancelling a future operation does not abort the different active probe", async () => {
    let release!: () => void;
    let dispatches = 0;
    let activeSignal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = createRouteDiagnosticService({
      requestTarget: async (_cfg, _target, _body, signal) => {
        dispatches += 1;
        activeSignal = signal;
        await blocked;
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });
    const active = service.run(explicitInput({ operation_id: "active-probe" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.cancel("future-probe").cancelled).toBe(true);
    expect(activeSignal?.aborted).toBe(false);
    release();
    expect((await active).status).toBe("success");
    expect((await service.run(explicitInput({ operation_id: "future-probe" }))).status).toBe("cancelled");
    expect(dispatches).toBe(1);
  });

  test("cancels only the matching active operation and cleans up after settlement", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async (_cfg, _target, _body, signal) => {
        dispatches += 1;
        if (dispatches > 1) return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      },
    });
    const first = service.run(explicitInput());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.cancel("other-operation").cancelled).toBe(true);
    expect(service.cancel("probe-1").cancelled).toBe(true);
    expect(await first).toMatchObject({ status: "cancelled", reason_code: "cancelled" });

    const after = await service.run(explicitInput({
      operation_id: "probe-3",
      config: (() => {
        const config = defaultConfig();
        config.active_backend = "llama_cpp";
        config.orchestrator.stage_models = { executor: target("ollama", "probe-a") };
        config.orchestrator.fallback_chains = { executor: [] };
        return config;
      })(),
    }));
    expect(after.status).toBe("success");
    expect(dispatches).toBe(2);
  });

  test("cancellation before inference settles without dispatch", async () => {
    let release!: () => void;
    let dispatches = 0;
    const waitForAutomatic = new Promise<void>((resolve) => { release = resolve; });
    const service = createRouteDiagnosticService({
      automaticRoute: async () => {
        await waitForAutomatic;
        return { primary: target("ollama", "auto"), fallbacks: [] };
      },
      requestTarget: async () => { dispatches += 1; return new Response("unused"); },
    });
    const config = defaultConfig();
    config.active_backend = "ollama";
    config.orchestrator.stage_models = { executor: "automatic" };
    config.orchestrator.fallback_chains = { executor: "automatic" };
    const running = service.run(explicitInput({ config }));
    await Promise.resolve();
    service.cancel("probe-1");
    release();

    expect(await running).toMatchObject({ status: "cancelled", attempts: [] });
    expect(dispatches).toBe(0);
  });

  test("the shared deadline aborts the chain and reports timeout", async () => {
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      timeoutMs: 10,
      requestTarget: async (_cfg, _target, _body, signal) => new Promise<Response>((_resolve, reject) => {
        dispatches += 1;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });

    const result = await service.run(explicitInput());

    expect(result.status).toBe("timeout");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("timeout");
    expect(dispatches).toBe(1);
  });

  test("local-only Automatic uses configured metadata without catalog discovery", async () => {
    const config = defaultConfig();
    config.active_backend = "ollama";
    config.orchestrator.allow_cloud_helpers = false;
    config.orchestrator.stage_models = { executor: "automatic" };
    config.orchestrator.fallback_chains = { executor: "automatic" };
    config.orchestrator.agents = [{
      id: "local-agent",
      provider: "ollama",
      model_id: "configured-local",
      capabilities: { code: 0.5, reasoning: 0.5, speed: 0.5, cost: 0.5, json_reliability: 0.5 },
      default_for: ["executor"],
      enabled: true,
    }];
    const calls: string[] = [];
    const service = createRouteDiagnosticService({
      requestTarget: async (_cfg, picked) => {
        calls.push(picked.model);
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      },
    });

    const result = await service.run(explicitInput({ config }));

    expect(calls).toEqual(["configured-local"]);
    expect(result.status).toBe("success");
    expect(result.left_machine).toBe(false);
  });

  test("cloud rejection stays outside dispatched attempts and never returns credentials", async () => {
    const config = defaultConfig();
    config.active_backend = "llama_cpp";
    config.orchestrator.allow_cloud_helpers = false;
    config.openrouter.api_key = "super-secret-probe-key";
    config.orchestrator.stage_models = { executor: target("openrouter", "cloud-model") };
    config.orchestrator.fallback_chains = { executor: [] };
    let dispatches = 0;
    const service = createRouteDiagnosticService({
      requestTarget: async () => { dispatches += 1; return new Response("unused"); },
    });

    const result = await service.run(explicitInput({ config }));

    expect(result).toMatchObject({
      status: "failed",
      left_machine: false,
      attempts: [],
      rejected_candidates: [{ provider: "openrouter", model: "cloud-model", reason: "cloud_helpers_disabled" }],
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-probe-key");
    expect(dispatches).toBe(0);
  });
});
