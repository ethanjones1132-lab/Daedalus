import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs, existsSync } from "fs";
import { join, resolve, relative } from "path";
import type { JarvisConfig } from "./config";
import { CONFIG_DIR } from "./config";
import { TOOL_TIMEOUT_REASON, type ExecutionContext } from "./tool-runtime";
import { ToolExecutionError } from "./tool-types";
import { buildLocalClaudeArgs, buildLocalClaudeEnv, resolveClaudePath } from "./claude-cli";

type TaskStatus = "running" | "completed" | "failed" | "stopped";

interface TaskRecord {
  id: string;
  description: string;
  prompt: string;
  agent_type: string;
  status: TaskStatus;
  cwd: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  output: string;
  error?: string;
  /** Per-task wall-clock bound in ms (background commands). */
  timeout_ms?: number;
}

interface RunningTask {
  proc?: ChildProcessWithoutNullStreams;
  abort?: AbortController;
  killTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Default wall-clock bound for `run_background_command`.
 * The old monitor only reaped bash children after 2 hours and only polled
 * every 60s — a non-terminating `python -c "while True"` stalled a Phase-D
 * campaign for 65 minutes. Five minutes is long enough for real background
 * work and short enough that a hung child cannot freeze a campaign.
 */
export const DEFAULT_BG_COMMAND_TIMEOUT_MS = 300_000;

/** Hard ceiling — models cannot request more than 30 minutes. */
export const MAX_BG_COMMAND_TIMEOUT_MS = 1_800_000;

/** Floor so a typo of 0/negative never disables the kill timer. */
export const MIN_BG_COMMAND_TIMEOUT_MS = 1_000;

/**
 * Resolve `timeout_ms` for a background command: default 5 min, clamp to
 * [1s, 30 min]. Exported for unit tests.
 */
export function resolveBackgroundCommandTimeoutMs(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : DEFAULT_BG_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(MIN_BG_COMMAND_TIMEOUT_MS, n), MAX_BG_COMMAND_TIMEOUT_MS);
}

const TASKS_FILE = join(CONFIG_DIR, "agent-tasks.json");
const runningTasks = new Map<string, RunningTask>();
const stoppingTasks = new Set<string>();

// ── Path Helpers for Background Spawning (WSL <-> Windows) ──

function toWslPath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, "/");
  for (const prefix of ["//wsl.localhost/", "//wsl$/"]) {
    if (normalized.startsWith(prefix)) {
      const parts = normalized.slice(prefix.length).split("/");
      return "/" + parts.slice(1).join("/");
    }
  }
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const subPath = driveMatch[2];
    return `/mnt/${drive}/${subPath}`;
  }
  return normalized;
}

