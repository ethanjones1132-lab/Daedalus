// ═══════════════════════════════════════════════════════════════
// ── Shell Bundle ──
// ═══════════════════════════════════════════════════════════════
// The `bash` tool registered into the ToolRuntime. Dangerous + approval-required.

import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { safePath } from "./fs-scope";

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

function shellTimeout(args: Record<string, unknown>, cfg: { tools?: { shell_timeout_max_ms?: number } }): number {
  const max = cfg.tools?.shell_timeout_max_ms ?? DEFAULT_SHELL_TIMEOUT_MAX_MS;
  const requested = typeof args.timeout_ms === "number" && args.timeout_ms > 0
    ? args.timeout_ms
    : DEFAULT_SHELL_TIMEOUT_MS;
  return Math.min(requested, max);
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

async function handleShell(
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  spawnShell: (cfg: ExecutionContext["config"]) => { program: string; prefixArgs: string[] },
): Promise<string> {
  const cfg = ctx.config;
  const command = args.command as string;
  const timeout = shellTimeout(args, cfg as { tools?: { shell_timeout_max_ms?: number } });
  const requestedCwd = typeof args.cwd === "string" && args.cwd.trim().length > 0
    ? args.cwd
    : (ctx.workspace_path || cfg.jarvis_path || process.cwd());
  const cwd = safePath(requestedCwd, cfg, {
    workspaceOverride: ctx.workspace_path,
    sessionGrants: ctx.session_grants,
  });
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Shell cwd is not a directory: ${requestedCwd}`);
  }

  const { program, prefixArgs } = spawnShell(cfg);

  return new Promise((resolve) => {
    const proc = spawn(program, [...prefixArgs, command], {
      cwd,
      timeout,
      env: { ...process.env, PATH: process.env.PATH },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const output = stdout.trim();
      const err = stderr.trim();
      if (code === 0) {
        resolve(output || "(no output)");
      } else {
        let msg = `Command failed with exit code ${code}`;
        if (err) msg += `\nError: ${err}`;
        if (output) msg += `\nPartial output: ${output}`;
        if (code === 127) msg += "\nHint: Command not found. Check if the tool is installed or use the full path.";
        else if (code === 1 && err.includes("Permission denied")) msg += "\nHint: Permission denied. Try checking file permissions with ls -la, or use a different approach.";
        else if (code === 1 && err.includes("No such file")) msg += "\nHint: File or directory not found. Use glob to find the correct path.";
        else if (err.includes("already exists")) msg += "\nHint: Target already exists. Use read_file to check current content, or use a different filename.";
        resolve(msg);
      }
    });

    proc.on("error", (e) => resolve(`Error: ${e.message}`));
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
