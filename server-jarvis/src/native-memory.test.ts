import { describe, expect, test } from "bun:test";
import { createNativeMemoryRegistry, handleNativeMemoryRequest } from "./native-memory";
import type { RouteDiagnosticService } from "./orchestration/route-diagnostics";

function fakeDiagnostics(calls: { test: number; cancel: string[] }): RouteDiagnosticService {
  return {
    async run(input) {
      calls.test += 1;
      const value = input as { operation_id: string; stage: string };
      return {
        operation_id: value.operation_id,
        stage: value.stage,
        status: "failed",
        attempts: [],
        rejected_candidates: [],
        left_machine: false,
        duration_ms: 0,
      };
    },
    cancel(operationId) {
      calls.cancel.push(String(operationId));
      return { operation_id: String(operationId), cancelled: false };
    },
  };
}

function request(path: string, body = "{}", authorization?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
  });
}

describe("Native-authorized orchestration diagnostics routes", () => {
  test("missing capability and invalid bearer make zero probe calls", async () => {
    const calls = { test: 0, cancel: [] as string[] };
    const service = fakeDiagnostics(calls);
    const unconfigured = createNativeMemoryRegistry(null);
    const unavailable = await handleNativeMemoryRequest(
      request("/internal/orchestration/test"), unconfigured, undefined, null, service,
    );
    const configured = createNativeMemoryRegistry({ capability: "owned-secret", appInstanceId: "app-1" });
    const denied = await handleNativeMemoryRequest(
      request("/internal/orchestration/test", '{"operation_id":"x","stage":"executor"}', "Bearer wrong"),
      configured, undefined, null, service,
    );

    expect(unavailable?.status).toBe(503);
    expect(denied?.status).toBe(401);
    expect(calls).toEqual({ test: 0, cancel: [] });
  });

  test("rejects request bodies above 256 KiB before invoking the probe", async () => {
    const calls = { test: 0, cancel: [] as string[] };
    const registry = createNativeMemoryRegistry({ capability: "owned-secret", appInstanceId: "app-1" });
    const response = await handleNativeMemoryRequest(
      request("/internal/orchestration/test", `{"padding":"${"x".repeat(256 * 1024)}"}`, "Bearer owned-secret"),
      registry, undefined, null, fakeDiagnostics(calls),
    );

    expect(response?.status).toBe(413);
    expect(await response?.json()).toMatchObject({ code: "body_too_large" });
    expect(calls.test).toBe(0);
  });

  test("passes authenticated test and operation-scoped cancel to the service", async () => {
    const calls = { test: 0, cancel: [] as string[] };
    const registry = createNativeMemoryRegistry({ capability: "owned-secret", appInstanceId: "app-1" });
    const service = fakeDiagnostics(calls);
    const tested = await handleNativeMemoryRequest(
      request("/internal/orchestration/test", '{"operation_id":"op-1","stage":"executor","config":{}}', "Bearer owned-secret"),
      registry, undefined, null, service,
    );
    const cancelled = await handleNativeMemoryRequest(
      request("/internal/orchestration/test/cancel", '{"operation_id":"op-1"}', "Bearer owned-secret"),
      registry, undefined, null, service,
    );

    expect(tested?.status).toBe(200);
    expect(await tested?.json()).toMatchObject({ operation_id: "op-1", stage: "executor" });
    expect(cancelled?.status).toBe(200);
    expect(calls).toEqual({ test: 1, cancel: ["op-1"] });
  });

  test("authenticated reload returns only Bun identity and routing fingerprint", async () => {
    let reloads = 0;
    const registry = createNativeMemoryRegistry({ capability: "owned-secret", appInstanceId: "app-1" });
    const response = await handleNativeMemoryRequest(
      request("/internal/orchestration/reload", "{}", "Bearer owned-secret"),
      registry,
      undefined,
      null,
      fakeDiagnostics({ test: 0, cancel: [] }),
      () => {
        reloads += 1;
        return { routing_fingerprint: "a".repeat(64) };
      },
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      bun_instance_id: expect.any(String),
      routing_fingerprint: "a".repeat(64),
    });
    expect(reloads).toBe(1);
  });

  test("unauthorized reload never reads runtime configuration", async () => {
    let reloads = 0;
    const registry = createNativeMemoryRegistry({ capability: "owned-secret", appInstanceId: "app-1" });
    const response = await handleNativeMemoryRequest(
      request("/internal/orchestration/reload", "{}", "Bearer wrong"),
      registry,
      undefined,
      null,
      fakeDiagnostics({ test: 0, cancel: [] }),
      () => {
        reloads += 1;
        return { routing_fingerprint: "a".repeat(64) };
      },
    );

    expect(response?.status).toBe(401);
    expect(reloads).toBe(0);
  });
});
