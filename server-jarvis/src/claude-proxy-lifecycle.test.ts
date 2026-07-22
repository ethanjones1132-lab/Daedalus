import { describe, expect, test } from "bun:test";
import {
  CLAUDE_PROXY_PORT,
  ensureClaudeCliProxyRunning,
  parseListeningPids,
  resolveInterpreter,
  resolveProxyScriptPath,
  type EnsureProxyDeps,
  type InterpreterInvocation,
} from "./claude-proxy-lifecycle";
import type { JarvisConfig } from "./config";

// Realistic `netstat -ano` excerpt modeled on the multi-listener situation the
// Rust reference (lib.rs proxy_reap_tests) documents observing live: three
// stale processes bound to :19878 from prior sessions, plus an unrelated port
// and a non-LISTENING (TIME_WAIT) row that must be ignored.
const NETSTAT_FIXTURE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       29084",
  "  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       33496",
  "  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       32900",
  "  TCP    127.0.0.1:19877        0.0.0.0:0              LISTENING       11223",
  "  TCP    127.0.0.1:53872        127.0.0.1:19878        TIME_WAIT       0",
  "",
].join("\r\n");

describe("parseListeningPids", () => {
  test("finds every PID listening on the target port", () => {
    expect(parseListeningPids(NETSTAT_FIXTURE, 19878)).toEqual([29084, 33496, 32900]);
  });

  test("ignores a different port", () => {
    expect(parseListeningPids(NETSTAT_FIXTURE, 19877)).toEqual([11223]);
  });

  test("ignores a TIME_WAIT row whose FOREIGN address is :19878 but state is not LISTENING", () => {
    // The TIME_WAIT row contains ':19878' only in its foreign-address column; it
    // must never match because (a) the state column is not LISTENING and (b) the
    // local-address column (index 1) does not end in ':19878'.
    expect(parseListeningPids(NETSTAT_FIXTURE, 19878)).not.toContain(0);
  });

  test("empty output yields no PIDs", () => {
    expect(parseListeningPids("", 19878)).toEqual([]);
  });

  test("a port with nothing listening yields no PIDs", () => {
    expect(parseListeningPids(NETSTAT_FIXTURE, 60000)).toEqual([]);
  });

  test("tolerates lone-LF line endings as well as CRLF", () => {
    expect(parseListeningPids(NETSTAT_FIXTURE.replace(/\r\n/g, "\n"), 19878)).toEqual([
      29084, 33496, 32900,
    ]);
  });

  test("skips a LISTENING row whose PID column is not a plain integer", () => {
    const malformed = "  TCP    127.0.0.1:19878   0.0.0.0:0   LISTENING   notapid";
    expect(parseListeningPids(malformed, 19878)).toEqual([]);
  });
});

function baseConfig(overrides: Partial<JarvisConfig["claude_cli"]> = {}): JarvisConfig {
  return {
    claude_cli: { enabled: true, auth_mode: "proxy", ...overrides },
    ollama: { model: "qwen3:8b" },
    openrouter: { api_key: "" },
    jarvis_path: "C:/fake/jarvis",
  } as unknown as JarvisConfig;
}

/** Records spawn calls without touching the OS. */
function makeSpawnRecorder() {
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const spawnFn: NonNullable<EnsureProxyDeps["spawnFn"]> = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242 };
  };
  return { calls, spawnFn };
}

const PYTHON: InterpreterInvocation = { command: "python", prefixArgs: [] };

