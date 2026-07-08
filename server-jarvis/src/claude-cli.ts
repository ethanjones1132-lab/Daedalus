// ═══════════════════════════════════════════════════════════════
// ── Claude Code CLI Integration ──
// ═══════════════════════════════════════════════════════════════
// Spawns the Claude Code CLI as a subprocess, captures streaming JSON output,
// and bridges it into the Jarvis SSE event stream.

import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { JarvisConfig } from "./config";

const LOCAL_PROXY_BASE_URL = "http://127.0.0.1:19878";
const LOCAL_CLAUDE_CONFIG_DIR =
  process.env.JARVIS_CLAUDE_CONFIG_DIR ||
  join(homedir(), ".openclaw", "jarvis", "hermes", "claude-local-config");

const CREDENTIAL_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
const CREDENTIAL_ENV_KEYS = new Set([
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]);

// ── Path Resolution ──

function discoverClaudeOnPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
  } catch {
    // not on PATH
  }
  return null;
}

export function resolveClaudePath(configPath: string): string {
  if (configPath && configPath !== "claude" && existsSync(configPath)) {
    return configPath;
  }
  const onPath = discoverClaudeOnPath();
  if (onPath) return onPath;
  const fallbacks = ["/usr/local/bin/claude", "/usr/bin/claude"];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return configPath || "claude";
}

export function buildLocalClaudeEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV_KEYS.has(key)) continue;
    if (CREDENTIAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  mkdirSync(LOCAL_CLAUDE_CONFIG_DIR, { recursive: true });

  return {
    ...env,
    OPENCLAW_JARVIS: "true",
    ANTHROPIC_API_KEY: "ollama",
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_BASE_URL: LOCAL_PROXY_BASE_URL,
    CLAUDE_CONFIG_DIR: LOCAL_CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_USE_LOCAL_MODEL: "1",
    CLAUDE_CODE_DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    NO_PROXY: appendNoProxy(env.NO_PROXY),
    no_proxy: appendNoProxy(env.no_proxy),
  };
}

export function buildLocalClaudeArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes("--bare")) {
    next.unshift("--bare");
  }
  if (!next.includes("--no-telemetry")) {
    next.push("--no-telemetry");
  }
  return next;
}

