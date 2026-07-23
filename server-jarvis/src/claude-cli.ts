// ═══════════════════════════════════════════════════════════════
// ── Claude Code CLI Integration ──
// ═══════════════════════════════════════════════════════════════
// Spawns the Claude Code CLI as a subprocess, captures streaming JSON output,
// and bridges it into the Jarvis SSE event stream.

import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { JarvisConfig } from "./config";
import { openCodeGoProtocolForModel } from "./orchestration/live-model-catalog";

const LOCAL_PROXY_BASE_URL = "http://127.0.0.1:19878";
const OPENCODE_GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const LOCAL_CLAUDE_CONFIG_DIR =
  process.env.JARVIS_CLAUDE_CONFIG_DIR ||
  join(homedir(), ".openclaw", "jarvis", "hermes", "claude-local-config");

const CREDENTIAL_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
const CREDENTIAL_ENV_KEYS = new Set([
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]);

/** Effective launch mode for a Claude CLI subprocess. `opencode_go` is resolved
 *  at the call site for Anthropic-native OpenCode Go models — it is not a
 *  user-facing config.claude_cli.auth_mode value. */
export type ClaudeCliAuthMode = "proxy" | "subscription" | "opencode_go";

export interface ClaudeCliLaunchOptions {
  authMode: ClaudeCliAuthMode;
  /** OpenCode Go API key used when authMode is `opencode_go`. */
  opencodeGoApiKey?: string;
  /** OpenCode Go base URL; defaults to https://opencode.ai/zen/go/v1. */
  opencodeGoBaseUrl?: string;
}

export interface ResolveClaudeCliLaunchOptionsInput {
  authMode: "proxy" | "subscription";
  modelId?: string;
  opencodeGoApiKey?: string;
  opencodeGoBaseUrl?: string;
}

/**
 * Map configured auth mode + model to the effective CLI launch contract.
 * Anthropic-native OpenCode Go models skip the Python proxy and talk to
 * OpenCode Go's `/messages` surface point-to-point (same pattern as subscription).
 */
export function resolveClaudeCliLaunchOptions(
  input: ResolveClaudeCliLaunchOptionsInput,
): ClaudeCliLaunchOptions {
  if (input.authMode === "subscription") {
    return { authMode: "subscription" };
  }
  const modelId = input.modelId?.trim() ?? "";
  if (modelId && openCodeGoProtocolForModel(modelId) === "anthropic") {
    return {
      authMode: "opencode_go",
      opencodeGoApiKey: input.opencodeGoApiKey ?? "",
      opencodeGoBaseUrl: input.opencodeGoBaseUrl,
    };
  }
  return { authMode: "proxy" };
}

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

function stripCredentialEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV_KEYS.has(key)) continue;
    if (CREDENTIAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

export function buildLocalClaudeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: ClaudeCliLaunchOptions = { authMode: "proxy" },
): Record<string, string> {
  const { authMode } = options;
  if (authMode === "subscription") {
    return Object.fromEntries(
      Object.entries(baseEnv).filter((entry): entry is [string, string] => {
        const [key, value] = entry;
        if (value === undefined) return false;
        if (key === "ANTHROPIC_BASE_URL" && value === LOCAL_PROXY_BASE_URL) return false;
        if (key === "CLAUDE_CONFIG_DIR" && value === LOCAL_CLAUDE_CONFIG_DIR) return false;
        return true;
      }),
    );
  }

  if (authMode === "opencode_go") {
    // Point-to-point OpenCode Go: same credential stripping as proxy, then pin
    // Anthropic-compatible base URL + API key (Claude CLI sends it as x-api-key).
    const env = stripCredentialEnv(baseEnv);
    const baseUrl = (options.opencodeGoBaseUrl || OPENCODE_GO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    return {
      ...env,
      ANTHROPIC_API_KEY: options.opencodeGoApiKey ?? "",
      ANTHROPIC_BASE_URL: baseUrl,
    };
  }

  const env = stripCredentialEnv(baseEnv);

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

export function buildLocalClaudeArgs(
  args: string[],
  { authMode }: ClaudeCliLaunchOptions = { authMode: "proxy" },
): string[] {
  const next: string[] = [];
  // opencode_go is point-to-point like subscription: no --bare local-model mode.
  const stripBare = authMode === "subscription" || authMode === "opencode_go";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--max-turns") {
      index += 1;
      continue;
    }
    if (arg === "--no-telemetry") continue;
    if (stripBare && arg === "--bare") continue;
    next.push(arg);
  }
  if (authMode === "proxy" && !next.includes("--bare")) {
    next.unshift("--bare");
  }
  return next;
}

export interface ClaudeCliChatArgsOptions extends ClaudeCliLaunchOptions {
  claudeModel?: string;
  proxyModel: string;
}

