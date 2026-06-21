// ═══════════════════════════════════════════════════════════════
// ── Claude Code CLI Integration ──
// ═══════════════════════════════════════════════════════════════
// Spawns the Claude Code CLI as a subprocess, captures streaming JSON output,
// and bridges it into the Jarvis SSE event stream.

import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
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

export function resolveClaudePath(configPath: string): string {
  if (configPath && configPath !== "claude" && existsSync(configPath)) {
    return configPath;
  }
  const fallbacks = [
    "/home/ethan/.nvm/versions/node/v20/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) {
      return p;
    }
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
  content?: string | Array<Record<string, unknown>>;
  result?: string;
  delta?: { text: string };
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

  const args = buildLocalClaudeArgs([...(cliCfg.args || [])]);
  // Prompt is passed as a positional argument (not --prompt flag)
  args.push(req.prompt);

  if (req.session_id) args.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options
  if (req.max_turns) args.push("--max-turns", String(req.max_turns));

  return new Promise((resolve) => {
    // Use localhost for Ollama — subprocess runs in WSL, same as Bun server
    const localOnlyEnv = {
      ...buildLocalClaudeEnv(),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };

    const resolvedPath = resolveClaudePath(cliCfg.path);
    const proc = spawn(resolvedPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: localOnlyEnv,
      timeout: cliCfg.timeout_ms,
      cwd: req.cwd || cliCfg.cwd,
    });

    // Close stdin immediately — CLI should use positional prompt arg, not stdin
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
): AsyncGenerator<ClaudeStreamEvent> {
  const cliCfg = cfg.claude_cli;

  // Use provided cliArgs (which may include --append-system-prompt) or fall back to cfg defaults
  const args = buildLocalClaudeArgs([...(req.cliArgs || cliCfg.args || [])]);
  // Prompt is passed as a positional argument (not --prompt flag)
  args.push(req.prompt);

  if (req.session_id) args.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options below

  yield { type: "init", session_id: req.session_id || crypto.randomUUID() };

  // Use localhost for Ollama — Bun server runs in WSL, Claude CLI subprocess
  // also runs in WSL, so localhost reaches WSL's Ollama directly.
  // The Windows host IP is only needed for the HTTP server's own Ollama calls
  // (via resolveWindowsHostIP), not for spawned subprocesses.
  const streamEnv = buildLocalClaudeEnv();

  const resolvedPath = resolveClaudePath(cliCfg.path);
  const proc = spawn(resolvedPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: streamEnv,
    cwd: req.cwd || cliCfg.cwd,
  });

  // Close stdin immediately — CLI should use positional prompt arg, not stdin
  proc.stdin?.end();

  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";

  const stdoutIterator = proc.stdout![Symbol.asyncIterator]();

  try {
    while (true) {
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
              // The CLI's result event contains the full text in msg.result
              // (assistant events may have empty content strings in stream-json mode)
              const resultText = msg.result || fullOutput || "";
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
    proc.kill();
  }
}
