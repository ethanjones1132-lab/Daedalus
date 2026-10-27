// DD-035 / DS-30 + DS-31 regression suite.
//
// Every behavioural case runs in an owned `process.execPath -e` child with a
// stripped environment: no inference backend, no user configuration, no server
// entrypoint boot. Each child is bounded by a wall-clock kill so a reverted
// guard fails as a regression instead of hanging the gate.
//
// Reverting the guards fails these cases specifically:
// - no listener in the entrypoint → the survival children exit 1 before their
//   delayed alive marker (that is exactly the DS-30 reproduction);
// - a bare `serve()` in the entrypoint → the wiring case no longer finds the
//   guarded bind, and without the helper's EADDRINUSE branch the taken-port
//   child dies with Bun's raw throw instead of the named diagnostic;
// - loose message matching → the EACCES child is misclassified and loses its
//   original error identity.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ADDRESS_IN_USE_HINT,
  MAX_REJECTION_REASON_CHARS,
  errorCodeOf,
  formatAddressInUseMessage,
  formatUnhandledRejectionLine,
  guardServerBind,
  installRejectionGuard,
  isAddressInUseError,
  resolveBindTarget,
  sanitizeOneLine,
  type RejectionHost,
} from "./server-guards";

const GUARD_MODULE = join(import.meta.dir, "server-guards.ts");
const CHILD_TIMEOUT_MS = 20_000;

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a bounded, owned Bun child. `PATH` is empty and HOME/USERPROFILE are
 * absent, so the child cannot pick up user configuration even by accident;
 * `process.execPath` is absolute, so nothing needs PATH to resolve it.
 */
async function runBunChild(script: string): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" },
  });
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, CHILD_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    settled = true;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (!settled) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

const IMPORT_GUARDS = `const { guardServerBind, installRejectionGuard, resolveBindTarget } = await import(${JSON.stringify(GUARD_MODULE)});`;

function guardLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.includes("unhandled rejection"));
}

describe("DS-30 unhandled rejection survival (real child processes)", () => {
  test("a stray rejection logs one bounded line and the process keeps serving-equivalent work", async () => {
    const result = await runBunChild([
      IMPORT_GUARDS,
      "installRejectionGuard();",
      'Promise.reject(new Error("dd035-stray-rejection"));',
      'setTimeout(() => console.log("DD035_ALIVE_AFTER_REJECTION"), 250);',
    ].join("\n"));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // The delayed marker is the proof of survival: without a listener Bun exits
    // 1 during the rejection and this timer never fires.
    expect(result.stdout).toContain("DD035_ALIVE_AFTER_REJECTION");
    expect(result.stderr).toContain("unhandled rejection");
    expect(result.stderr).toContain("dd035-stray-rejection");
  });

  test("a multiline, oversized, control-character reason is flattened and bounded in one line", async () => {
    const result = await runBunChild([
      IMPORT_GUARDS,
      "installRejectionGuard();",
      'Promise.reject(new Error("first-line\\nsecond-line\\r\\nTHIRD-" + "x".repeat(4000) + "\\u0000\\u001b[31m"));',
      'setTimeout(() => console.log("DD035_ALIVE_AFTER_MULTILINE"), 250);',
    ].join("\n"));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DD035_ALIVE_AFTER_MULTILINE");

    const lines = guardLines(result.stderr);
    expect(lines.length).toBe(1);
    const line = lines[0];
    // Newlines became spaces rather than splitting the record.
    expect(line).toContain("first-line second-line");
    // No NUL, no ESC/ANSI, no stray C0/C1 control characters at all.
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(line)).toBe(false);
    // Bounded: prefix + reason budget + ASCII ellipsis.
    const bound = formatUnhandledRejectionLine("").length + MAX_REJECTION_REASON_CHARS + 3;
    expect(line.length).toBeLessThanOrEqual(bound);
    expect(line).toContain("...");
  });

  test("a locally handled rejection stays handled and is never reported", async () => {
    const result = await runBunChild([
      IMPORT_GUARDS,
      "installRejectionGuard();",
      'Promise.reject(new Error("dd035-handled-rejection")).catch(() => {});',
      'setTimeout(() => console.log("DD035_ALIVE_AFTER_HANDLED"), 150);',
    ].join("\n"));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DD035_ALIVE_AFTER_HANDLED");
    expect(result.stderr).not.toContain("unhandled rejection");
    expect(result.stderr).not.toContain("dd035-handled-rejection");
  });
});