describe("ensureClaudeCliProxyRunning gating", () => {
  test("does nothing when claude_cli.enabled is false", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    let scriptResolved = false;
    await ensureClaudeCliProxyRunning(baseConfig({ enabled: false }), {
      resolveScriptPath: () => {
        scriptResolved = true;
        return "C:/fake/jarvis/scripts/claude_cli_proxy.py";
      },
      spawnFn,
    });
    expect(calls).toHaveLength(0);
    // Fully short-circuits at the config gate — never even resolves a script.
    expect(scriptResolved).toBe(false);
  });

  test("does nothing when auth_mode is not proxy", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    let scriptResolved = false;
    await ensureClaudeCliProxyRunning(baseConfig({ auth_mode: "subscription" }), {
      resolveScriptPath: () => {
        scriptResolved = true;
        return "C:/fake/jarvis/scripts/claude_cli_proxy.py";
      },
      spawnFn,
    });
    expect(calls).toHaveLength(0);
    expect(scriptResolved).toBe(false);
  });

  test("reaps unconditionally on every call — no port-probe idempotency guard", async () => {
    // Regression guard: an earlier version short-circuited on an is_port_listening
    // probe BEFORE reaping, so reap only ran when there was nothing to reap. That
    // let each restart's orphaned proxy (detached:false does not clean it up) look
    // "already running" and accumulate forever. Rust reaps unconditionally right
    // before the spawn; so must we. This test asserts reap+spawn happen with no
    // port probe available to short-circuit them.
    const { calls, spawnFn } = makeSpawnRecorder();
    const reapedPorts: number[] = [];
    await ensureClaudeCliProxyRunning(baseConfig(), {
      reapStaleProxyListeners: async (port) => {
        reapedPorts.push(port);
      },
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => PYTHON,
      spawnFn,
    });
    expect(reapedPorts).toEqual([CLAUDE_PROXY_PORT]);
    expect(calls).toHaveLength(1);
  });

  test("fails open (no spawn) when the proxy script cannot be found", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    await ensureClaudeCliProxyRunning(baseConfig(), {
      resolveScriptPath: () => undefined,
      resolveInterpreter: async () => PYTHON,
      spawnFn,
    });
    expect(calls).toHaveLength(0);
  });

  test("fails open (no spawn) when no interpreter is available", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    await ensureClaudeCliProxyRunning(baseConfig(), {
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => undefined,
      spawnFn,
    });
    expect(calls).toHaveLength(0);
  });

  test("reaps then spawns with the exact runtime env", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    const order: string[] = [];
    await ensureClaudeCliProxyRunning(baseConfig(), {
      reapStaleProxyListeners: async () => {
        order.push("reap");
      },
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => PYTHON,
      spawnFn: (command, args, options) => {
        order.push("spawn");
        return spawnFn(command, args, options);
      },
    });
    expect(order).toEqual(["reap", "spawn"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe("python");
    expect(call.args).toEqual(["C:/fake/jarvis/scripts/claude_cli_proxy.py"]);
    expect(call.options.env.JARVIS_CLAUDE_PROXY_PORT).toBe(String(CLAUDE_PROXY_PORT));
    expect(call.options.env.JARVIS_CLAUDE_PROXY_BIND).toBe("127.0.0.1");
    expect(call.options.env.JARVIS_OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(call.options.env.JARVIS_DEFAULT_MODEL).toBe("qwen3:8b");
    // No OpenRouter key configured -> the env var must be absent, not empty.
    expect("JARVIS_OPENROUTER_API_KEY" in call.options.env).toBe(false);
  });

  test("threads the interpreter prefix args (py -3) ahead of the script path", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    await ensureClaudeCliProxyRunning(baseConfig(), {
      reapStaleProxyListeners: async () => {},
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => ({ command: "py", prefixArgs: ["-3"] }),
      spawnFn,
    });
    expect(calls[0].command).toBe("py");
    expect(calls[0].args).toEqual(["-3", "C:/fake/jarvis/scripts/claude_cli_proxy.py"]);
  });

  test("forwards JARVIS_OPENROUTER_API_KEY only when the key is non-empty", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    const cfg = baseConfig();
    (cfg as any).openrouter.api_key = "sk-or-secret";
    await ensureClaudeCliProxyRunning(cfg, {
      reapStaleProxyListeners: async () => {},
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => PYTHON,
      spawnFn,
    });
    expect(calls[0].options.env.JARVIS_OPENROUTER_API_KEY).toBe("sk-or-secret");
  });

  test("falls back to qwen3:8b when ollama.model is blank (matches Rust default)", async () => {
    const { calls, spawnFn } = makeSpawnRecorder();
    const cfg = baseConfig();
    (cfg as any).ollama.model = "";
    await ensureClaudeCliProxyRunning(cfg, {
      reapStaleProxyListeners: async () => {},
      resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
      resolveInterpreter: async () => PYTHON,
      spawnFn,
    });
    expect(calls[0].options.env.JARVIS_DEFAULT_MODEL).toBe("qwen3:8b");
  });

  test("never throws when the default spawn path rejects", async () => {
    await expect(
      ensureClaudeCliProxyRunning(baseConfig(), {
        reapStaleProxyListeners: async () => {},
        resolveScriptPath: () => "C:/fake/jarvis/scripts/claude_cli_proxy.py",
        resolveInterpreter: async () => PYTHON,
        spawnFn: () => {
          throw new Error("spawn boom");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveProxyScriptPath", () => {
  const cfg = baseConfig();

  test("prefers the JARVIS_CLAUDE_PROXY_PATH override when it exists", () => {
    const prev = process.env.JARVIS_CLAUDE_PROXY_PATH;
    process.env.JARVIS_CLAUDE_PROXY_PATH = "C:/override/proxy.py";
    try {
      const path = resolveProxyScriptPath(cfg, (p) => p === "C:/override/proxy.py");
      expect(path).toBe("C:/override/proxy.py");
    } finally {
      if (prev === undefined) delete process.env.JARVIS_CLAUDE_PROXY_PATH;
      else process.env.JARVIS_CLAUDE_PROXY_PATH = prev;
    }
  });

  test("resolves <jarvis_path>/scripts/claude_cli_proxy.py when no override is set", () => {
    const prev = process.env.JARVIS_CLAUDE_PROXY_PATH;
    delete process.env.JARVIS_CLAUDE_PROXY_PATH;
    try {
      const expected = "C:/fake/jarvis/scripts/claude_cli_proxy.py".replace(/\//g, require("path").sep);
      const path = resolveProxyScriptPath(cfg, (p) => p === expected);
      expect(path).toBe(expected);
    } finally {
      if (prev !== undefined) process.env.JARVIS_CLAUDE_PROXY_PATH = prev;
    }
  });

  test("returns undefined when nothing exists", () => {
    const prev = process.env.JARVIS_CLAUDE_PROXY_PATH;
    delete process.env.JARVIS_CLAUDE_PROXY_PATH;
    try {
      expect(resolveProxyScriptPath(cfg, () => false)).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.JARVIS_CLAUDE_PROXY_PATH = prev;
    }
  });
});

describe("resolveInterpreter", () => {
  test("returns the first interpreter whose probe succeeds (python before py)", async () => {
    const tried: string[] = [];
    const interp = await resolveInterpreter(async (command) => {
      tried.push(command);
      return command === "python";
    });
    expect(interp).toEqual({ command: "python", prefixArgs: [] });
    expect(tried).toEqual(["python"]);
  });

  test("falls back to py -3 when python is unavailable", async () => {
    const interp = await resolveInterpreter(async (command) => command === "py");
    expect(interp).toEqual({ command: "py", prefixArgs: ["-3"] });
  });

  test("returns undefined when neither interpreter probes successfully", async () => {
    expect(await resolveInterpreter(async () => false)).toBeUndefined();
  });
});
