import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { HarnessScriptApi } from "./script-api";

const DEFAULT_CPU_MS = 2_000;
const DEFAULT_MEMORY_MB = 64;
const BYTES_PER_MB = 1024 * 1024;
const WORKER_STARTUP_MS = 10_000;
const INTERRUPT_SETTLE_MS = 25;

export type ScriptResult = { ok: boolean; value?: unknown; error?: string };
export type SandboxJob = { code: string; cpuMs: number; memoryMb: number; memoryBytes: number; port: MessagePort; signal: Int32Array };
export type SandboxMessage = { kind: "started" } | { kind: "call"; method: string; args: string } |
  { kind: "result"; result: ScriptResult };

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function callApi(api: HarnessScriptApi, method: string, args: unknown[]): unknown {
  switch (method) {
    case "list": return api.list();
    case "describe": return api.describe(requireString(args[0], "harness id"));
    case "state": return api.state();
    case "attach":
    case "switch": return api[method](requireString(args[0], "harness id"), args[1], requireString(args[2], "reason"));
    case "spawn": return api.spawn(args[0] as Parameters<HarnessScriptApi["spawn"]>[0]);
    case "request": return api.request(args[0] as Parameters<HarnessScriptApi["request"]>[0]);
    default: throw new Error("Unknown harness API method");
  }
}

function answerCall(api: HarnessScriptApi, request: Extract<SandboxMessage, { kind: "call" }>, deadline: number): string {
  try {
    if (performance.now() >= deadline) throw new Error("Harness script CPU time cap expired");
    const args: unknown = JSON.parse(request.args);
    if (!Array.isArray(args)) throw new Error("Harness API arguments must be an array");
    return JSON.stringify({ ok: true, value: callApi(api, request.method, args) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function runScript(
  code: string,
  api: HarnessScriptApi,
  caps?: { cpu_ms?: number; mem_mb?: number },
): Promise<ScriptResult> {
  const cpuMs = caps?.cpu_ms ?? DEFAULT_CPU_MS;
  const memoryMb = caps?.mem_mb ?? DEFAULT_MEMORY_MB;
  const memoryBytes = Math.floor(memoryMb * BYTES_PER_MB);
  if (!Number.isFinite(cpuMs) || cpuMs <= 0 || cpuMs > 2_147_483_647 - INTERRUPT_SETTLE_MS) {
    return { ok: false, error: "CPU cap must be positive and fit the watchdog timer" };
  }
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || memoryBytes > 0xffff_ffff) {
    return { ok: false, error: "Memory cap must fit the QuickJS WASM byte limit" };
  }

  // Native WASM operations can stall without a QuickJS interrupt. A separate worker keeps the run responsive.
  let worker: Worker;
  try { worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), { env: {}, smol: true }); }
  catch { return { ok: false, error: "Harness sandbox worker could not start" }; }
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));

  return new Promise((resolve) => {
    let deadline = Infinity;
    let stopped = false;
    const finish = (result: ScriptResult) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      port1.close();
      worker.terminate();
      resolve(result);
    };
    let timer = setTimeout(() => finish({ ok: false, error: "Harness sandbox worker startup timed out" }), WORKER_STARTUP_MS);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ ok: false, error: "Harness sandbox worker failed" });
    };
    worker.onmessage = ({ data }: MessageEvent<SandboxMessage>) => {
      if (stopped) return;
      switch (data.kind) {
        case "started":
          deadline = performance.now() + cpuMs;
          clearTimeout(timer);
          timer = setTimeout(() => finish({ ok: false,
            error: `Harness script hit the CPU time cap (${cpuMs} ms) or stalled at the memory cap (${memoryMb} MB)`,
          }), cpuMs + INTERRUPT_SETTLE_MS);
          break;
        case "call":
          port1.postMessage(answerCall(api, data, deadline));
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
          break;
        case "result": finish(data.result); break;
      }
    };
    const job: SandboxJob = { code, cpuMs, memoryMb, memoryBytes, port: port2, signal };
    try { worker.postMessage(job, [port2]); }
    catch {
      port2.close();
      finish({ ok: false, error: "Harness sandbox worker could not receive the script" });
    }
  });
}
