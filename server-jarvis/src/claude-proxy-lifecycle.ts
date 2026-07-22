// Claude-CLI proxy lifecycle — ported from the Tauri desktop app's Rust runtime
// (src-tauri/src/lib.rs: spawn_claude_cli_proxy / reap_stale_proxy_listeners /
// parse_listening_pids / find_claude_cli_proxy / find_jarvis_python).
//
// Why this exists in the Bun server too: the `claude_cli` delegate defaults to
// policy `delegate_first` (config.ts), so every eligible turn tries to reach the
// local proxy at 127.0.0.1:19878 before falling back to the native executor. But
// the ONLY thing that ever started that proxy was the desktop app's Rust boot
// sequence (lib.rs ~1173). The normal deploy path (build-and-deploy.ps1
// -RestartServer) restarts ONLY this Bun server, never the desktop app — so when
// the server is what gets restarted, `delegate_first` was silently inert: the
// port never listened, every delegate-eligibility check failed, and the runtime
// fell back to native execution 100% of the time. Bringing the proxy up from the
// SERVER's own boot closes that gap.
//
// Design stance mirrors the Rust side exactly: this is an OPTIONAL subsystem. A
// missing script, a missing interpreter, or a failed spawn must NEVER take down
// the core HTTP server — every failure path here logs a clear warning and lets
// the server keep running with the delegate simply unavailable (fail-open).

import { execFile, spawn as nodeSpawn } from "child_process";
import type { SpawnOptions } from "child_process";
import { existsSync, mkdirSync, openSync } from "fs";
import { connect } from "net";
import { homedir } from "os";
import { join } from "path";
import type { JarvisConfig } from "./config";
import { selfLogDir } from "./self-log";

/** The port `claude_cli_proxy.py` binds. Must match lib.rs `CLAUDE_PROXY_PORT`
 * and claude-cli.ts `LOCAL_PROXY_BASE_URL`. */
export const CLAUDE_PROXY_PORT = 19878;

/** Default local model the proxy drives when config leaves `ollama.model` blank.
 * Matches the Rust fallback in `spawn_claude_cli_proxy`. */
const DEFAULT_PROXY_MODEL = "qwen3:8b";

/**
 * Parse `netstat -ano` output for PIDs LISTENING on `port`. Windows rows look
 * like: `  TCP    127.0.0.1:19878   0.0.0.0:0   LISTENING   29084`.
 *
 * Pure and unit-tested — a direct port of Rust's `parse_listening_pids`: split
 * each LISTENING line on whitespace, require the local-address column (index 1)
 * to END in `:<port>` (so a row that merely mentions the port in its FOREIGN
 * column never matches), and take the last column as the PID (rejecting a column
 * that is not a plain non-negative integer, matching Rust's `parse::<u32>()`).
 */
export function parseListeningPids(netstatOutput: string, port: number): number[] {
  const localSuffix = `:${port}`;
  const pids: number[] = [];
  for (const line of netstatOutput.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const cols = line.trim().split(/\s+/);
    // Expected shape: [Proto, LocalAddress, ForeignAddress, State, PID].
    const localAddr = cols[1];
    if (!localAddr || !localAddr.endsWith(localSuffix)) continue;
    const last = cols[cols.length - 1];
    if (last && /^\d+$/.test(last)) {
      pids.push(Number.parseInt(last, 10));
    }
  }
  return pids;
}

/**
 * Lightweight TCP connect probe — is anything accepting connections on `port`?
 * Deliberately does NOT shell out to netstat (that is reserved for the heavier
 * PID-listing/reaping step); a plain connect answers the "is the proxy up?"
 * question the same way the Rust supervisor's `is_port_listening` does.
 *
 * Real I/O; untested (matches run-gate.ts's own untested `runPythonCommand`
 * wrapper). Resolves true on connect, false on error/timeout.
 */
export function isPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 750,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean, socket: ReturnType<typeof connect>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = connect({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, socket));
    socket.once("timeout", () => finish(false, socket));
    socket.once("error", () => finish(false, socket));
  });
}

/**
 * PIDs currently LISTENING on `port`, via a real `netstat -ano` invocation fed
 * through the pure `parseListeningPids`. Windows-only: returns `[]` immediately
 * on any other platform, matching Rust's `cfg!(target_os = "windows")` guard.
 * Real I/O; untested.
 */
export function pidsListeningOnPort(port: number): Promise<number[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(parseListeningPids(stdout, port));
    });
  });
}