describe("DS-31 bind guard (real child processes)", () => {
  test("a real occupied loopback port exits nonzero naming the actual host and port", async () => {
    const holder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("dd035-holder"),
    });
    try {
      const port = holder.port;
      expect(typeof port).toBe("number");
      expect(port as number).toBeGreaterThan(0);

      const result = await runBunChild([
        IMPORT_GUARDS,
        `guardServerBind(() => Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("child") }), resolveBindTarget(${port}, "127.0.0.1"));`,
        'console.log("DD035_BIND_UNEXPECTEDLY_SUCCEEDED");',
      ].join("\n"));

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("DD035_BIND_UNEXPECTEDLY_SUCCEEDED");
      // The message names the real bind target, not a generic "port in use".
      expect(result.stderr).toContain(`127.0.0.1:${port}`);
      expect(result.stderr).toContain("EADDRINUSE");
      expect(result.stderr.toLowerCase()).toContain(ADDRESS_IN_USE_HINT.toLowerCase());
      expect(result.stderr).toContain(formatAddressInUseMessage(resolveBindTarget(port as number, "127.0.0.1")));
      // ... and the process left with the diagnostic, not Bun's raw stack.
      expect(result.stderr).not.toMatch(/^\s+at\s/m);
    } finally {
      await holder.stop(true);
    }
  });

  test("a non-EADDRINUSE bind failure keeps the exact original error object", async () => {
    const result = await runBunChild([
      IMPORT_GUARDS,
      'const original = Object.assign(new Error("EACCES: permission denied, address already in use"), { code: "EACCES" });',
      "let caught;",
      'try { guardServerBind(() => { throw original; }, resolveBindTarget(47999, "127.0.0.1")); } catch (error) { caught = error; }',
      'console.log("DD035_IDENTITY=" + (caught === original));',
      'console.log("DD035_AFTER_GUARD");',
    ].join("\n"));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // The message says "address already in use" but the explicit code wins:
    // the error is rethrown untouched, not reclassified as a port collision.
    expect(result.stdout).toContain("DD035_IDENTITY=true");
    expect(result.stdout).toContain("DD035_AFTER_GUARD");
    expect(result.stderr).not.toContain("unhandled rejection");
    expect(result.stderr.toLowerCase()).not.toContain(ADDRESS_IN_USE_HINT.toLowerCase());
    expect(result.stderr).not.toContain("cannot start");
  });

  test("a successful bind passes the live server through and keeps request handling intact", async () => {
    const result = await runBunChild([
      IMPORT_GUARDS,
      'const server = guardServerBind(() => Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => new Response("dd035:" + new URL(req.url).pathname) }), resolveBindTarget(0, "127.0.0.1"));',
      'console.log("DD035_PORT_OK=" + (typeof server.port === "number" && server.port > 0));',
      'console.log("DD035_HOSTNAME=" + server.hostname);',
      'const response = await fetch("http://127.0.0.1:" + server.port + "/ping");',
      'console.log("DD035_BODY=" + (await response.text()));',
      "server.stop(true);",
    ].join("\n"));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DD035_PORT_OK=true");
    // The server that came back is the one bound to the requested target, and
    // requests still reach the unchanged fetch handler.
    expect(result.stdout).toContain("DD035_HOSTNAME=127.0.0.1");
    expect(result.stdout).toContain("DD035_BODY=dd035:/ping");
    expect(result.stderr.toLowerCase()).not.toContain(ADDRESS_IN_USE_HINT.toLowerCase());
  });
});