function appendNoProxy(existing: string | undefined): string {
  const required = ["127.0.0.1", "localhost"];
  const parts = new Set(
    (existing || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  for (const value of required) parts.add(value);
  return Array.from(parts).join(",");
}

/** Windows CreateProcess limit is 8191 chars; leave headroom for quoting. */
export const WINDOWS_CMDLINE_BUDGET = 7500;

function quoteArgForCmdline(arg: string): string {
  if (!/[ \t"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function estimateCommandLineLength(executable: string, args: string[]): number {
  return [executable, ...args.map(quoteArgForCmdline)].join(" ").length;
}

export interface ClaudeCliInvocation {
  args: string[];
  /** When true, the user prompt is written to stdin (not a positional arg). */
  promptOnStdin: boolean;
  cleanup: () => void;
}

/**
 * Avoid Windows "The command line is too long" when system prompt + history
 * are passed as CLI flags/positionals. Large --append-system-prompt values go
 * to temp files; oversized user prompts use stdin with --print.
 */
export function prepareClaudeCliInvocation(
  executable: string,
  cliArgs: string[],
  prompt: string,
): ClaudeCliInvocation {
  const cleanupDirs: string[] = [];
  const cleanup = () => {
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  const args = [...cliArgs];

  const rewriteInlinePromptFlag = (inlineFlag: string, fileFlag: string) => {
    const idx = args.indexOf(inlineFlag);
    if (idx === -1 || idx >= args.length - 1) return;
    const content = args[idx + 1];
    if (!content || content.length < 512) return;
    const dir = mkdtempSync(join(tmpdir(), "jarvis-cli-"));
    const filePath = join(dir, "prompt.txt");
    writeFileSync(filePath, content, "utf8");
    cleanupDirs.push(dir);
    args.splice(idx, 2, fileFlag, filePath);
  };

  rewriteInlinePromptFlag("--append-system-prompt", "--append-system-prompt-file");
  rewriteInlinePromptFlag("--system-prompt", "--system-prompt-file");

  ensureStreamJsonVerbose(args);

  const withPositionalPrompt = [...args, prompt];
  const overBudget =
    process.platform === "win32" &&
    estimateCommandLineLength(executable, withPositionalPrompt) > WINDOWS_CMDLINE_BUDGET;

  if (overBudget || (process.platform === "win32" && prompt.length > 2000)) {
    return { args, promptOnStdin: true, cleanup };
  }

  return { args: withPositionalPrompt, promptOnStdin: false, cleanup };
}

function ensureStreamJsonVerbose(args: string[]): void {
  const fmtIdx = args.indexOf("--output-format");
  const usesStreamJson =
    fmtIdx !== -1 && fmtIdx < args.length - 1 && args[fmtIdx + 1] === "stream-json";
  if (usesStreamJson && !args.includes("--verbose")) {
    args.push("--verbose");
  }
}

export function compactTurnHistoryForCli<T extends { role: string; content: string }>(
  turnHistory: T[],
  maxChars: number,
): T[] {
  if (maxChars <= 0 || turnHistory.length === 0) return turnHistory;
  let total = 0;
  const kept: T[] = [];
  for (let i = turnHistory.length - 1; i >= 0; i--) {
    const m = turnHistory[i];
    const piece =
      m.role === "tool"
        ? `tool response:\n${m.content}\n\n`
        : `${m.role}: ${m.content}\n\n`;
    if (total + piece.length > maxChars && kept.length > 0) break;
    kept.unshift(m);
    total += piece.length;
  }
  return kept;
}

// ── Types ──

export interface ClaudeCliRequest {
  prompt: string;
  session_id?: string;
  cwd?: string;
  max_turns?: number;
  cliArgs?: string[];
}

export interface ClaudeCliMessage {
  type: string;
  content?: string | Array<{ type?: string; text?: string }>;
  delta?: { text: string };
  result?: string;
  session_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  tool_use?: { name: string; input: Record<string, unknown> };
  tool_result?: { content: string; is_error?: boolean };
  [key: string]: unknown;
}

// ── Check Availability ──

export async function isClaudeCliAvailable(path: string): Promise<boolean> {
  const resolved = resolveClaudePath(path);
  return new Promise((resolve) => {
    const proc = spawn(resolved, ["--version"], {
      timeout: 5000,
      env: buildLocalClaudeEnv(),
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

// ── Invoke (one-shot, returns full response) ──

export async function invokeClaudeCli(
  cfg: JarvisConfig,
  req: ClaudeCliRequest,
): Promise<{ success: boolean; output: string; session_id?: string; error?: string; tokens_used?: number }> {
  const cliCfg = cfg.claude_cli;

  const baseArgs = buildLocalClaudeArgs([...(cliCfg.args || [])]);
  if (req.session_id) baseArgs.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options
  if (req.max_turns) baseArgs.push("--max-turns", String(req.max_turns));

  const resolvedPath = resolveClaudePath(cliCfg.path);
  const { args, promptOnStdin, cleanup } = prepareClaudeCliInvocation(
    resolvedPath,
    baseArgs,
    req.prompt,
  );

  return new Promise((resolve) => {
    // Use localhost for Ollama — subprocess runs in WSL, same as Bun server
    const localOnlyEnv = {
      ...buildLocalClaudeEnv(),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };

    const proc = spawn(resolvedPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: localOnlyEnv,
      timeout: cliCfg.timeout_ms,
      cwd: req.cwd || cliCfg.cwd,
    });

    if (promptOnStdin) {
      proc.stdin?.write(req.prompt, "utf8");
    }
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, cliCfg.timeout_ms);

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      cleanup();
      if (timedOut) {
        resolve({ success: false, output: "", error: `Claude CLI timed out after ${cliCfg.timeout_ms}ms` });
        return;
      }
      if (code === 0) {
        // Try to parse the last JSON line for structured output
        const lines = stdout.trim().split("\n");
        let sessionId: string | undefined;
        let tokensUsed: number | undefined;

        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.session_id) sessionId = parsed.session_id;
            if (parsed.usage) tokensUsed = (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0);
          } catch { /* skip */ }
        }

        resolve({ success: true, output: stdout, session_id: sessionId, tokens_used: tokensUsed });
      } else {
        resolve({ success: false, output: "", error: stderr || `Claude CLI exited with code ${code}` });
      }
    });

    proc.on("error", (e) => {
      clearTimeout(timeout);
      cleanup();
      resolve({ success: false, output: "", error: `Failed to spawn Claude CLI: ${e.message}` });
    });
  });
}

// ── Stream Invoke (yields SSE events) ──

export interface ClaudeStreamEvent {
  type: "init" | "stream_event" | "tool_use" | "tool_result" | "message_stop" | "error" | "result";
  content?: string;
  delta?: { text: string };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  session_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export async function* streamClaudeCli(
  cfg: JarvisConfig,
  req: ClaudeCliRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<ClaudeStreamEvent> {
  const cliCfg = cfg.claude_cli;

  // Use provided cliArgs (which may include --append-system-prompt) or fall back to cfg defaults
  const baseArgs = buildLocalClaudeArgs([...(req.cliArgs || cliCfg.args || [])]);
  if (req.session_id) baseArgs.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options below

  const resolvedPath = resolveClaudePath(cliCfg.path);
  const { args, promptOnStdin, cleanup } = prepareClaudeCliInvocation(
    resolvedPath,
    baseArgs,
    req.prompt,
  );

  yield { type: "init", session_id: req.session_id || crypto.randomUUID() };

  // Use localhost for Ollama — Bun server runs in WSL, Claude CLI subprocess
  // also runs in WSL, so localhost reaches WSL's Ollama directly.
  // The Windows host IP is only needed for the HTTP server's own Ollama calls
  // (via resolveWindowsHostIP), not for spawned subprocesses.
  const streamEnv = buildLocalClaudeEnv();

  const proc = spawn(resolvedPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: streamEnv,
    cwd: req.cwd || cliCfg.cwd,
  });

  const spawnError = await new Promise<Error | undefined>((resolve) => {
    proc.once("error", (err) => resolve(err));
    proc.once("spawn", () => resolve(undefined));
  });
  if (spawnError) {
    cleanup();
    yield { type: "error", error: spawnError.message };
    return;
  }

  if (promptOnStdin) {
    proc.stdin?.write(req.prompt, "utf8");
  }
  proc.stdin?.end();

  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";

  const stdoutIterator = proc.stdout![Symbol.asyncIterator]();
  const onAbort = () => {
    try { proc.kill(); } catch {}
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      proc.kill();
      return;
    }
    abortSignal.addEventListener("abort", onAbort);
  }

  try {
    while (true) {
      if (abortSignal?.aborted) {
        return;
      }
      const { done, value } = await stdoutIterator.next();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg: ClaudeCliMessage = JSON.parse(trimmed);

          switch (msg.type) {
            case "assistant": {
              // Content can be a string or an array of content blocks
              let text = "";
              if (typeof msg.content === "string") {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block && typeof block === "object" && block.type === "text" && block.text) {
                    text += block.text;
                  }
                }
              }
              if (text) {
                fullOutput += text;
                yield { type: "stream_event", delta: { text }, session_id: msg.session_id };
              }
              break;
            }
            case "stream_event": {
              if (msg.delta?.text) {
                fullOutput += msg.delta.text;
                yield { type: "stream_event", delta: msg.delta, session_id: msg.session_id };
              }
              break;
            }
            case "tool_use": {
              yield {
                type: "tool_use",
                tool_name: msg.tool_use?.name || "unknown",
                tool_input: msg.tool_use?.input || {},
                session_id: msg.session_id,
              };
              break;
            }
            case "tool_result": {
              yield {
                type: "tool_result",
                tool_output: msg.tool_result?.content || "",
                session_id: msg.session_id,
              };
              break;
            }
            case "result": {
              const resultText = typeof msg.result === "string" ? msg.result : fullOutput || "";
              yield {
                type: "result",
                content: resultText,
                session_id: msg.session_id,
                usage: msg.usage,
              };
              break;
            }
          }
        } catch {
          // Non-JSON line — treat as plain text
          if (trimmed.length > 0) {
            fullOutput += trimmed + "\n";
            yield { type: "stream_event", delta: { text: trimmed + "\n" } };
          }
        }
      }
    }

    // Check stderr for errors
    let stderr = "";
    for await (const chunk of proc.stderr!) {
      stderr += decoder.decode(chunk, { stream: true });
    }

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => resolve(code || 0));
    });

    if (exitCode !== 0 && stderr) {
      yield { type: "error", error: stderr.slice(0, 500) };
    } else {
      yield { type: "message_stop", session_id: req.session_id };
    }
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener("abort", onAbort);
    }
    cleanup();
    proc.kill();
  }
}
