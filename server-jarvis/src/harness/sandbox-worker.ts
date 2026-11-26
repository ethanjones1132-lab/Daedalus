import { resolve } from "node:path";
import { receiveMessageOnPort } from "node:worker_threads";
import { EvalFlags, JSException, QuickJS, type JSValueHandle } from "quickjs-wasi";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import type { SandboxJob, SandboxMessage, ScriptResult } from "./sandbox";

declare const self: Worker;

const SCRIPT_NAME = "harness-script.js";
const transpiler = new Bun.Transpiler({ loader: "ts", define: { require: "undefined" } });

// The host function stays in a guest closure. Its only inputs and outputs are JSON strings.
const bindHarness = `(call => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const GuestError = Error;
  const endpoint = name => (...args) => {
    const result = parse(call(name, stringify(args)));
    if (!result.ok) throw new GuestError(result.error);
    return result.value;
  };
  Object.defineProperty(globalThis, "harness", { value: Object.freeze({
    list: endpoint("list"), describe: endpoint("describe"), state: endpoint("state"),
    attach: endpoint("attach"), switch: endpoint("switch"), spawn: endpoint("spawn"), request: endpoint("request"),
  }) });
  return stringify;
})`;

function send(message: SandboxMessage): void { self.postMessage(message); }

function prepareSource(vm: QuickJS, source: string): string {
  // Compile without evaluation first, so a top-level return can be wrapped without running any code twice.
  try { using compiled = vm.evalCode(source, SCRIPT_NAME, EvalFlags.STRICT | EvalFlags.COMPILE_ONLY); }
  catch (error) {
    if (!(error instanceof JSException) || error.name !== "SyntaxError" || error.message !== "return not in a function") throw error;
    error.dispose();
    source = `(function () {\n${source}\n})();`;
    using compiled = vm.evalCode(source, SCRIPT_NAME, EvalFlags.STRICT | EvalFlags.COMPILE_ONLY);
  }
  return source;
}

function evaluate(vm: QuickJS, code: string): JSValueHandle {
  let source: string;
  // Preserve JavaScript's completion value and globals. Bun's TypeScript transform may fold expressions.
  try { source = prepareSource(vm, code); }
  catch (error) {
    if (!(error instanceof JSException) || error.name !== "SyntaxError") throw error;
    error.dispose();
    source = prepareSource(vm, transpiler.transformSync(code));
  }
  return vm.evalCode(source, SCRIPT_NAME, EvalFlags.STRICT);
}

async function run({ code, cpuMs, memoryMb, memoryBytes, port, signal }: SandboxJob): Promise<ScriptResult> {
  let deadline = Infinity;
  const timeExceeded = () => performance.now() >= deadline;
  const cpuError = `Harness script exceeded the CPU time cap (${cpuMs} ms)`;
  try {
    using vm = await QuickJS.create({
      wasm: await Bun.file(resolve(import.meta.dir, wasmPath)).arrayBuffer(),
      memoryLimit: memoryBytes,
      interruptHandler: timeExceeded,
      timezoneOffset: 0,
      // WASI has no preopened files or module loader. Suppress its diagnostic output too.
      wasi: () => ({ fd_write: () => 8 }),
    });

    let reply: JSValueHandle | undefined;
    try {
      using bridge = vm.newFunction("harnessCall", (method, args) => {
        // QuickJS retains its own copy of the previous return value after the host call.
        reply?.dispose();
        reply = undefined;
        let response: unknown;
        if (method?.isString && args?.isString && !timeExceeded()) {
          Atomics.store(signal, 0, 0);
          send({ kind: "call", method: method.toString(), args: args.toString() });
          if (Atomics.wait(signal, 0, 0, Math.max(0, deadline - performance.now())) !== "timed-out") {
            response = receiveMessageOnPort(port)?.message;
          }
        }
        reply = vm.newString(typeof response === "string" ? response :
          JSON.stringify({ ok: false, error: timeExceeded() ? cpuError : "Harness API call failed" }));
        return reply;
      });
      using bind = vm.evalCode(bindHarness, "harness-bindings.js");
      using stringify = vm.callFunction(bind, vm.undefined, bridge);

      send({ kind: "started" });
      deadline = performance.now() + cpuMs;
      using result = evaluate(vm, code);
      if (result.isPromise) return { ok: false, error: "Harness scripts must return a synchronous value" };
      using json = vm.callFunction(stringify, vm.undefined, result);
      if (timeExceeded()) return { ok: false, error: cpuError };
      return json.isUndefined ? { ok: true } : { ok: true, value: JSON.parse(json.toString()) };
    } finally { reply?.dispose(); }
  } catch (error) {
    if (timeExceeded()) return { ok: false, error: cpuError };
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /out of memory|wasm_malloc failed/i.test(why) ?
      `Harness script exceeded the memory cap (${memoryMb} MB)` : why };
  }
}

self.onmessage = async ({ data }: MessageEvent<SandboxJob>) => {
  send({ kind: "result", result: await run(data) });
  data.port.close();
};