describe("pure helpers", () => {
  test("installRejectionGuard is idempotent and the listener never throws", () => {
    const listeners: Array<(reason: unknown, promise: unknown) => void> = [];
    const host: RejectionHost = {
      on: (_event, listener) => {
        listeners.push(listener);
      },
    };
    expect(installRejectionGuard(() => {}, host)).toBe(true);
    expect(installRejectionGuard(() => {}, host)).toBe(false);
    expect(listeners.length).toBe(1);

    const throwingListeners: Array<(reason: unknown, promise: unknown) => void> = [];
    const throwingHost: RejectionHost = {
      on: (_event, listener) => {
        throwingListeners.push(listener);
      },
    };
    installRejectionGuard(() => {
      throw new Error("logger exploded");
    }, throwingHost);
    // A failing logger must not turn the guard into the crash it prevents.
    expect(() => throwingListeners[0](new Error("boom"), Promise.resolve())).not.toThrow();
  });

  test("the rejection line never reads a stack or user path", () => {
    const lines: string[] = [];
    const listeners: Array<(reason: unknown, promise: unknown) => void> = [];
    const host: RejectionHost = {
      on: (_event, listener) => {
        listeners.push(listener);
      },
    };
    installRejectionGuard((line) => lines.push(line), host);

    const error = new Error("safe-message");
    error.stack = "Error: safe-message\n    at secret (C:\\Users\\someone\\secret-file.ts:1:1)";
    listeners[0](error, undefined);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("safe-message");
    expect(lines[0]).not.toContain("secret-file.ts");
    expect(lines[0]).not.toContain("C:\\Users");
    expect(lines[0]).not.toContain("\n");
  });

  test("rejection formatting never invokes arbitrary object conversion or error getters", () => {
    let conversions = 0;
    const reason = { toString() { conversions += 1; return "unsafe conversion"; } };
    expect(formatUnhandledRejectionLine(reason)).toContain("[object]");
    expect(conversions).toBe(0);
    let reads = 0;
    const error = new Error("safe");
    Object.defineProperty(error, "message", { get() { reads += 1; return "unsafe getter"; } });
    expect(formatUnhandledRejectionLine(error)).not.toContain("unsafe getter");
    expect(reads).toBe(0);
  });

  test("rejection strings and error messages do not expose paths", () => {
    for (const reason of [
      "failed to open C:\\Users\\someone\\private file.txt",
      new Error("ENOENT /home/someone/private.txt"),
      "network failure \\\\host\\share\\private.txt",
    ]) {
      const line = formatUnhandledRejectionLine(reason);
      expect(line).not.toContain("someone");
      expect(line).not.toContain("private");
      expect(line).not.toContain("share");
      expect(line).toContain("[redacted path-bearing reason]");
    }
  });

  test("sanitizeOneLine bounds content and flattens control characters", () => {
    expect(sanitizeOneLine("a\nb\rc\td\u0000e\u001b[31m", 100)).toBe("a b c d e [31m");
    const truncated = sanitizeOneLine("y".repeat(50), 10);
    expect(truncated).toBe("yyyyyyyyyy...");
    expect(truncated.length).toBe(13);
  });

  test("isAddressInUseError trusts an explicit code and only falls back to text without one", () => {
    expect(isAddressInUseError(Object.assign(new Error("Failed to start server"), { code: "EADDRINUSE" }))).toBe(true);
    // Explicit code wins over a misleading message.
    expect(isAddressInUseError(Object.assign(new Error("address already in use"), { code: "EACCES" }))).toBe(false);
    // Codeless wrappers still get recognised, including Bun's own bind wording.
    expect(isAddressInUseError(new Error("listen error: address already in use"))).toBe(true);
    expect(isAddressInUseError(new Error("Failed to start server. Is port 55258 in use?"))).toBe(true);
    expect(isAddressInUseError("EADDRINUSE")).toBe(true);
    expect(isAddressInUseError(new Error("permission denied"))).toBe(false);
    expect(isAddressInUseError(null)).toBe(false);
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "" }))).toBeUndefined();
  });

  test("guardServerBind logs the resolved target and exits 1 on EADDRINUSE", () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const bindError = Object.assign(new Error("Failed to start server. Is port 19877 in use?"), { code: "EADDRINUSE" });
    let thrown: unknown;

    try {
      guardServerBind(
        () => {
          throw bindError;
        },
        resolveBindTarget(19877),
        {
          log: (line) => lines.push(line),
          exit: (code) => exits.push(code),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("0.0.0.0:19877");
    expect(lines[0]).toContain(ADDRESS_IN_USE_HINT);
    expect(exits).toEqual([1]);
    // Injected exit returned; the original error is still preserved.
    expect(thrown).toBe(bindError);
  });
});

describe("entrypoint wiring", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

  test("the rejection guard is installed after self-log wiring and before startup constants", () => {
    const selfLogCall = source.indexOf("installSelfLog();");
    const guardCall = source.indexOf("installRejectionGuard();");
    const portConstant = source.indexOf("const PORT =");

    expect(selfLogCall).toBeGreaterThan(-1);
    expect(guardCall).toBeGreaterThan(selfLogCall);
    expect(portConstant).toBeGreaterThan(guardCall);
  });

  test("the real HTTP bind goes through the guard with the resolved host and port", () => {
    // No bare top-level `serve({` may remain: that is the DS-31 form.
    expect(source).not.toMatch(/^serve\(\{/m);
    expect(source).toMatch(/guardServerBind\(\s*\(\)\s*=>\s*serve\(\{/);
    expect(source).toMatch(/const BIND_TARGET = resolveBindTarget\(PORT\);/);
    expect(source).toMatch(/hostname: BIND_TARGET\.hostname,/);
    // The guarded thunk keeps the original serve options byte-for-byte:
    // idleTimeout 0 (long SSE turns) and the same baseFetch handler.
    expect(source).toMatch(/guardServerBind\(\s*\(\)\s*=>\s*serve\(\{[\s\S]*?idleTimeout: 0,[\s\S]*?fetch: baseFetch,/);
  });
});