/**
 * Reap any process squatting `port` before a fresh spawn claims it. Closes the
 * stale-listener hazard (an orphaned proxy from a previous deploy can survive
 * indefinitely once nothing tracks it — observed live as 3 simultaneous :19878
 * listeners). Best-effort and a direct port of Rust's `reap_stale_proxy_listeners`:
 * a kill failure is logged, never thrown.
 */
export async function reapStaleProxyListeners(port: number): Promise<void> {
  const pids = await pidsListeningOnPort(port);
  for (const pid of pids) {
    console.log(
      `[ClaudeProxy] reaping PID ${pid} already listening on :${port} before spawning claude_cli_proxy`,
    );
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }, (error, _stdout, stderr) => {
        if (error) {
          console.warn(
            `[ClaudeProxy] taskkill PID ${pid} failed: ${(stderr || error.message || "").trim()}`,
          );
        }
        resolve();
      });
    });
  }
}

/**
 * Resolve the proxy script path, checking in priority order (matching the
 * native-Windows-relevant candidates of Rust's `find_claude_cli_proxy`):
 *   1. `JARVIS_CLAUDE_PROXY_PATH` env override (if the file exists)
 *   2. `<cfg.jarvis_path>/scripts/claude_cli_proxy.py`
 *   3. `~/.openclaw/jarvis/hermes/claude_cli_proxy.py`
 * Returns undefined if none exist. `exists` is injectable for testing.
 */
export function resolveProxyScriptPath(
  cfg: JarvisConfig,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const override = process.env.JARVIS_CLAUDE_PROXY_PATH;
  if (override && override.trim() && exists(override)) return override;

  if (cfg.jarvis_path && cfg.jarvis_path.trim()) {
    const fromJarvisPath = join(cfg.jarvis_path, "scripts", "claude_cli_proxy.py");
    if (exists(fromJarvisPath)) return fromJarvisPath;
  }

  const fallback = join(homedir(), ".openclaw", "jarvis", "hermes", "claude_cli_proxy.py");
  if (exists(fallback)) return fallback;

  return undefined;
}

/** A resolved Python interpreter: a base command plus any prefix args. */
export interface InterpreterInvocation {
  command: string;
  prefixArgs: string[];
}