function safePath(inputPath: string, cfg: JarvisConfig): string {
  const wslPath = toWslPath(inputPath);
  if (cfg.tools.sandbox_mode === "off") return resolve(wslPath);
  const workspace = resolve(toWslPath(cfg.jarvis_path && cfg.jarvis_path.trim() !== "" ? cfg.jarvis_path : process.cwd()));
  const resolved = resolve(workspace, wslPath);
  const rel = relative(workspace, resolved);
  if (cfg.tools.sandbox_mode === "permissive") {
    if (rel.startsWith("..") || rel.startsWith("/")) {
      console.log(`[Sandbox] Permissive mode: allowing access to "${resolved}" (outside workspace)`);
    }
    return resolved;
  }
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path "${inputPath}" is outside the workspace. Sandbox mode: ${cfg.tools.sandbox_mode}`);
  }
  return resolved;
}

function resolvePowerShellExecutable(): string {
  const candidates = [
    "/usr/bin/pwsh",
    "/usr/local/bin/pwsh",
    "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "pwsh",
    "powershell.exe",
  ];
  return candidates.find(candidate => candidate.includes("/") && existsSync(candidate)) || "pwsh";
}

function wslPathToWindowsUnc(path: string): string {
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  if (path.startsWith("/mnt/") && path.length > 6) {
    const drive = path[5].toUpperCase();
    return `${drive}:\\${path.slice(7).replace(/\//g, "\\")}`;
  }
  return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, "\\")}`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function booleanArg(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
  }
  return fallback;
}

// ── Background Command & Monitor Implementations ──

export async function toolRunBackgroundCommand(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const command = stringArg(args.command);
  if (!command) return "Error: command is required.";

  const isPowerShell = booleanArg(args.powershell ?? args.ps, false);
  const cwd = stringArg(args.cwd) || cfg.jarvis_path || cfg.jarvis_path;
  const description = stringArg(args.description) || `Background: ${command.slice(0, 80)}`;
  const timeoutMs = resolveBackgroundCommandTimeoutMs(args.timeout_ms);
  const taskId = `bg_${crypto.randomUUID().slice(0, 8)}`;

  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: taskId,
    description,
    prompt: command,
    agent_type: isPowerShell ? "powershell" : "bash",
    status: "running",
    cwd,
    created_at: now,
    updated_at: now,
    output: "",
    timeout_ms: timeoutMs,
  };

  await upsertTask(task);

  // Spawn the background process
  let proc: ChildProcessWithoutNullStreams;
  try {
    if (isPowerShell) {
      const shell = resolvePowerShellExecutable();
      const workspace = safePath(cwd, cfg);
      const isWindowsPowerShell = shell.toLowerCase().endsWith(".exe");
      const cwdCommand = isWindowsPowerShell
        ? `Set-Location -LiteralPath ${quotePowerShellString(wslPathToWindowsUnc(workspace))}; ${command}`
        : command;
      proc = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cwdCommand], {
        cwd: isWindowsPowerShell ? undefined : workspace,
        env: { ...process.env, PATH: process.env.PATH },
      });
    } else {
      proc = spawn("bash", ["-c", command], {
        cwd: safePath(cwd, cfg),
        env: { ...process.env, PATH: process.env.PATH },
      });
    }
  } catch (e: any) {
    task.status = "failed";
    task.error = `Failed to spawn process: ${e.message}`;
    task.completed_at = new Date().toISOString();
    task.updated_at = task.completed_at;
    await upsertTask(task);
    return `Error: Failed to spawn process: ${e.message}`;
  }

  // Buffers to throttle disk writes
  let outputBuffer = "";
  let writeTimeout: Timer | null = null;
  let timedOut = false;

  const flushOutput = async () => {
    if (!outputBuffer) return;
    const currentTask = await getTask(taskId);
    if (currentTask && currentTask.status === "running") {
      currentTask.output += outputBuffer;
      outputBuffer = "";
      currentTask.updated_at = new Date().toISOString();
      await upsertTask(currentTask);
    }
  };

  const queueOutput = (data: string) => {
    outputBuffer += data;
    if (!writeTimeout) {
      writeTimeout = setTimeout(async () => {
        writeTimeout = null;
        await flushOutput();
      }, 500);
    }
  };

  const clearKillTimer = () => {
    const rt = runningTasks.get(taskId);
    if (rt?.killTimer) {
      clearTimeout(rt.killTimer);
      rt.killTimer = undefined;
    }
  };

  // Per-process kill timer — does not depend on the 60s task monitor poll.
  // This is the load-bearing fix for non-terminating fixture-suite children.
  const killTimer = setTimeout(() => {
    timedOut = true;
    const rt = runningTasks.get(taskId);
    if (!rt?.proc) return;
    console.warn(
      `[Jarvis] Background command ${taskId} hit timeout_ms=${timeoutMs}; terminating.`,
    );
    try {
      rt.proc.kill("SIGTERM");
    } catch {
      // Process may already be exiting.
    }
    // Windows often needs a hard kill if SIGTERM is ignored.
    setTimeout(() => {
      try {
        if (!rt.proc?.killed) rt.proc?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2_000).unref?.();
  }, timeoutMs);
  killTimer.unref?.();

  runningTasks.set(taskId, { proc, killTimer });

  proc.stdout?.on("data", (d) => { queueOutput(d.toString()); });
  proc.stderr?.on("data", (d) => { queueOutput(d.toString()); });

  proc.on("close", async (code) => {
    clearKillTimer();
    if (writeTimeout) {
      clearTimeout(writeTimeout);
      writeTimeout = null;
    }
    await flushOutput();

    const currentTask = await getTask(taskId);
    if (currentTask && currentTask.status === "running") {
      if (timedOut) {
        currentTask.status = "failed";
        currentTask.error = `Background command timed out after ${timeoutMs}ms.`;
      } else {
        currentTask.status = code === 0 ? "completed" : "failed";
        if (code !== 0) {
          currentTask.error = `Process exited with code ${code}`;
        }
      }
      currentTask.completed_at = new Date().toISOString();
      currentTask.updated_at = currentTask.completed_at;
      await upsertTask(currentTask);
    }
    runningTasks.delete(taskId);
  });

  proc.on("error", async (err) => {
    clearKillTimer();
    if (writeTimeout) {
      clearTimeout(writeTimeout);
      writeTimeout = null;
    }
    await flushOutput();

    const currentTask = await getTask(taskId);
    if (currentTask && currentTask.status === "running") {
      currentTask.status = "failed";
      currentTask.error = err.message;
      currentTask.completed_at = new Date().toISOString();
      currentTask.updated_at = currentTask.completed_at;
      await upsertTask(currentTask);
    }
    runningTasks.delete(taskId);
  });

  return (
    `Background command started. Task ID: ${taskId}. ` +
    `Timeout: ${timeoutMs}ms. ` +
    `You can check progress using task_get or task_output tools.`
  );
}

export function startTaskMonitor(): void {
  // Check tasks every 60 seconds
  setInterval(async () => {
    try {
      const now = new Date();
      const tasks = await loadTasks();
      let changed = false;

      for (const [id, rt] of runningTasks.entries()) {
        const task = tasks.find(t => t.id === id);
        if (!task) continue;

        const createdTime = new Date(task.created_at);
        const elapsedMs = now.getTime() - createdTime.getTime();

        // Timeout limits:
        // Background commands: per-task timeout_ms (default 5 min) — the spawn
        // path also arms an immediate kill timer; this monitor is a backstop.
        // Background agent tasks: 15 minutes (900000 ms)
        const isAgent = task.agent_type !== "bash" && task.agent_type !== "powershell";
        const limitMs = isAgent
          ? 900_000
          : (task.timeout_ms ?? DEFAULT_BG_COMMAND_TIMEOUT_MS);

        if (elapsedMs > limitMs) {
          console.warn(`[Jarvis Task Monitor] Task ${id} timed out. Terminating.`);
          stoppingTasks.add(id);
          if (rt.killTimer) clearTimeout(rt.killTimer);
          if (rt.proc) rt.proc.kill("SIGTERM");
          if (rt.abort) rt.abort.abort();
          runningTasks.delete(id);

          task.status = "failed";
          task.error = `Task timed out after ${Math.round(limitMs / 1000)}s.`;
          task.completed_at = now.toISOString();
          task.updated_at = task.completed_at;
          changed = true;
        }
      }

      if (changed) {
        await saveTasks(tasks);
      }
    } catch (e) {
      console.error("[Jarvis Task Monitor] Monitor error:", e);
    }
  }, 60000);
}

export async function toolAgent(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
  ctx?: ExecutionContext,
): Promise<string> {
  const description = stringArg(args.description) || "Agent task";
  const prompt = stringArg(args.prompt ?? args.task ?? args.input);
  const agentType = stringArg(args.subagent_type ?? args.agent_type ?? args.type) || "general";
  const requestedTimeout = numberArg(args.timeout_ms, Math.min(cfg.claude_cli.timeout_ms || 120000, 180000));
  const timeoutMs = typeof ctx?.timeout_ms === "number" && Number.isFinite(ctx.timeout_ms) && ctx.timeout_ms > 0
    ? Math.min(requestedTimeout, Math.floor(ctx.timeout_ms))
    : requestedTimeout;

  if (!prompt) throw new ToolExecutionError("execution_error", "agent requires a prompt");
  if (ctx?.signal?.aborted) {
    const code = ctx.signal.reason === TOOL_TIMEOUT_REASON ? "timeout" : "cancelled";
    throw new ToolExecutionError(code, code === "timeout" ? "Agent execution timed out" : "Agent execution cancelled");
  }

  const wrappedPrompt = buildAgentPrompt(agentType, description, prompt);
  const result = await runPromptOnce(wrappedPrompt, cfg, timeoutMs, undefined, ctx?.signal);
  if (isErrorResult(result)) {
    throw new ToolExecutionError("execution_error", `agent ${agentType} failed: ${result}`);
  }
  return `Agent ${agentType} completed:\n\n${result}`;
}

export async function toolTaskCreate(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const prompt = stringArg(args.prompt ?? args.task ?? args.input);
  if (!prompt) return "Error: task_create requires a prompt.";

  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: stringArg(args.id) || `task_${crypto.randomUUID().slice(0, 8)}`,
    description: stringArg(args.description) || prompt.slice(0, 120),
    prompt,
    agent_type: stringArg(args.subagent_type ?? args.agent_type ?? args.type) || "general",
    status: "running",
    cwd: stringArg(args.cwd) || cfg.jarvis_path || cfg.jarvis_path,
    created_at: now,
    updated_at: now,
    output: "",
  };

  await upsertTask(task);
  void runTask(task, cfg);

  return `Created task ${task.id} (${task.agent_type}): ${task.description}`;
}

export async function toolTaskList(args: Record<string, unknown>): Promise<string> {
  const status = stringArg(args.status) as TaskStatus | "";
  const tasks = await loadTasks();
  const filtered = status ? tasks.filter(task => task.status === status) : tasks;
  if (filtered.length === 0) return "No tasks found.";

  return filtered
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(task => `${task.id} [${task.status}] ${task.agent_type} - ${task.description} (${task.updated_at})`)
    .join("\n");
}

export async function toolTaskGet(args: Record<string, unknown>): Promise<string> {
  const id = stringArg(args.id ?? args.task_id);
  if (!id) throw new ToolExecutionError("execution_error", "task_get requires id");
  const task = (await loadTasks()).find(item => item.id === id);
  if (!task) throw new ToolExecutionError("execution_error", `task ${id} not found`);
  const outputPreview = task.output ? `\n\nOutput preview:\n${tail(task.output, 4000)}` : "";
  return JSON.stringify({ ...task, output: undefined }, null, 2) + outputPreview;
}

export async function toolTaskOutput(args: Record<string, unknown>): Promise<string> {
  const id = stringArg(args.id ?? args.task_id);
  if (!id) throw new ToolExecutionError("execution_error", "task_output requires id");
  const limit = numberArg(args.limit, 12000);
  const offset = numberArg(args.offset, 0);
  const pattern = stringArg(args.pattern);

  const task = (await loadTasks()).find(item => item.id === id);
  if (!task) throw new ToolExecutionError("execution_error", `task ${id} not found`);
  if (!task.output) return `(task ${id} has no output yet)`;

  let output = task.output;

  // Apply line filtering if pattern is present
  if (pattern) {
    const lines = output.split("\n");
    try {
      const regex = new RegExp(pattern, "i");
      output = lines.filter(line => regex.test(line)).join("\n");
      if (output.length === 0) return `(no output lines matched pattern "${pattern}")`;
    } catch (e: any) {
      // Fallback to simple substring match if regex is invalid
      output = lines.filter(line => line.toLowerCase().includes(pattern.toLowerCase())).join("\n");
      if (output.length === 0) return `(no output lines matched pattern "${pattern}")`;
    }
  }

  // Apply offset and limit
  let start = 0;
  if (offset < 0) {
    start = Math.max(0, output.length + offset);
  } else {
    start = Math.min(output.length, offset);
  }

  const sliced = output.slice(start, start + limit);
  const prefix = start > 0 ? `... [showing from char ${start}] ...\n` : "";
  const suffix = start + limit < output.length ? `\n... [truncated, ${output.length - (start + limit)} more chars] ...` : "";

  return prefix + sliced + suffix;
}


export async function toolTaskStop(args: Record<string, unknown>): Promise<string> {
  const id = stringArg(args.id ?? args.task_id);
  if (!id) throw new ToolExecutionError("execution_error", "task_stop requires id");

  const running = runningTasks.get(id);
  stoppingTasks.add(id);
  if (running?.proc) running.proc.kill("SIGTERM");
  if (running?.abort) running.abort.abort();
  runningTasks.delete(id);

  const tasks = await loadTasks();
  const task = tasks.find(item => item.id === id);
  if (!task) {
    stoppingTasks.delete(id);
    throw new ToolExecutionError("execution_error", `task ${id} not found`);
  }
  if (task.status !== "running") {
    stoppingTasks.delete(id);
    return `Task ${id} is already ${task.status}.`;
  }
  task.status = "stopped";
  task.updated_at = new Date().toISOString();
  task.completed_at = task.updated_at;
  await saveTasks(tasks);
  return `Stopped task ${id}.`;
}

async function runTask(task: TaskRecord, cfg: JarvisConfig): Promise<void> {
  try {
    if (await isTaskStopped(task.id) || stoppingTasks.has(task.id)) return;
    const output = await runPromptOnce(
      buildAgentPrompt(task.agent_type, task.description, task.prompt),
      { ...cfg, jarvis_path: task.cwd },
      cfg.claude_cli.timeout_ms || 120000,
      task.id,
    );
    task.output = output;
    task.status = isErrorResult(output) ? "failed" : "completed";
    if (task.status === "failed") task.error = output;
  } catch (e: any) {
    task.status = (await isTaskStopped(task.id)) || stoppingTasks.has(task.id) ? "stopped" : "failed";
    task.error = e?.message || String(e);
    if (task.status === "failed") task.output += task.error ? `\n${task.error}` : "";
  } finally {
    runningTasks.delete(task.id);
    const persisted = await getTask(task.id);
    const shouldStayStopped = stoppingTasks.has(task.id) || persisted?.status === "stopped";
    const finalTask = shouldStayStopped && persisted ? { ...persisted, status: "stopped" as const } : task;
    if (shouldStayStopped && task.output) {
      finalTask.output = task.output;
    }
    if (shouldStayStopped && task.error) {
      finalTask.error = task.error;
    }
    finalTask.completed_at = finalTask.completed_at || new Date().toISOString();
    finalTask.updated_at = new Date().toISOString();
    await upsertTask(finalTask);
    stoppingTasks.delete(task.id);
  }
}

async function runPromptOnce(
  prompt: string,
  cfg: JarvisConfig,
  timeoutMs: number,
  taskId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (cfg.claude_cli.enabled) {
    const cliOutput = await runClaudeCliPrompt(prompt, cfg, timeoutMs, taskId, signal);
    if (!cliOutput.startsWith("Error:")) return cliOutput;
  }
  return runModelPrompt(prompt, cfg, timeoutMs, taskId, signal);
}

async function runClaudeCliPrompt(
  prompt: string,
  cfg: JarvisConfig,
  timeoutMs: number,
  taskId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const launchOptions = { authMode: cfg.claude_cli.auth_mode };
  const args = buildLocalClaudeArgs([...(cfg.claude_cli.args || []), prompt], launchOptions);
  const resolvedPath = resolveClaudePath(cfg.claude_cli.path);
  if (signal?.aborted) {
    const code = signal.reason === TOOL_TIMEOUT_REASON ? "timeout" : "cancelled";
    throw new ToolExecutionError(code, code === "timeout" ? "Agent execution timed out" : "Agent execution cancelled");
  }

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(resolvedPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: cfg.jarvis_path || cfg.claude_cli.cwd || cfg.jarvis_path,
        env: {
          ...buildLocalClaudeEnv(process.env, launchOptions),
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        },
        detached: process.platform !== "win32",
      });
    } catch (error: any) {
      resolve(`Error: Failed to spawn Claude CLI: ${error?.message ?? String(error)}`);
      return;
    }
    if (taskId) runningTasks.set(taskId, { proc });
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";
    let closed = false;
    let timedOut = false;
    let cancelled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (kind: "timeout" | "cancelled"): void => {
      if (closed) return;
      if (kind === "timeout") timedOut = true;
      else cancelled = true;
      try { proc.kill("SIGTERM"); } catch {}
      hardKillTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 250);
      hardKillTimer.unref?.();
    };

    onAbort = (): void => stop(signal?.reason === TOOL_TIMEOUT_REASON ? "timeout" : "cancelled");
    timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.stdout?.on("data", d => { stdout = (stdout + d.toString()).slice(-12_000); });
    proc.stderr?.on("data", d => { stderr = (stderr + d.toString()).slice(-4_000); });
    proc.once("close", code => {
      if (closed) return;
      closed = true;
      cleanup();
      if (cancelled) {
        reject(new ToolExecutionError("cancelled", "Agent execution cancelled"));
        return;
      }
      if (timedOut) {
        reject(new ToolExecutionError("timeout", `Agent execution timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve(extractClaudeText(stdout) || stdout.trim() || "(no output)");
      } else {
        resolve(`Error: Claude CLI exited with code ${code}${stderr ? `:\n${stderr}` : ""}`);
      }
    });
    proc.once("error", error => {
      if (closed) return;
      closed = true;
      cleanup();
      resolve(`Error: Failed to spawn Claude CLI: ${error.message}`);
    });
  });
}

