// ═══════════════════════════════════════════════════════════════
// ── Shell Bundle ──
// ═══════════════════════════════════════════════════════════════
// The `bash` tool registered into the ToolRuntime. Dangerous + approval-required.

import { execFile, spawn, type ChildProcess } from "child_process";
import { existsSync, statSync } from "fs";
import { TOOL_TIMEOUT_REASON, type ToolRuntime, type ExecutionContext } from "./tool-runtime";
import { ToolExecutionError, type ToolDefinition } from "./tool-types";
import { resolveSafePath } from "./fs-scope";

/** Hard ceiling when config carries no `tools.shell_timeout_max_ms`. */
const DEFAULT_SHELL_TIMEOUT_MAX_MS = 120_000;
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

/**
 * Git Bash locations, in preference order.
 *
 * `C:\Windows\System32\bash.exe` is deliberately EXCLUDED and filtered below:
 * on Windows that path is the WSL launcher, so a command sent there runs in a
 * different filesystem namespace where the workspace path does not resolve.
 * A bare `spawn("bash")` finds it via PATH on many machines, which is why the
 * resolution is explicit rather than left to PATH lookup.
 */
const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

function isWslLauncher(candidate: string): boolean {
  return /\\system32\\bash\.exe$/i.test(candidate);
}

/** Resolve the interpreter for the `bash` tool. Exported for pinning. */
export function resolveBashProgram(cfg: { tools?: { bash_path?: string } }): string {
  const configured = cfg.tools?.bash_path?.trim();
  if (configured) {
    if (isWslLauncher(configured)) {
      throw new Error(
        "tools.bash_path points at the WSL launcher (System32\\bash.exe). " +
          "Set it to a Git Bash executable, or clear it to auto-resolve.",
      );
    }
    return configured;
  }

  if (process.platform === "win32") {
    const found = WINDOWS_BASH_CANDIDATES.find((c) => !isWslLauncher(c) && existsSync(c));
    if (found) return found;
  }

  // POSIX, or Windows with no Git Bash installed: fall back to PATH lookup.
  return "bash";
}

function shellTimeout(
  args: Record<string, unknown>,
  cfg: { tools?: { shell_timeout_max_ms?: number } },
  ctx: ExecutionContext,
): number {
  const max = cfg.tools?.shell_timeout_max_ms ?? DEFAULT_SHELL_TIMEOUT_MAX_MS;
  const requested = typeof args.timeout_ms === "number" && args.timeout_ms > 0
    ? args.timeout_ms
    : DEFAULT_SHELL_TIMEOUT_MS;
  const contextLimit = typeof ctx.timeout_ms === "number" && Number.isFinite(ctx.timeout_ms) && ctx.timeout_ms > 0
    ? ctx.timeout_ms
    : Number.POSITIVE_INFINITY;
  return Math.min(requested, max, contextLimit);
}

const BASH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a shell command. Use sparingly and only when necessary. Prefer file operations over shell commands when possible.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory within the active workspace or a Session-granted root" },
        description: { type: "string", description: "Brief description of what this command does" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (max 60000)", default: 30000 },
      },
      required: ["command"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "shell", evidence: "execution" },
};

const MAX_SHELL_OUTPUT_CHARS = 8_000;