/** Project the configured auth mode onto the model argument at the chat call site. */
export function buildClaudeCliChatArgs(
  args: string[],
  { authMode, claudeModel, proxyModel }: ClaudeCliChatArgsOptions,
): string[] {
  const selectedModel = authMode === "subscription" ? claudeModel?.trim() : proxyModel.trim();
  return selectedModel ? [...args, "--model", selectedModel] : [...args];
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
 * Avoid Windows "The command line is too long" when the user prompt can be
 * moved off the command line. Stock Claude has no system-prompt-file flag, so
 * supported system-prompt flags remain inline while oversized user prompts use stdin.
 */
export function prepareClaudeCliInvocation(
  executable: string,
  cliArgs: string[],
  prompt: string,
): ClaudeCliInvocation {
  const cleanup = () => {};

  const args = [...cliArgs];

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
  cliArgs?: string[];
}

export interface ClaudeCliMessage {
  type: string;
  subtype?: string;
  content?: unknown;
  message?: { content?: unknown };
  event?: { delta?: { text?: string } };
  delta?: { text?: string };
  result?: string;
  session_id?: string;
  tools?: string[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  total_cost_usd?: number;
  num_turns?: number;
  tool_use?: { id?: string; tool_use_id?: string; name: string; input: Record<string, unknown> };
  tool_result?: { tool_use_id?: string; content?: unknown; output?: unknown; is_error?: boolean };
  [key: string]: unknown;
}

// ── Check Availability ──

export async function isClaudeCliAvailable(
  path: string,
  authMode: ClaudeCliAuthMode = "proxy",
): Promise<boolean> {
  const resolved = resolveClaudePath(path);
  return new Promise((resolve) => {
    const proc = spawn(resolved, ["--version"], {
      timeout: 5000,
      env: buildLocalClaudeEnv(process.env, { authMode }),
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

  const launchOptions = { authMode: cliCfg.auth_mode };
  const baseArgs = buildLocalClaudeArgs([...(cliCfg.args || [])], launchOptions);
  if (req.session_id) baseArgs.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options

  const resolvedPath = resolveClaudePath(cliCfg.path);
  const { args, promptOnStdin, cleanup } = prepareClaudeCliInvocation(
    resolvedPath,
    baseArgs,
    req.prompt,
  );

  return new Promise((resolve) => {
    // Use localhost for Ollama — subprocess runs in WSL, same as Bun server
    const localOnlyEnv = {
      ...buildLocalClaudeEnv(process.env, launchOptions),
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
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  tools?: string[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  num_turns?: number;
  error?: string;
}

export interface ClaudeStreamDecodeState {
  partialTextSeen: boolean;
}

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  output?: unknown;
  is_error?: boolean;
};

function contentBlocks(value: unknown): ContentBlock[] {
  return Array.isArray(value)
    ? value.filter((block): block is ContentBlock => !!block && typeof block === "object")
    : [];
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    }).join("");
  }
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Map both stock Claude stream-json records and Jarvis' legacy flat records. */
export function decodeClaudeCliMessage(
  input: unknown,
  state?: ClaudeStreamDecodeState,
): ClaudeStreamEvent[] {
  if (!input || typeof input !== "object") return [];
  const msg = input as ClaudeCliMessage;
  const session_id = typeof msg.session_id === "string" ? msg.session_id : undefined;

  if (msg.type === "system" && msg.subtype === "init") {
    return [{
      type: "init",
      session_id,
      tools: Array.isArray(msg.tools) ? msg.tools : [],
      model: typeof msg.model === "string" ? msg.model : undefined,
    }];
  }

  if (msg.type === "assistant") {
    if (typeof msg.content === "string") {
      return [{ type: "stream_event", delta: { text: msg.content }, session_id }];
    }
    const events: ClaudeStreamEvent[] = [];
    for (const block of contentBlocks(msg.message?.content ?? msg.content)) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        events.push({ type: "stream_event", delta: { text: block.text }, session_id });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use",
          tool_use_id: block.id ?? block.tool_use_id,
          tool_name: block.name ?? "unknown",
          tool_input: block.input ?? {},
          session_id,
        });
      }
    }
    const decoded = state?.partialTextSeen
      ? events.filter((event) => event.type !== "stream_event")
      : events;
    if (state) state.partialTextSeen = false;
    return decoded;
  }

  if (msg.type === "user") {
    return contentBlocks(msg.message?.content ?? msg.content)
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.tool_use_id,
        tool_output: toolOutput(block.output ?? block.content),
        is_error: block.is_error,
        session_id,
      }));
  }

  if (msg.type === "stream_event") {
    const stockPartialText = msg.event?.delta?.text;
    const text = stockPartialText ?? msg.delta?.text;
    if (state && typeof stockPartialText === "string" && stockPartialText) {
      state.partialTextSeen = true;
    }
    return typeof text === "string" && text
      ? [{ type: "stream_event", delta: { text }, session_id }]
      : [];
  }

  if (msg.type === "tool_use") {
    return [{
      type: "tool_use",
      tool_use_id: msg.tool_use?.tool_use_id ?? msg.tool_use?.id,
      tool_name: msg.tool_use?.name || "unknown",
      tool_input: msg.tool_use?.input || {},
      session_id,
    }];
  }

  if (msg.type === "tool_result") {
    return [{
      type: "tool_result",
      tool_use_id: msg.tool_result?.tool_use_id,
      tool_output: toolOutput(msg.tool_result?.output ?? msg.tool_result?.content),
      is_error: msg.tool_result?.is_error,
      session_id,
    }];
  }

  if (msg.type === "result") {
    return [{
      type: "result",
      content: typeof msg.result === "string" ? msg.result : undefined,
      session_id,
      usage: msg.usage,
      cost_usd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
      num_turns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
    }];
  }

  return [];
}

export async function* streamClaudeCli(
  cfg: JarvisConfig,
  req: ClaudeCliRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<ClaudeStreamEvent> {
  const cliCfg = cfg.claude_cli;

  // Use provided cliArgs (which may include --append-system-prompt) or fall back to cfg defaults
  const launchOptions = { authMode: cliCfg.auth_mode };
  const baseArgs = buildLocalClaudeArgs([...(req.cliArgs || cliCfg.args || [])], launchOptions);
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
  const streamEnv = buildLocalClaudeEnv(process.env, launchOptions);

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
  const decodeState: ClaudeStreamDecodeState = { partialTextSeen: false };
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
          for (const event of decodeClaudeCliMessage(msg, decodeState)) {
            if (event.type === "stream_event" && event.delta?.text) {
              fullOutput += event.delta.text;
            } else if (event.type === "result" && !event.content) {
              event.content = fullOutput;
            }
            yield event;
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