/** Probe whether `command [...prefixArgs] --version` runs successfully. Real I/O. */
function probeInterpreter(command: string, prefixArgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, [...prefixArgs, "--version"], { windowsHide: true, timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Try `python --version`, then `py -3 --version` (the same try/fallback style
 * run-gate.ts establishes for its own interpreter discovery). Returns the first
 * that runs, or undefined if neither is available. `probe` is injectable.
 */
export async function resolveInterpreter(
  probe: (command: string, prefixArgs: string[]) => Promise<boolean> = probeInterpreter,
): Promise<InterpreterInvocation | undefined> {
  const candidates: InterpreterInvocation[] = [
    { command: "python", prefixArgs: [] },
    { command: "py", prefixArgs: ["-3"] },
  ];
  for (const candidate of candidates) {
    if (await probe(candidate.command, candidate.prefixArgs)) return candidate;
  }
  return undefined;
}

/** Open append-mode log files for the proxy's stdout/stderr in the canonical
 * server log dir (same dir as server-jarvis.self.log), mirroring the Rust
 * `jarvis_server_log_stdio` approach. Falls back to "ignore" on any fs error. */
function proxyLogStdio(): SpawnOptions["stdio"] {
  try {
    const dir = selfLogDir();
    mkdirSync(dir, { recursive: true });
    const out = openSync(join(dir, "claude-proxy.log"), "a");
    const err = openSync(join(dir, "claude-proxy.err.log"), "a");
    return ["ignore", out, err];
  } catch {
    return ["ignore", "ignore", "ignore"];
  }
}

/** Minimal shape we need back from a spawn, so tests can inject a fake. */
interface SpawnedChild {
  pid?: number;
}

/** Default spawn: real child_process.spawn, with proxy stdout/stderr teed to log
 * files and an 'error' listener so an async spawn failure (e.g. ENOENT emitted
 * after return) can never surface as an unhandled exception. */
function defaultSpawn(command: string, args: string[], options: SpawnOptions): SpawnedChild {
  const child = nodeSpawn(command, args, { ...options, stdio: proxyLogStdio() });
  child.on("error", (error) => {
    console.warn(
      `[ClaudeProxy] proxy process error: ${error instanceof Error ? error.message : String(error)} — delegate unavailable, server continues`,
    );
  });
  return child;
}

/** Injectable seams so the orchestration branching can be tested without real
 * subprocess/network I/O (mirrors run-gate.ts/syntax-gate.ts's options.exists
 * pattern). Every field defaults to the real implementation above. */
export interface EnsureProxyDeps {
  isPortListening?: (port: number) => Promise<boolean>;
  resolveScriptPath?: (cfg: JarvisConfig) => string | undefined;
  resolveInterpreter?: () => Promise<InterpreterInvocation | undefined>;
  reapStaleProxyListeners?: (port: number) => Promise<void>;
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => SpawnedChild;
}

/**
 * Ensure the Claude-CLI proxy is running, best-effort. Idempotent and fail-open:
 *   • skip entirely unless `claude_cli.enabled && auth_mode === "proxy"`;
 *   • skip the spawn if the port is already listening (matches Rust's Ollama
 *     idempotency stance — never double-spawn a healthy listener);
 *   • warn-and-return if the script or an interpreter is missing;
 *   • reap stale listeners, then spawn with the exact runtime env the proxy
 *     expects (JARVIS_CLAUDE_PROXY_PORT/BIND, JARVIS_OLLAMA_URL, JARVIS_DEFAULT_MODEL,
 *     and JARVIS_OPENROUTER_API_KEY ONLY when a non-empty key is configured).
 * Never throws; any failure logs a warning and leaves the server running.
 */
export async function ensureClaudeCliProxyRunning(
  cfg: JarvisConfig,
  deps: EnsureProxyDeps = {},
): Promise<void> {
  const enabled = cfg.claude_cli?.enabled === true && cfg.claude_cli?.auth_mode === "proxy";
  if (!enabled) {
    console.log(
      `[ClaudeProxy] not required (enabled=${cfg.claude_cli?.enabled}, auth_mode=${cfg.claude_cli?.auth_mode})`,
    );
    return;
  }

  const isPortUp = deps.isPortListening ?? isPortListening;
  if (await isPortUp(CLAUDE_PROXY_PORT)) {
    console.log(`[ClaudeProxy] already running on :${CLAUDE_PROXY_PORT} — skipping spawn`);
    return;
  }

  const resolveScript = deps.resolveScriptPath ?? ((c: JarvisConfig) => resolveProxyScriptPath(c));
  const script = resolveScript(cfg);
  if (!script) {
    console.warn(
      `[ClaudeProxy] proxy script not found (checked JARVIS_CLAUDE_PROXY_PATH, ` +
        `${cfg.jarvis_path}/scripts/claude_cli_proxy.py, ` +
        `~/.openclaw/jarvis/hermes/claude_cli_proxy.py) — delegate unavailable, server continues`,
    );
    return;
  }

  const resolveInterp = deps.resolveInterpreter ?? (() => resolveInterpreter());
  const interpreter = await resolveInterp();
  if (!interpreter) {
    console.warn(
      "[ClaudeProxy] no Python interpreter found (tried python, py -3) — delegate unavailable, server continues",
    );
    return;
  }

  const reap = deps.reapStaleProxyListeners ?? reapStaleProxyListeners;
  try {
    await reap(CLAUDE_PROXY_PORT);
  } catch (error) {
    // Reaping is best-effort; a failure here must not block the spawn attempt.
    console.warn(
      `[ClaudeProxy] reaping stale listeners failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const model = cfg.ollama?.model && cfg.ollama.model.trim() ? cfg.ollama.model : DEFAULT_PROXY_MODEL;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JARVIS_CLAUDE_PROXY_PORT: String(CLAUDE_PROXY_PORT),
    JARVIS_CLAUDE_PROXY_BIND: "127.0.0.1",
    JARVIS_OLLAMA_URL: "http://127.0.0.1:11434",
    JARVIS_DEFAULT_MODEL: model,
  };
  const openrouterKey = cfg.openrouter?.api_key;
  if (openrouterKey && openrouterKey.trim()) {
    env.JARVIS_OPENROUTER_API_KEY = openrouterKey;
  }

  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const args = [...interpreter.prefixArgs, script];
  try {
    const child = spawnFn(interpreter.command, args, {
      env,
      detached: false,
      windowsHide: true,
    });
    console.log(
      `[ClaudeProxy] claude_cli_proxy started (PID ${child.pid ?? "unknown"}, ` +
        `interpreter ${interpreter.command} ${interpreter.prefixArgs.join(" ")}, ` +
        `script ${script}, model ${model})`,
    );
  } catch (error) {
    console.warn(
      `[ClaudeProxy] spawn failed: ${error instanceof Error ? error.message : String(error)} ` +
        `(interpreter=${interpreter.command} ${interpreter.prefixArgs.join(" ")}, script=${script}, model=${model}) ` +
        "— delegate unavailable, server continues",
    );
  }
}