function boundedShellText(value: string): string {
  if (value.length <= MAX_SHELL_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_SHELL_OUTPUT_CHARS)}… [truncated]`;
}

function terminateProcess(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  const pid = proc.pid;
  if (pid && process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    // Node's SIGTERM is forceful on Windows too, so signal the whole tree at
    // once. A direct-child exit cannot confirm that descendants have stopped.
    args.push("/F");
    return new Promise((resolve, reject) => {
      execFile("taskkill", args, { encoding: "utf8", windowsHide: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  if (pid) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return Promise.reject(error);
    }
    return Promise.resolve();
  }

  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  try {
    if (proc.kill(signal)) return Promise.resolve();
    return Promise.reject(new Error("Could not signal the shell child before its process ID was available"));
  } catch (error) {
    return Promise.reject(error);
  }
}

function shellFailure(code: "execution_error" | "spawn_error" | "cancelled" | "timeout", message: string, output: string, cause?: unknown): ToolExecutionError {
  return new ToolExecutionError(code, boundedShellText(message), boundedShellText(output), cause);
}

async function handleShell(
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  spawnShell: (cfg: ExecutionContext["config"]) => { program: string; prefixArgs: string[] },
): Promise<string> {
  const cfg = ctx.config;
  const command = args.command as string;
  const timeout = shellTimeout(args, cfg as { tools?: { shell_timeout_max_ms?: number } }, ctx);
  const requestedCwd = typeof args.cwd === "string" && args.cwd.trim().length > 0
    ? args.cwd
    : (ctx.workspace_path || cfg.jarvis_path || process.cwd());
  const resolution = resolveSafePath(requestedCwd, cfg, {
    workspaceOverride: ctx.workspace_path,
    sessionGrants: ctx.session_grants,
  });
  const cwd = resolution.canonicalPath;
  resolution.revalidate();
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Shell cwd is not a directory: ${requestedCwd}`);
  }
  resolution.revalidate();
  if (ctx.signal?.aborted) {
    const reason = ctx.signal.reason === TOOL_TIMEOUT_REASON ? "timeout" : "cancelled";
    throw shellFailure(reason, reason === "timeout" ? "Shell execution timed out" : "Shell execution cancelled", "Shell execution cancelled");
  }

  let program: string;
  let prefixArgs: string[];
  try {
    ({ program, prefixArgs } = spawnShell(cfg));
  } catch (e: any) {
    throw shellFailure("spawn_error", `Failed to spawn shell: ${e?.message ?? String(e)}`, `Failed to spawn shell: ${e?.message ?? String(e)}`, e);
  }

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      resolution.revalidate();
      proc = spawn(program, [...prefixArgs, command], {
        cwd,
        env: { ...process.env, PATH: process.env.PATH },
        detached: process.platform !== "win32",
      });
    } catch (e: any) {
      reject(shellFailure("spawn_error", `Failed to spawn shell: ${e?.message ?? String(e)}`, `Failed to spawn shell: ${e?.message ?? String(e)}`, e));
      return;
    }

    let stdout = "";
    let stderr = "";
    let closed = false;
    let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let finishingClose = false;
    let stopReason: "cancelled" | "timeout" | undefined;
    let spawnError: Error | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    let forcedTerminationRequested = false;
    let terminationError: unknown;
    let terminationWork: Promise<void> = Promise.resolve();

    const requestTermination = (signal: "SIGTERM" | "SIGKILL"): Promise<void> => {
      terminationWork = terminationWork.then(async () => {
        try {
          await terminateProcess(proc, signal);
          terminationError = undefined;
        } catch (error) {
          terminationError = error;
        }
      });
      return terminationWork;
    };

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      ctx.signal?.removeEventListener("abort", onAbort);
    };
    const requestStop = (reason: "cancelled" | "timeout"): void => {
      if (closed || closeResult || stopReason) return;
      stopReason = reason;
      void requestTermination("SIGTERM");
      hardKillTimer = setTimeout(() => {
        if (closed || forcedTerminationRequested) return;
        forcedTerminationRequested = true;
        void requestTermination("SIGKILL").then(() => finishClose());
      }, 500);
      hardKillTimer.unref?.();
    };

    const finishClose = async (): Promise<void> => {
      if (!closeResult || closed || finishingClose) return;
      finishingClose = true;

      while (true) {
        const currentWork = terminationWork;
        await currentWork;
        if (currentWork === terminationWork) break;
      }

      if (stopReason && terminationError && !forcedTerminationRequested) {
        forcedTerminationRequested = true;
        await requestTermination("SIGKILL");
      }

      closed = true;
      cleanup();
      const output = stdout.trim();
      const err = stderr.trim();
      if (stopReason) {
        const message = stopReason === "timeout"
          ? `Shell execution timed out after ${timeout}ms`
          : "Shell execution cancelled";
        const cleanupDetail = terminationError
          ? `Process tree termination could not be confirmed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`
          : undefined;
        const fullMessage = cleanupDetail ? `${message}\n${cleanupDetail}` : message;
        const failureOutput = [output || err, cleanupDetail].filter(Boolean).join("\n") || fullMessage;
        reject(shellFailure(stopReason, fullMessage, failureOutput, terminationError));
        return;
      }
      if (spawnError) {
        reject(shellFailure("spawn_error", `Failed to spawn shell: ${spawnError.message}`, `Failed to spawn shell: ${spawnError.message}`, spawnError));
        return;
      }
      const { code, signal } = closeResult;
      if (code === 0) {
        resolve(output || "(no output)");
        return;
      }
      if (signal) {
        reject(shellFailure("execution_error", `Shell command terminated by ${signal}`, `Shell command terminated by ${signal}\nPartial output: ${output}`));
        return;
      }
      let message = `Command failed with exit code ${code}`;
      if (err) message += `\nError: ${err}`;
      if (output) message += `\nPartial output: ${output}`;
      if (code === 127) message += "\nHint: Command not found. Check if the tool is installed or use the full path.";
      else if (code === 1 && err.includes("Permission denied")) message += "\nHint: Permission denied. Try checking file permissions with ls -la, or use a different approach.";
      else if (code === 1 && err.includes("No such file")) message += "\nHint: File or directory not found. Use glob to find the correct path.";
      else if (err.includes("already exists")) message += "\nHint: Target already exists. Use read_file to check current content, or use a different filename.";
      reject(shellFailure("execution_error", message, message));
    };

    onAbort = (): void => requestStop(ctx.signal?.reason === TOOL_TIMEOUT_REASON ? "timeout" : "cancelled");
    timeoutTimer = setTimeout(() => requestStop("timeout"), timeout);

    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout?.on("data", (data) => {
      stdout = boundedShellText(stdout + data.toString());
    });
    proc.stderr?.on("data", (data) => {
      stderr = boundedShellText(stderr + data.toString());
    });
    proc.once("error", (error) => {
      spawnError = error;
      if (proc.pid === undefined) {
        closed = true;
        cleanup();
        reject(shellFailure("spawn_error", `Failed to spawn shell: ${error.message}`, `Failed to spawn shell: ${error.message}`, error));
      }
    });
    proc.once("close", (code, signal) => {
      if (closed || closeResult) return;
      closeResult = { code, signal };
      void finishClose();
    });
  });
}

const POWERSHELL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "powershell",
    description:
      "Execute a PowerShell command on Windows. Use for Windows-native operations (services, registry, Get-* cmdlets). Prefer file operations over shell commands when possible.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command to execute" },
        cwd: { type: "string", description: "Working directory within the active workspace or a Session-granted root" },
        description: { type: "string", description: "Brief description of what this command does" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds", default: DEFAULT_SHELL_TIMEOUT_MS },
      },
      required: ["command"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "shell", evidence: "execution" },
};

export function registerShellBundle(rt: ToolRuntime): void {
  rt.register(BASH_DEF, (a, c) =>
    handleShell(a, c, (cfg) => ({ program: resolveBashProgram(cfg), prefixArgs: ["-c"] })),
  );

  // The text protocol has carried `powershell`/`pwsh`/`ps` aliases all along;
  // without this registration they resolved to nothing. Windows-only: there is
  // no meaningful PowerShell target on the POSIX deploys.
  if (process.platform === "win32") {
    rt.register(POWERSHELL_DEF, (a, c) =>
      handleShell(a, c, () => ({
        program: "powershell.exe",
        prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"],
      })),
    );
  }
}
