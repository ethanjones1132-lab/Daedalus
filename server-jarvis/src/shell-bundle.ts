// ═══════════════════════════════════════════════════════════════
// ── Shell Bundle ──
// ═══════════════════════════════════════════════════════════════
// The `bash` tool registered into the ToolRuntime. Dangerous + approval-required.

import { spawn } from "child_process";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

const BASH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a shell command. Use sparingly and only when necessary. Prefer file operations over shell commands when possible.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        description: { type: "string", description: "Brief description of what this command does" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (max 60000)", default: 30000 },
      },
      required: ["command"],
    },
  },
  requires_approval: true,
  dangerous: true,
};

async function handleBash(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const command = args.command as string;
  const timeout = Math.min((args.timeout_ms as number) || 30000, 60000);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: cfg.jarvis_path || process.cwd(),
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

export function registerShellBundle(rt: ToolRuntime): void {
  rt.register(BASH_DEF, (a, c) => handleBash(a, c));
}