async function runModelPrompt(
  prompt: string,
  cfg: JarvisConfig,
  timeoutMs: number,
  taskId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const abort = new AbortController();
  let timedOut = false;
  const onAbort = (): void => {
    if (signal?.reason === TOOL_TIMEOUT_REASON || timedOut) return;
    abort.abort(signal?.reason);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort(TOOL_TIMEOUT_REASON);
  }, timeoutMs);
  if (taskId) runningTasks.set(taskId, { abort });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const isLlamaCpp = cfg.active_backend === "llama_cpp";
    const isOllama = cfg.active_backend !== "openrouter" && !isLlamaCpp;
    const baseUrl = isLlamaCpp ? cfg.llama_cpp.base_url : isOllama ? cfg.ollama.base_url : cfg.openrouter.base_url;
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        ...(isOllama ? { "Authorization": "Bearer ollama" } : {}),
        ...(!isOllama && !isLlamaCpp ? { "Authorization": `Bearer ${cfg.openrouter.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: isLlamaCpp ? cfg.llama_cpp.model : isOllama ? cfg.ollama.model : cfg.openrouter.model,
        stream: false,
        temperature: cfg.temperature,
        max_tokens: isLlamaCpp ? Math.max(4096, cfg.max_tokens) : cfg.max_tokens,
        ...(isLlamaCpp ? { cache_prompt: true } : {}),
        messages: [
          { role: "system", content: "You are a Jarvis sub-agent. Complete the delegated task and return concise findings with evidence." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new ToolExecutionError("execution_error", `model request failed (${res.status}): ${(await res.text()).slice(0, 1000)}`);
    }
    const json = await res.json();
    if (signal?.aborted || timedOut) {
      throw new ToolExecutionError(timedOut ? "timeout" : "cancelled", timedOut ? "Agent execution timed out" : "Agent execution cancelled");
    }
    return json.choices?.[0]?.message?.content || JSON.stringify(json).slice(0, 12000);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    if (timedOut) throw new ToolExecutionError("timeout", `Agent execution timed out after ${timeoutMs}ms`);
    if (signal?.aborted) throw new ToolExecutionError("cancelled", "Agent execution cancelled");
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolExecutionError("execution_error", `Agent model request failed: ${message}`, message);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function buildAgentPrompt(agentType: string, description: string, prompt: string): string {
  return [
    `Agent type: ${agentType}`,
    `Task: ${description}`,
    "",
    "Instructions:",
    "- Work independently and return only the useful result.",
    "- Include files, commands, or sources you used when relevant.",
    "- If you cannot complete the task, explain the blocker precisely.",
    "",
    prompt,
  ].join("\n");
}

function extractClaudeText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (typeof msg.result === "string") {
        parts.push(msg.result);
      } else if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
        }
      }
    } catch {
      parts.push(trimmed);
    }
  }
  return parts.join("\n").trim();
}

async function loadTasks(): Promise<TaskRecord[]> {
  try {
    return JSON.parse(await fs.readFile(TASKS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

async function getTask(id: string): Promise<TaskRecord | undefined> {
  return (await loadTasks()).find(task => task.id === id);
}

async function isTaskStopped(id: string): Promise<boolean> {
  return (await getTask(id))?.status === "stopped";
}

async function saveTasks(tasks: TaskRecord[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks.slice(-200), null, 2), "utf-8");
}

async function upsertTask(task: TaskRecord): Promise<void> {
  const tasks = await loadTasks();
  const index = tasks.findIndex(item => item.id === task.id);
  if (index >= 0) tasks[index] = task;
  else tasks.push(task);
  await saveTasks(tasks);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isErrorResult(value: string): boolean {
  return /^(Error:|Failed to fetch|Exit code)/.test(value.trim());
}

function tail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(value.length - limit);
}
