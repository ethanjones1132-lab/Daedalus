import type { JarvisConfig } from "../config";
import {
  buildLocalClaudeArgs,
  buildLocalClaudeEnv,
  decodeClaudeCliMessage,
  isClaudeCliAvailable,
  prepareClaudeCliInvocation,
  resolveClaudeCliLaunchOptions,
  resolveClaudePath,
  type ClaudeStreamDecodeState,
} from "../claude-cli";
import {
  buildDelegateMcpConfig,
  isJarvisDelegateMcpTool,
  jarvisDelegateMcpToolName,
} from "../mcp-adapter";
import { openCodeGoProtocolForModel } from "./live-model-catalog";
import { createHash } from "crypto";
import { execFile, spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { createInterface } from "readline";
import { isAbsolute, join, relative, resolve } from "path";
import { createConnection } from "net";
import { prepareToolResultForContext } from "../tool-result-truncation";
import { delegateToolResultContextChars } from "./context-budget";
import type { DelegateStageDiagnostics, ExecutorStageOutput, ToolCallRecord } from "./stage-output";
import type { ExecutionProfile } from "./route-normalization";

const DELEGATE_TOOL_NAMES: Record<string, string> = {
  edit: "edit_file",
  "edit-file": "edit_file",
  editfile: "edit_file",
  "edit_file": "edit_file",
  write: "write_file",
  "write_file": "write_file",
  multiedit: "multi_edit",
  "multi_edit": "multi_edit",
  read: "read_file",
  "read_file": "read_file",
  grep: "grep",
  glob: "glob",
  bash: "bash",
  websearch: "web_search",
  "web_search": "web_search",
  webfetch: "web_fetch",
  "web_fetch": "web_fetch",
  todowrite: "todo_write",
  "todo_write": "todo_write",
  task: "task",
  // Canonical self-aliases for tools the model may emit after reading native
  // executor guidelines (or any other prompt that lists Jarvis names).
  apply_patch: "apply_patch",
  list_directory: "list_directory",
  git_metadata: "git_metadata",
  // Task-control MCP tools (no spawn) exposed via the Jarvis MCP adapter.
  task_list: "task_list",
  task_get: "task_get",
  task_output: "task_output",
  task_stop: "task_stop",
};

/** Tools that must never be admitted even if they arrive via MCP. */
const DELEGATE_MCP_BLOCKED_TOOLS = new Set([
  "bash",
  "task",
  "run_background_command",
  "agent",
  "task_create",
]);

// Bash is root-confinable at the stock CLI layer: process cwd is the P0 root
// (allowedRoots[0]). Patterned entries like Bash(powershell:*) stay stored in
// config but never reach --tools (exact-name floor only). Task remains blocked.
// Keep in sync with config.DELEGATE_STOCK_FLOOR_TOOLS — both are the floor.
const ROOT_CONFINABLE_CLAUDE_TOOLS = [
  "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "Bash",
  "WebSearch", "WebFetch", "TodoWrite",
] as const;
const ROOT_CONFINABLE_CLAUDE_TOOL_SET = new Set<string>(ROOT_CONFINABLE_CLAUDE_TOOLS);

/**
 * Patterned/unsafe configured entries remain stored but never reach stock CLI
 * authority. Always include the floor set so a stale allowlist without Bash
 * still launches with verification tools available.
 */
function rootConfinableDelegateTools(configured: string[]): string[] {
  const union = [...configured];
  for (const floor of ROOT_CONFINABLE_CLAUDE_TOOLS) {
    if (!union.includes(floor)) union.push(floor);
  }
  return union.filter((name, index) =>
    ROOT_CONFINABLE_CLAUDE_TOOL_SET.has(name) && union.indexOf(name) === index,
  );
}

/**
 * Stock Claude CLI Read on a directory surfaces raw EISDIR. Normalize to the
 * same actionable guidance native filesystem-bundle returns for read_file.
 */
export function normalizeDelegateReadFileOutput(
  canonicalName: string,
  output: string,
  args: Record<string, unknown>,
): string {
  if (canonicalName !== "read_file" || !output) return output;
  const lower = output.toLowerCase();
  // Already native-style guidance — leave alone.
  if (lower.includes("list_directory") && lower.includes("is a directory")) return output;
  const isDirError =
    lower.includes("eisdir")
    || (lower.includes("is a directory") && (lower.includes("illegal") || lower.includes("operation")));
  if (!isDirError) return output;
  const pathHint = typeof args.path === "string" && args.path.trim().length > 0
    ? args.path
    : "that path";
  return `Error: "${pathHint}" is a directory, not a file. Use list_directory to see its contents, then read_file on a specific file inside it.\n(Original: ${output})`;
}

export type DelegateHealthStrikeReason =
  | "spawn_error"
  | "no_event_exit"
  | "timeout_without_write"
  | "unverified_write"
  | "termination_unconfirmed";

export const DELEGATE_HEALTH_COOLDOWN_MS = 10 * 60 * 1_000;
export const DELEGATE_AVAILABILITY_CACHE_MS = 5 * 60 * 1_000;
/** Stop provider retry storms before the CLI spends several minutes backing off. */
export const DELEGATE_API_RETRY_ABORT_THRESHOLD = 3;

export interface ClaudeDelegateAvailabilityChecks {
  now?: () => number;
  checkCli?: (config: JarvisConfig) => Promise<boolean>;
  checkProxyPort?: (port: number) => Promise<boolean>;
}

function proxyPortListening(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveAvailable(available);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Cached launch readiness; proxy auth additionally requires its live listener. */
export class ClaudeDelegateAvailabilityCache {
  private readonly cache = new Map<string, { available: boolean; expiresAt: number }>();
  private readonly now: () => number;
  private readonly checkCli: (config: JarvisConfig) => Promise<boolean>;
  private readonly checkProxyPort: (port: number) => Promise<boolean>;

  constructor(checks: ClaudeDelegateAvailabilityChecks = {}) {
    this.now = checks.now ?? Date.now;
    this.checkCli = checks.checkCli ?? ((config) => {
      const launch = resolveClaudeCliLaunchOptions({
        authMode: config.claude_cli.auth_mode,
        modelId: config.claude_cli.delegate.model,
        opencodeGoApiKey: config.opencode_go.api_key,
        opencodeGoBaseUrl: config.opencode_go.base_url,
      });
      return isClaudeCliAvailable(config.claude_cli.path, launch);
    });
    this.checkProxyPort = checks.checkProxyPort ?? proxyPortListening;
  }

  async isAvailable(config: JarvisConfig): Promise<boolean> {
    const delegateModel = config.claude_cli.delegate.model.trim();
    const launch = resolveClaudeCliLaunchOptions({
      authMode: config.claude_cli.auth_mode,
      modelId: delegateModel,
      opencodeGoApiKey: config.opencode_go.api_key,
      opencodeGoBaseUrl: config.opencode_go.base_url,
    });
    const hasOpenCodeGoKey = Boolean(config.opencode_go.api_key?.trim());
    // Include effective auth + key presence so adding/removing a Go key invalidates cache.
    const key = `${config.claude_cli.auth_mode}:${launch.authMode}:${config.claude_cli.path}:${delegateModel}:goKey=${hasOpenCodeGoKey ? "1" : "0"}`;
    const cached = this.cache.get(key);
    if (cached && this.now() < cached.expiresAt) return cached.available;

    // Don't report the delegate healthy when opencode_go would fail at spawn for a missing key.
    if (launch.authMode === "opencode_go" && !hasOpenCodeGoKey) {
      this.cache.set(key, {
        available: false,
        expiresAt: this.now() + DELEGATE_AVAILABILITY_CACHE_MS,
      });
      return false;
    }

    const cliAvailable = await this.checkCli(config);
    // Anthropic-native OpenCode Go models skip the Python proxy entirely, so
    // availability only needs the stock Claude binary (same as subscription).
    const needsProxy = launch.authMode === "proxy";
    const proxyAvailable = !needsProxy || await this.checkProxyPort(19_878);
    const available = cliAvailable && proxyAvailable;
    this.cache.set(key, {
      available,
      expiresAt: this.now() + DELEGATE_AVAILABILITY_CACHE_MS,
    });
    return available;
  }
}

export class DelegateHealth {
  private strikes = 0;
  private cooldownUntil = 0;
  private lastReason: DelegateHealthStrikeReason | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  isAvailable(): boolean {
    return this.now() >= this.cooldownUntil;
  }

  strike(reason: DelegateHealthStrikeReason): void {
    this.strikes += 1;
    this.lastReason = reason;
    const cooldownMinutes = Math.max(0, this.strikes - 2);
    this.cooldownUntil = cooldownMinutes === 0
      ? 0
      : this.now() + cooldownMinutes * DELEGATE_HEALTH_COOLDOWN_MS;
  }

  markHealthy(): void {
    this.strikes = 0;
    this.cooldownUntil = 0;
    this.lastReason = undefined;
  }

  snapshot(): { strikes: number; cooldownUntil: number; lastReason?: DelegateHealthStrikeReason } {
    return {
      strikes: this.strikes,
      cooldownUntil: this.cooldownUntil,
      ...(this.lastReason ? { lastReason: this.lastReason } : {}),
    };
  }
}

export function mapClaudeDelegateToolName(name: string): string {
  const mcpTool = jarvisDelegateMcpToolName(name);
  if (mcpTool) {
    const mcpNormalized = mcpTool.trim().toLowerCase();
    const mapped = DELEGATE_TOOL_NAMES[mcpNormalized]
      ?? mcpNormalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return mapped || "unknown";
  }
  const normalized = name.trim().toLowerCase();
  return DELEGATE_TOOL_NAMES[normalized]
    ?? `delegate_${normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"}`;
}

/**
 * Canonicalize Claude CLI tool_input keys to native executor shapes so
 * deflection identity (`toolCallIdentityKey`) and evidence accounting match.
 * CLI Read emits `file_path`; native `read_file` uses `path`.
 */
export function canonicalizeDelegateToolArguments(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    let canonKey = key;
    if (lower === "file_path" || lower === "filepath") canonKey = "path";
    else if (lower === "directory_path") canonKey = "directory";
    // Prefer first-seen when both aliases present.
    if (canonKey in out) continue;
    out[canonKey] = value;
  }
  return out;
}

/**
 * Whether a stock-Claude or MCP tool event is permitted for the delegate.
 * Stock tools use the root-confinable floor; Jarvis MCP tools are allowed when
 * they are not shell/Task-spawning escapes.
 */
export function isPermittedDelegateTool(
  stockToolName: string,
  canonicalName: string,
  permittedStockTools: Set<string>,
  permittedCanonical: Set<string>,
): boolean {
  if (permittedStockTools.has(stockToolName) || permittedCanonical.has(canonicalName)) {
    return true;
  }
  if (!isJarvisDelegateMcpTool(stockToolName)) return false;
  return !DELEGATE_MCP_BLOCKED_TOOLS.has(canonicalName);
}

export interface DelegateEligibilityInput {
  config: JarvisConfig;
  profile: ExecutionProfile;
  writeEffectRequired: boolean;
  nativeNoWrite: boolean;
  healthAvailable: boolean;
  allowedRoots: string[];
}

export type DelegateIneligibilityReason =
  | "claude_cli_disabled"
  | "delegate_disabled"
  | "subscription_mode"
  | "missing_opencode_go_key"
  | "profile"
  | "write_not_required"
  | "cooldown"
  | "awaiting_native_no_write"
  | "no_allowed_root";

export function delegateEligibility(
  input: DelegateEligibilityInput,
): { eligible: true } | { eligible: false; reason: DelegateIneligibilityReason } {
  if (!input.config.claude_cli.enabled) return { eligible: false, reason: "claude_cli_disabled" };
  if (!input.config.claude_cli.delegate.enabled) return { eligible: false, reason: "delegate_disabled" };
  // Free-routing imperative: the delegate is an AUTOMATED path, so it must never
  // select subscription mode — that bypasses the local proxy and spends the
  // user's Claude quota. Subscription stays a manual, interactive opt-in; here
  // it makes the delegate ineligible and the free native local loop runs instead.
  if (input.config.claude_cli.auth_mode !== "proxy") {
    return { eligible: false, reason: "subscription_mode" };
  }
  // Anthropic-native OpenCode Go models under proxy mode resolve to opencode_go
  // at launch. Refuse early when the key is empty so we never mark the path
  // eligible and then fail at spawn with a blank ANTHROPIC_API_KEY.
  // "auto" is resolved later to a concrete free/Go id — do not treat it as
  // Anthropic-native (that would falsely require a key and skip free-first).
  const delegateModel = input.config.claude_cli.delegate.model.trim();
  if (
    delegateModel &&
    delegateModel.toLowerCase() !== "auto" &&
    openCodeGoProtocolForModel(delegateModel) === "anthropic"
  ) {
    if (!input.config.opencode_go.api_key?.trim()) {
      return { eligible: false, reason: "missing_opencode_go_key" };
    }
  }
  if (input.profile !== "full") return { eligible: false, reason: "profile" };
  if (!input.writeEffectRequired) return { eligible: false, reason: "write_not_required" };
  if (!input.healthAvailable) return { eligible: false, reason: "cooldown" };
  if (input.config.claude_cli.delegate.policy === "escalation" && !input.nativeNoWrite) {
    return { eligible: false, reason: "awaiting_native_no_write" };
  }
  if (input.allowedRoots.length === 0) return { eligible: false, reason: "no_allowed_root" };
  return { eligible: true };
}

export interface BuildClaudeDelegateInvocationInput {
  config: JarvisConfig;
  prompt: string;
  sessionId: string;
  allowedRoots: string[];
  stageRemainingMs: number;
  executable?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ClaudeDelegateInvocation {
  executable: string;
  args: string[];
  promptOnStdin: boolean;
  cleanup: () => void;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Effective CLI launch auth mode (proxy | subscription | opencode_go). */
  authMode: string;
  /** ANTHROPIC_BASE_URL when the launch pins one; omitted for subscription. */
  baseUrl?: string;
}

/** Claude Code 2.1.88 rejects Jarvis run/session identifiers such as `run_*`. */
function stockClaudeSessionId(sessionId: string): string {
  const value = sessionId.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : crypto.randomUUID();
}

/**
 * Materialize a temporary --mcp-config file for the Claude delegate, exposing
 * Jarvis filesystem/git/task-control tools via mcp-adapter (stdio).
 */
function materializeDelegateMcpConfig(
  allowedRoots: string[],
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-delegate-mcp-"));
  const path = join(dir, "mcp.json");
  const config = buildDelegateMcpConfig({
    workspacePath: allowedRoots[0],
    allowedRoots,
  });
  writeFileSync(path, JSON.stringify(config), "utf-8");
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort; temp dir is under OS tmp.
      }
    },
  };
}

export function buildClaudeDelegateInvocation(
  input: BuildClaudeDelegateInvocationInput,
): ClaudeDelegateInvocation {
  if (input.allowedRoots.length === 0) {
    throw new Error("Claude delegate requires a P0-authorized primary root");
  }
  const delegate = input.config.claude_cli.delegate;
  const mcpConfig = materializeDelegateMcpConfig(input.allowedRoots);
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", delegate.permission_mode,
    "--session-id", stockClaudeSessionId(input.sessionId),
    "--no-session-persistence",
  ];
  if (delegate.model.trim()) args.push("--model", delegate.model.trim());
  if (input.allowedRoots.length > 1) args.push("--add-dir", ...input.allowedRoots.slice(1));
  // Isolate MCP to the generated Jarvis bundle (filesystem/git/task-control).
  args.push("--strict-mcp-config", "--mcp-config", mcpConfig.path);
  const rootConfinableTools = rootConfinableDelegateTools(delegate.allowed_tools);
  // --allowedTools only controls auto-approval. --tools is the actual
  // availability boundary (root-confinable stock tools only — Task and
  // patterned Bash(...) entries stay stripped). MCP tools are separate from
  // the built-in --tools set; keep the stock allowlist as the floor and let
  // --mcp-config supply richer Jarvis tools.
  args.push("--tools", rootConfinableTools.join(","));
  if (rootConfinableTools.length > 0) {
    // Claude 2.1.88 parses --allowedTools as variadic. Terminate its values so
    // prepareClaudeCliInvocation's positional prompt is not swallowed as a tool.
    // Allow all tools from the generated jarvis MCP server for auto-approval.
    args.push(
      "--allowedTools",
      rootConfinableTools.join(","),
      `mcp__jarvis`,
      "--",
    );
  }

  const executable = input.executable ?? resolveClaudePath(input.config.claude_cli.path);
  const launchOptions = resolveClaudeCliLaunchOptions({
    authMode: input.config.claude_cli.auth_mode,
    modelId: delegate.model,
    opencodeGoApiKey: input.config.opencode_go.api_key,
    opencodeGoBaseUrl: input.config.opencode_go.base_url,
  });
  const prepared = prepareClaudeCliInvocation(
    executable,
    buildLocalClaudeArgs(args, launchOptions),
    input.prompt,
  );
  const configuredTimeout = delegate.timeout_ms > 0 ? delegate.timeout_ms : 420_000;
  const preparedCleanup = prepared.cleanup;

  const env = buildLocalClaudeEnv(input.baseEnv ?? process.env, launchOptions);
  return {
    executable,
    args: prepared.args,
    promptOnStdin: prepared.promptOnStdin,
    cleanup: () => {
      preparedCleanup();
      mcpConfig.cleanup();
    },
    cwd: input.allowedRoots[0],
    env,
    timeoutMs: Math.max(0, Math.min(input.stageRemainingMs, configuredTimeout, 420_000)),
    authMode: launchOptions.authMode,
    baseUrl: env.ANTHROPIC_BASE_URL,
  };
}

export interface DelegateRootSnapshot {
  root: string;
  kind: "git" | "filesystem";
  /** Required Git ground-truth projection; blank for non-Git roots. */
  status: string;
  /** Required Git ground-truth projection; blank for non-Git roots. */
  diffStat: string;
  /** Full snapshot identity used to detect unlocalized mutations. */
  fingerprint: string;
  /** Normalized absolute path -> mtime/size or stronger injected identity. */
  files: Record<string, string>;
}

export interface DelegateSnapshotFactory {
  capture(roots: string[]): Promise<DelegateRootSnapshot[]>;
}

export interface DelegateProcessExit {
  code: number | null;
  signal: string | null;
}

export interface DelegateProcessDiagnostics {
  /** Newest ≤4096 UTF-8 characters of stderr, secrets scrubbed. */
  stderrTail: string;
  /**
   * Newest ≤4096 UTF-8 characters of raw stdout (including non-JSON chatter),
   * secrets scrubbed. Backstop when stream-json parse yields nothing useful.
   */
  stdoutTail: string;
  /** Process exit code when known (null if signal/unknown). */
  exitCode?: number | null;
}

export interface DelegateProcess {
  /** Native root PID of the spawned process tree, when available. */
  pid?: number;
  events: AsyncIterable<unknown>;
  exit: Promise<DelegateProcessExit>;
  writeStdin?: (text: string) => void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Bounded sanitized stderr/exit diagnostics for stage_runs.diagnostic_json. */
  diagnostics?: () => DelegateProcessDiagnostics;
}

/** Keep the newest 4 KiB of stderr and scrub credential-bearing tokens. */
export const DELEGATE_STDERR_TAIL_CHARS = 4096;

/**
 * Header Claude CLI forwards via ANTHROPIC_CUSTOM_HEADERS so the long-lived
 * Python proxy can correlate logs with stage_runs.diagnostic_json.
 */
export const DELEGATE_REQUEST_ID_HEADER = "X-Jarvis-Delegate-Request-Id";

/**
 * Stamp env with both the process-local request id (tests / diagnostics) and
 * the Claude CLI custom header the proxy reads per HTTP request.
 */
export function withDelegateRequestCorrelation(
  env: Record<string, string>,
  requestId: string,
): Record<string, string> {
  const headerLine = `${DELEGATE_REQUEST_ID_HEADER}: ${requestId}`;
  const existing = env.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    ...env,
    JARVIS_DELEGATE_REQUEST_ID: requestId,
    ANTHROPIC_CUSTOM_HEADERS: existing ? `${existing}\n${headerLine}` : headerLine,
  };
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token> / Authorization: <value>
  /\bauthorization\s*[:=]\s*bearer\s+\S+/gi,
  /\bauthorization\s*[:=]\s*\S+/gi,
  // api-key / x-api-key headers and assignments (header-style; not ENV_API_KEY)
  /\b(?:x-)?api-?key\s*[:=]\s*\S+/gi,
  // ENV-style *_API_KEY=value (underscore names current \b api-key patterns miss)
  /\b[A-Za-z_][A-Za-z0-9_]*API_KEY\s*=\s*\S+/gi,
  // token= / token: values (avoid bare "token" mid-prose without separator)
  /\btoken\s*[:=]\s*\S+/gi,
  // Standalone Bearer tokens
  /\bbearer\s+[A-Za-z0-9._\-+=\/]{8,}/gi,
  // OpenAI / Anthropic style keys: sk-… / sk-ant-… (mirror training/shadow-router)
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // JSON-ish "api_key":"…" / "token":"…" / "x-api-key":"…"
  /"(?:api[_-]?key|token|x-api-key)"\s*:\s*"[^"]*"/gi,
];

export function sanitizeDelegateDiagnosticText(raw: string): string {
  let text = raw;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      // Bare OpenAI/Anthropic-style keys — replace the whole token.
      if (/^sk-/i.test(match)) return "[REDACTED]";
      // JSON object fields: preserve key, scrub value.
      const jsonField = match.match(/^"([^"]+)"\s*:/);
      if (jsonField) return `"${jsonField[1]}":"[REDACTED]"`;
      const sep = match.includes("=") ? "=" : match.includes(":") ? ":" : " ";
      const key = match.split(/[:=\s]/)[0] ?? "secret";
      return `${key}${sep}[REDACTED]`;
    });
  }
  return text;
}

/** Keep the newest `cap` characters and scrub credential-bearing tokens. */
function boundedDiagnosticTail(raw: string, cap: number = DELEGATE_STDERR_TAIL_CHARS): string {
  const sliced = raw.length <= cap ? raw : raw.slice(raw.length - cap);
  return sanitizeDelegateDiagnosticText(sliced);
}

export interface DelegateProcessLaunch extends ClaudeDelegateInvocation {
  prompt: string;
  /** Operation-wide cancellation signal; factories should refuse new work once aborted. */
  signal: AbortSignal;
}

export type DelegateProcessFactory = (launch: DelegateProcessLaunch) => Promise<DelegateProcess>;

export interface DelegateProcessTreeKiller {
  signalTree(process: DelegateProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/**
 * Parse stream-json lines. Optional `onRawLine` is a passive accumulator for
 * diagnostics — it must not influence which values are yielded.
 */
async function* readJsonLines(
  stream: NodeJS.ReadableStream,
  onRawLine?: (rawLine: string) => void,
): AsyncGenerator<unknown> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      onRawLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Stock --output-format stream-json emits one JSON object per line.
        // Ignore launcher chatter so it cannot masquerade as a valid event.
      }
    }
  } finally {
    lines.close();
  }
}

function isApiRetryFrame(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const nested = record.event && typeof record.event === "object"
    ? record.event as Record<string, unknown>
    : undefined;
  return [record.type, record.subtype, nested?.type, nested?.subtype]
    .some((part) => part === "api_retry");
}

/** Native process boundary used by Task 6; tests inject a deterministic factory. */
export const nodeDelegateProcessFactory: DelegateProcessFactory = async (launch) => {
  if (launch.signal.aborted) throw new Error("Claude delegate launch cancelled");
  const child = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: [launch.promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    // A new Unix process group lets the tree killer address every descendant
    // with a negative PID. Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
  });
  let resolvedExit: DelegateProcessExit = { code: null, signal: null };
  // Drain stderr into a rolling buffer; keep enough headroom so the final
  // 4 KiB tail is complete even when chunks arrive mid-multibyte sequence.
  let stderrRaw = "";
  const onStderr = (chunk: Buffer | string) => {
    stderrRaw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Bound memory: retain slightly more than the publish cap.
    const keep = DELEGATE_STDERR_TAIL_CHARS * 2;
    if (stderrRaw.length > keep) stderrRaw = stderrRaw.slice(stderrRaw.length - keep);
  };
  child.stderr?.on("data", onStderr);
  // Passive stdout accumulator (raw lines including non-JSON chatter).
  let stdoutRaw = "";
  const onStdoutLine = (rawLine: string) => {
    const keep = DELEGATE_STDERR_TAIL_CHARS * 2;
    // Memory guard: a single oversized line never exceeds the keep buffer alone.
    const line = rawLine.length > keep ? rawLine.slice(rawLine.length - keep) : rawLine;
    stdoutRaw += `${line}\n`;
    if (stdoutRaw.length > keep) stdoutRaw = stdoutRaw.slice(stdoutRaw.length - keep);
  };
  const exit = new Promise<DelegateProcessExit>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolvedExit = { code, signal };
      resolveExit(resolvedExit);
    });
    child.once("error", () => {
      resolvedExit = { code: null, signal: null };
      resolveExit(resolvedExit);
    });
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || (launch.promptOnStdin && !stdin)) {
    child.kill("SIGTERM");
    throw new Error("Claude delegate stdio was not available after spawn");
  }
  return {
    pid: child.pid,
    events: readJsonLines(stdout, onStdoutLine),
    exit,
    writeStdin: stdin ? (text) => stdin.end(text) : undefined,
    kill: (signal) => { child.kill(signal); },
    diagnostics: () => ({
      stderrTail: boundedDiagnosticTail(stderrRaw),
      stdoutTail: boundedDiagnosticTail(stdoutRaw),
      exitCode: resolvedExit.code,
    }),
  };
};

function execFileText(executable: string, args: string[]): Promise<string> {
  return new Promise((resolveText, rejectText) => {
    execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) rejectText(error);
      else resolveText(stdout);
    });
  });
}

export interface PlatformDelegateProcessTreeKillerOptions {
  platform: NodeJS.Platform;
  execute: (executable: string, args: string[]) => Promise<string>;
}

/** Platform tree signaling: taskkill /T on Windows, process-group kill on Unix. */
export function createPlatformDelegateProcessTreeKiller(
  options: PlatformDelegateProcessTreeKillerOptions,
): DelegateProcessTreeKiller {
  return {
    async signalTree(childProcess, signal): Promise<void> {
      const pid = childProcess.pid;
      if (pid && options.platform === "win32") {
        const args = ["/PID", String(pid), "/T"];
        if (signal === "SIGKILL") args.push("/F");
        // A taskkill error is not proof the descendant tree is gone. Propagate
        // it so forced cleanup is conservatively reported as uncertain.
        await options.execute("taskkill", args);
        return;
      }
      if (pid) {
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        return;
      }
      childProcess.kill(signal);
    },
  };
}

export const platformDelegateProcessTreeKiller = createPlatformDelegateProcessTreeKiller({
  platform: process.platform,
  execute: execFileText,
});

async function fileIdentity(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Directories whose contents are build output, not source. Hashing them is
 * pure cost and can be fatal: 2026-08-05 live, a configured CMake build put
 * 336 files / 255 MB under `build/` in a repo with no .gitignore, so
 * `git ls-files -co` handed every artifact to the snapshot and the SHA-256
 * walk threw `delegate_snapshot_error` before the delegate could launch.
 *
 * This matters structurally, not just for one workspace: the build gate's
 * CMake detector only fires when `build/CMakeCache.txt` exists, so the gate
 * requires the very directory that broke the snapshot.
 */
const SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  ".vs",
  "build",
  "cmake-build-debug",
  "cmake-build-release",
  "dist",
  "JUCE_BUILD",
  "node_modules",
  "out",
  "target",
]);

/**
 * Whether a workspace-relative path belongs in the delegate's ground-truth
 * snapshot. Matches whole path segments only — `builder/` and `outbound.cpp`
 * are source, not output.
 */
export function shouldSnapshotRelPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  // The basename is a file; only directory segments gate inclusion.
  for (const segment of segments.slice(0, -1)) {
    if (SNAPSHOT_EXCLUDED_DIRS.has(segment)) return false;
  }
  return true;
}

async function filesystemFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path);
      } else files[pathKey(path)] = await fileIdentity(path);
    }
  };
  await walk(root);
  return files;
}

async function gitFiles(root: string, top: string): Promise<Record<string, string>> {
  const output = await execFileText("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z", "--", "."]);
  const files: Record<string, string> = {};
  for (const listed of output.split("\0").filter(Boolean)) {
    // Build output is never a source mutation; skip before hashing it.
    if (!shouldSnapshotRelPath(listed)) continue;
    // git -C <subdir> returns paths relative to that working directory for
    // this invocation. Fall back to the repository top only if necessary.
    const fromRoot = resolve(root, listed);
    const path = containsPath(root, fromRoot) ? fromRoot : resolve(top, listed);
    if (containsPath(root, path)) files[pathKey(path)] = await fileIdentity(path);
  }
  return files;
}

async function captureRoot(rootInput: string): Promise<DelegateRootSnapshot> {
  const root = resolve(rootInput);
  try {
    const top = (await execFileText("git", ["-C", root, "rev-parse", "--show-toplevel"])).trim();
    const [status, unstagedStat, stagedStat, unstagedDiff, stagedDiff, files] = await Promise.all([
      execFileText("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "."]),
      execFileText("git", ["-C", root, "diff", "--stat", "--", "."]),
      execFileText("git", ["-C", root, "diff", "--cached", "--stat", "--", "."]),
      execFileText("git", ["-C", root, "diff", "--binary", "--no-ext-diff", "--", "."]),
      execFileText("git", ["-C", root, "diff", "--cached", "--binary", "--no-ext-diff", "--", "."]),
      gitFiles(root, top),
    ]);
    const diffStat = [unstagedStat.trim(), stagedStat.trim()].filter(Boolean).join("\n");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ status, diffStat, unstagedDiff, stagedDiff, files }))
      .digest("hex");
    return { root, kind: "git", status: status.trimEnd(), diffStat, fingerprint, files };
  } catch {
    const files = await filesystemFiles(root);
    const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    return { root, kind: "filesystem", status: "", diffStat: "", fingerprint, files };
  }
}

/** Native filesystem boundary used by Task 6; tests inject deterministic snapshots. */
export class NodeDelegateSnapshotFactory implements DelegateSnapshotFactory {
  capture(roots: string[]): Promise<DelegateRootSnapshot[]> {
    return Promise.all(roots.map(captureRoot));
  }
}

export const nodeDelegateSnapshotFactory = new NodeDelegateSnapshotFactory();

export interface RunClaudeDelegateInput {
  config: JarvisConfig;
  prompt: string;
  sessionId: string;
  allowedRoots: string[];
  stageRemainingMs: number;
  profile: ExecutionProfile;
  writeEffectRequired: boolean;
  nativeNoWrite: boolean;
  health: DelegateHealth;
  snapshotFactory: DelegateSnapshotFactory;
  processFactory: DelegateProcessFactory;
  signal?: AbortSignal;
  executable?: string;
  baseEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  terminationGraceMs?: number;
  /** Hard wall-time cap for teardown, including TERM grace and post-KILL observation. */
  cleanupTimeoutMs?: number;
  /** Independent post-termination filesystem verification cap. */
  verificationTimeoutMs?: number;
  treeKiller?: DelegateProcessTreeKiller;
  /** Standard executor streaming hooks supplied by the pipeline adapter. */
  onTextDelta?: (text: string) => void;
  onToolUse?: (record: ToolCallRecord) => void;
  /**
   * Fired after a tool_result lands and the matching ToolCallRecord is fully
   * populated. Used by the in-turn conductor to supervise delegate_first
   * streams the same way it supervises the native executor loop.
   */
  onToolResult?: (record: ToolCallRecord) => void | Promise<void>;
}

const DELEGATE_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

function snapshotMap(snapshots: DelegateRootSnapshot[]): Map<string, DelegateRootSnapshot> {
  return new Map(snapshots.map((snapshot) => [pathKey(snapshot.root), snapshot]));
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectClaimedPaths(value: unknown, output: string[] = []): string[] {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectClaimedPaths(item, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "path" || key === "file_path") && typeof child === "string" && child.trim()) {
      output.push(child.trim());
    } else if (typeof child === "object") {
      collectClaimedPaths(child, output);
    }
  }
  return output;
}

function claimedPathChanged(
  path: string,
  roots: string[],
  before: Map<string, DelegateRootSnapshot>,
  after: Map<string, DelegateRootSnapshot>,
): boolean {
  const absolute = resolve(roots[0], path);
  const owningRoot = [...roots]
    .filter((root) => containsPath(root, absolute))
    .sort((left, right) => right.length - left.length)[0];
  if (!owningRoot) return false;
  const beforeRoot = before.get(pathKey(owningRoot));
  const afterRoot = after.get(pathKey(owningRoot));
  if (!beforeRoot || !afterRoot) return false;
  const key = pathKey(absolute);
  return beforeRoot.files[key] !== afterRoot.files[key];
}

function snapshotChanged(
  roots: string[],
  before: Map<string, DelegateRootSnapshot>,
  after: Map<string, DelegateRootSnapshot>,
): boolean {
  return roots.some((root) => before.get(pathKey(root))?.fingerprint !== after.get(pathKey(root))?.fingerprint);
}

function writeVerified(
  record: ToolCallRecord,
  roots: string[],
  before: Map<string, DelegateRootSnapshot>,
  after: Map<string, DelegateRootSnapshot>,
): boolean {
  const claims = collectClaimedPaths(record.arguments);
  return claims.length > 0
    ? claims.every((path) => claimedPathChanged(path, roots, before, after))
    : snapshotChanged(roots, before, after);
}

function gitMetadataRecord(snapshots: DelegateRootSnapshot[], verified = true): ToolCallRecord {
  const gitSnapshots = snapshots.filter((snapshot) => snapshot.kind === "git");
  const output = !verified
    ? "Post-run ground-truth verification unavailable; no diffstat is verified."
    : gitSnapshots.length > 0
    ? gitSnapshots.map((snapshot) => [
        `root: ${snapshot.root}`,
        "git status --porcelain:",
        snapshot.status || "(clean)",
        "git diff --stat:",
        snapshot.diffStat || "(no diffstat)",
      ].join("\n")).join("\n\n")
    : "No Git roots were involved; filesystem mtime/size snapshots verified ground truth.";
  return {
    name: "git_metadata",
    arguments: { roots: snapshots.map((snapshot) => snapshot.root) },
    output: prepareToolResultForContext(output, delegateToolResultContextChars()).context,
    is_error: !verified,
    duration_ms: 0,
  };
}

type DelegateOperationTerminal = "timeout" | "aborted";
type GuardedTerminal = { kind: "timeout" } | { kind: "aborted" };

type GuardedResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | GuardedTerminal;

/** One cancellation/deadline state spanning snapshots, launch, stream, and verification. */
class DelegateOperationGuard {
  private terminal: DelegateOperationTerminal | undefined;
  private readonly terminalPromise: Promise<GuardedTerminal>;
  private resolveTerminal!: (result: GuardedTerminal) => void;
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abortListener: () => void;

  constructor(private readonly externalSignal: AbortSignal | undefined, private readonly budgetMs: number) {
    this.terminalPromise = new Promise((resolveTerminal) => { this.resolveTerminal = resolveTerminal; });
    this.abortListener = () => this.stop("aborted");
    externalSignal?.addEventListener("abort", this.abortListener, { once: true });
    this.timer = setTimeout(() => this.stop("timeout"), Math.max(0, budgetMs));
    if (externalSignal?.aborted) this.stop("aborted");
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  state(): DelegateOperationTerminal | undefined {
    return this.terminal;
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  async race<T>(promise: Promise<T>): Promise<GuardedResult<T>> {
    if (this.terminal) return this.terminal === "timeout" ? { kind: "timeout" } : { kind: "aborted" };
    const settled = promise.then<GuardedResult<T>, GuardedResult<T>>(
      (value) => ({ kind: "value", value }),
      (error): GuardedResult<T> => ({ kind: "error", error }),
    );
    return Promise.race<GuardedResult<T>>([
      settled,
      this.terminalPromise,
    ]);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.abortListener);
  }

  private stop(kind: DelegateOperationTerminal): void {
    if (this.terminal) return;
    this.terminal = kind;
    this.controller.abort(kind);
    this.resolveTerminal(kind === "timeout" ? { kind: "timeout" } : { kind: "aborted" });
  }
}

function delegateFailure(errorCode: string, narrative: string): ExecutorStageOutput {
  return {
    ok: false,
    narrative,
    toolCalls: [],
    terminalStatus: "failed",
    errorCode,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}

type BoundedVerificationResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function boundedVerification<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedVerificationResult<T>> {
  // Keep the capture promise observed even if the finite verification window
  // wins, so a late filesystem error can never become an unhandled rejection.
  const settled = promise.then<BoundedVerificationResult<T>, BoundedVerificationResult<T>>(
    (value) => ({ kind: "value", value }),
    (error) => ({ kind: "error", error }),
  );
  return Promise.race([
    settled,
    delay(timeoutMs).then((): BoundedVerificationResult<T> => ({ kind: "timeout" })),
  ]);
}

async function closeDelegateEventIterator(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (!iterator.return) return;
  await boundedVerification(
    Promise.resolve().then(() => iterator.return!()),
    Math.max(1, timeoutMs),
  );
}

type DelegateCleanupOutcome =
  | { status: "terminated"; detail: string }
  | { status: "exit_unconfirmed"; detail: string }
  | { status: "signal_error"; detail: string }
  | { status: "factory_unsettled"; detail: string }
  | { status: "factory_error"; detail: string };

interface ObservedOperation {
  settled: Promise<void>;
  state: () => { kind: "pending" } | { kind: "success" } | { kind: "error"; error: unknown };
}

function observeOperation(operation: () => Promise<unknown>): ObservedOperation {
  let state: ReturnType<ObservedOperation["state"]> = { kind: "pending" };
  let result: Promise<unknown>;
  try {
    result = operation();
  } catch (error) {
    result = Promise.reject(error);
  }
  const settled = Promise.resolve(result)
    .then(
      () => { state = { kind: "success" }; },
      (error) => { state = { kind: "error", error }; },
    );
  return { settled, state: () => state };
}

function cleanupRecord(outcome: DelegateCleanupOutcome): ToolCallRecord {
  const isError = outcome.status !== "terminated";
  const signalError = outcome.status === "signal_error";
  return {
    name: "delegate_cleanup",
    arguments: { status: outcome.status },
    output: outcome.detail,
    is_error: isError,
    ...(isError ? {
      error_code: signalError ? "delegate_cleanup_signal_error" as const : "delegate_cleanup_unconfirmed" as const,
    } : {}),
    duration_ms: 0,
  };
}

async function terminateDelegateProcess(
  childProcess: DelegateProcess,
  graceMs: number,
  cleanupTimeoutMs: number,
  treeKiller: DelegateProcessTreeKiller,
): Promise<DelegateCleanupOutcome> {
  const startedAt = Date.now();
  const capMs = Math.max(1, cleanupTimeoutMs);
  const boundedGraceMs = Math.min(Math.max(0, graceMs), capMs);
  const exit = observeOperation(() => childProcess.exit);
  const term = observeOperation(() => treeKiller.signalTree(childProcess, "SIGTERM"));

  await delay(boundedGraceMs);
  await Promise.resolve();
  if (exit.state().kind === "success" && term.state().kind === "success") {
    return { status: "terminated", detail: "TERM tree signal and direct child exit were confirmed during grace." };
  }
  // Always force-signal the whole tree after grace, even when the direct
  // child has not produced a confirmed exit.
  const kill = observeOperation(() => treeKiller.signalTree(childProcess, "SIGKILL"));
  // Let an immediately fulfilled/rejected signal operation become observable
  // even if the TERM timer consumed the nominal cleanup wall-time.
  await Promise.resolve();
  let remainingMs = Math.max(0, capMs - (Date.now() - startedAt));
  if (kill.state().kind === "pending" && remainingMs > 0) {
    await Promise.race([kill.settled, delay(remainingMs)]);
  }

  const killState = kill.state();
  if (killState.kind === "error") {
    return { status: "signal_error", detail: `Forced process-tree kill failed: ${String(killState.error)}` };
  }
  if (killState.kind === "pending") {
    return { status: "signal_error", detail: "Forced process-tree kill did not settle before the cleanup deadline." };
  }
  remainingMs = Math.max(0, capMs - (Date.now() - startedAt));
  if (exit.state().kind === "pending" && remainingMs > 0) {
    await Promise.race([exit.settled, delay(remainingMs)]);
  }
  const exitState = exit.state();
  if (exitState.kind === "error") {
    return { status: "exit_unconfirmed", detail: `Child exit observation failed after forced kill: ${String(exitState.error)}` };
  }
  if (exitState.kind === "pending") {
    return { status: "exit_unconfirmed", detail: "Child exit was not observed before the cleanup deadline after forced process-tree kill." };
  }
  return { status: "terminated", detail: "Forced process-tree kill and direct child exit were confirmed." };
}

async function cleanupLateLaunch(
  launchPromise: Promise<DelegateProcess>,
  graceMs: number,
  cleanupTimeoutMs: number,
  treeKiller: DelegateProcessTreeKiller,
): Promise<DelegateCleanupOutcome> {
  // This promise is deliberately total: both a late factory rejection and
  // every termination failure become data, so no detached rejection escapes.
  const cleanup = launchPromise.then<DelegateCleanupOutcome, DelegateCleanupOutcome>(
    (lateProcess) => terminateDelegateProcess(lateProcess, graceMs, cleanupTimeoutMs, treeKiller),
    (error) => ({ status: "factory_error", detail: `Late process factory rejected: ${String(error)}` }),
  ).then(
    (outcome) => outcome,
    (error): DelegateCleanupOutcome => ({ status: "signal_error", detail: `Late process cleanup failed: ${String(error)}` }),
  );
  const observed = await Promise.race([
    cleanup.then((outcome) => ({ kind: "outcome" as const, outcome })),
    delay(cleanupTimeoutMs).then(() => ({ kind: "deadline" as const })),
  ]);
  if (observed.kind === "outcome") return observed.outcome;
  // `cleanup` remains attached and total. If the factory eventually returns a
  // child, process-tree termination starts immediately and is itself bounded.
  void cleanup.then(() => undefined);
  return {
    status: "factory_unsettled",
    detail: "Process factory did not settle within the cleanup deadline; late resolution remains fenced for bounded tree termination.",
  };
}

/**
 * Run one stock Claude CLI executor delegate behind injected process and
 * filesystem boundaries. Production integration remains owned by Task 6.
 */
export async function runClaudeDelegate(input: RunClaudeDelegateInput): Promise<ExecutorStageOutput> {
  const eligibility = delegateEligibility({
    config: input.config,
    profile: input.profile,
    writeEffectRequired: input.writeEffectRequired,
    nativeNoWrite: input.nativeNoWrite,
    healthAvailable: input.health.isAvailable(),
    allowedRoots: input.allowedRoots,
  });
  if (!eligibility.eligible) {
    return delegateFailure(`delegate_ineligible_${eligibility.reason}`, "Claude delegate was not eligible.");
  }
  const configuredTimeout = input.config.claude_cli.delegate.timeout_ms > 0
    ? input.config.claude_cli.delegate.timeout_ms
    : 420_000;
  const operation = new DelegateOperationGuard(
    input.signal,
    Math.max(0, Math.min(input.stageRemainingMs, configuredTimeout, 420_000)),
  );
  const now = input.now ?? Date.now;
  const treeKiller = input.treeKiller ?? platformDelegateProcessTreeKiller;
  const terminationGraceMs = Number.isFinite(input.terminationGraceMs)
    ? Math.max(0, input.terminationGraceMs!)
    : 10_000;
  const requestedCleanupTimeoutMs = Number.isFinite(input.cleanupTimeoutMs)
    ? input.cleanupTimeoutMs!
    : terminationGraceMs + 2_000;
  // Teardown is permitted to outlive the execution deadline, but never this
  // explicit finite wall-time cap.
  const cleanupTimeoutMs = Math.max(1, Math.min(requestedCleanupTimeoutMs, 30_000));
  // Verification is deliberately independent of the execution deadline: a
  // child may successfully mutate a file immediately before timing out. The
  // this separate cap permits only a read-only ground-truth snapshot. The
  // snapshot is admitted only after normal exit or confirmed cleanup provides
  // a stable process boundary.
  const requestedVerificationTimeoutMs = Number.isFinite(input.verificationTimeoutMs)
    ? input.verificationTimeoutMs!
    : 5_000;
  const verificationTimeoutMs = Math.max(1, Math.min(requestedVerificationTimeoutMs, 30_000));
  // Permit on stock identity (Write) OR canonical identity (write_file). The
  // stock CLI emits capitalized names; a model that read native TOOL_GUIDELINES
  // may emit canonical names instead. Both must be accepted when the stock tool
  // is in allowed_tools (F1 / 2026-07-21 eval).
  const permittedStockTools = new Set(rootConfinableDelegateTools(input.config.claude_cli.delegate.allowed_tools));
  const permittedCanonical = new Set(
    [...permittedStockTools].map((name) => mapClaudeDelegateToolName(name)),
  );
  const terminalOutput = (
    kind: DelegateOperationTerminal,
    toolCalls: ToolCallRecord[] = [],
    narrative = "",
  ): ExecutorStageOutput => {
    if (kind === "timeout" && !toolCalls.some((record) => DELEGATE_WRITE_TOOLS.has(record.name) && !record.is_error)) {
      input.health.strike("timeout_without_write");
    }
    if (toolCalls.some((record) => record.name === "delegate_cleanup" && record.is_error)) {
      input.health.strike("termination_unconfirmed");
    }
    return {
      ok: false,
      narrative,
      toolCalls,
      terminalStatus: kind === "timeout" ? "timed_out" : "cancelled",
      errorCode: kind === "timeout" ? "delegate_timeout" : "delegate_aborted",
    };
  };

  let invocation: ClaudeDelegateInvocation | undefined;
  try {
    if (operation.state()) return terminalOutput(operation.state()!);
    const beforeResult = await operation.race(input.snapshotFactory.capture(input.allowedRoots));
    if (beforeResult.kind === "timeout" || beforeResult.kind === "aborted") return terminalOutput(beforeResult.kind);
    if (beforeResult.kind === "error") {
      return delegateFailure("delegate_snapshot_error", `Delegate ground-truth snapshot failed: ${String(beforeResult.error)}`);
    }
    const beforeSnapshots = beforeResult.value;

    if (operation.state()) return terminalOutput(operation.state()!);
    try {
      invocation = buildClaudeDelegateInvocation({
        config: input.config,
        prompt: input.prompt,
        sessionId: input.sessionId,
        allowedRoots: input.allowedRoots,
        stageRemainingMs: operation.remainingMs(),
        executable: input.executable,
        baseEnv: input.baseEnv,
      });
    } catch (error) {
      input.health.strike("spawn_error");
      return delegateFailure("delegate_spawn_error", `Failed to prepare Claude delegate: ${String(error)}`);
    }

    if (operation.state()) return terminalOutput(operation.state()!);
    const records: ToolCallRecord[] = [];
    // Correlate proxy/stderr logs with this stage_runs.diagnostic_json row.
    // The proxy is long-lived, so process-env alone is always "missing" there.
    // Claude CLI forwards ANTHROPIC_CUSTOM_HEADERS on every /v1/messages call;
    // the proxy reads X-Jarvis-Delegate-Request-Id from that request.
    const delegateRequestId = crypto.randomUUID();
    let processDiagnostics: DelegateProcessDiagnostics | undefined;
    let delegatedProcess: DelegateProcess | undefined;
    const stageDiagnostics = (): DelegateStageDiagnostics => {
      const live = delegatedProcess?.diagnostics?.() ?? processDiagnostics;
      if (live) processDiagnostics = live;
      return {
        delegate_request_id: delegateRequestId,
        auth_mode: invocation!.authMode,
        base_url: invocation!.baseUrl,
        exit_code: processDiagnostics?.exitCode ?? null,
        stderr_tail: processDiagnostics
          ? sanitizeDelegateDiagnosticText(processDiagnostics.stderrTail)
          : undefined,
        stdout_tail: processDiagnostics
          ? sanitizeDelegateDiagnosticText(processDiagnostics.stdoutTail)
          : undefined,
      };
    };
    const withDiagnostics = (result: ExecutorStageOutput): ExecutorStageOutput => ({
      ...result,
      diagnostics: stageDiagnostics(),
    });
    const launchPromise = input.processFactory({
      ...invocation,
      env: withDelegateRequestCorrelation(invocation.env, delegateRequestId),
      prompt: input.prompt,
      signal: operation.signal,
    });
    const launchResult = await operation.race(launchPromise);
    if (launchResult.kind === "timeout" || launchResult.kind === "aborted") {
      const cleanup = await cleanupLateLaunch(launchPromise, terminationGraceMs, cleanupTimeoutMs, treeKiller);
      records.push(cleanupRecord(cleanup));
      // Do not await the factory again — cleanupLateLaunch already bounded it.
      // Request-id-only diagnostics still correlate proxy/stderr when present.
      return withDiagnostics(terminalOutput(launchResult.kind, records));
    }
    if (launchResult.kind === "error") {
      input.health.strike("spawn_error");
      return withDiagnostics(delegateFailure(
        "delegate_spawn_error",
        `Failed to spawn Claude delegate: ${String(launchResult.error)}`,
      ));
    }
    delegatedProcess = launchResult.value;
    if (operation.state()) {
      records.push(cleanupRecord(await terminateDelegateProcess(
        delegatedProcess, terminationGraceMs, cleanupTimeoutMs, treeKiller,
      )));
      processDiagnostics = delegatedProcess.diagnostics?.();
      return withDiagnostics(terminalOutput(operation.state()!, records));
    }
    if (invocation.promptOnStdin) delegatedProcess.writeStdin?.(input.prompt);

    const pending = new Map<string, { record: ToolCallRecord; startedAt: number }>();
    const narrative: string[] = [];
    const decodeState: ClaudeStreamDecodeState = { partialTextSeen: false };
    const eventIterator = delegatedProcess.events[Symbol.asyncIterator]();
    let eventCount = 0;
    let consecutiveApiRetries = 0;
    let policyViolation = false;
    /** Decoded CLI failure signal (result is_error / type error) for named failure reasons. */
    let cliFailureDetail: string | undefined;
    const execution = (async (): Promise<
      | { kind: "completed"; exit: DelegateProcessExit }
      | { kind: "stream_error"; error: unknown }
    > => {
      try {
        while (true) {
          const next = await eventIterator.next();
          if (next.done) break;
          const rawEvent = next.value;
          if (isApiRetryFrame(rawEvent)) {
            consecutiveApiRetries += 1;
            if (consecutiveApiRetries >= DELEGATE_API_RETRY_ABORT_THRESHOLD) {
              cliFailureDetail = `api_retry storm: aborted after ${DELEGATE_API_RETRY_ABORT_THRESHOLD} consecutive retries`;
              records.push(cleanupRecord(await terminateDelegateProcess(
                delegatedProcess,
                terminationGraceMs,
                cleanupTimeoutMs,
                treeKiller,
              )));
              break;
            }
          } else {
            consecutiveApiRetries = 0;
          }
          const events = decodeClaudeCliMessage(rawEvent, decodeState);
          eventCount += events.length;
          for (const event of events) {
            if (event.type === "stream_event" && event.delta?.text) {
              narrative.push(event.delta.text);
              input.onTextDelta?.(event.delta.text);
            }
            else if (event.type === "result") {
              if (event.content) {
                narrative.push(event.content);
                input.onTextDelta?.(event.content);
              }
              if (event.is_error === true) {
                const parts = [event.subtype, event.content ?? event.error]
                  .filter((part): part is string => typeof part === "string" && part.length > 0);
                cliFailureDetail = parts.length > 0
                  ? parts.join(": ")
                  : "result reported is_error";
              }
            }
            else if (event.type === "error") {
              const parts = [event.subtype, event.error ?? event.content]
                .filter((part): part is string => typeof part === "string" && part.length > 0);
              cliFailureDetail = parts.length > 0
                ? parts.join(": ")
                : "CLI emitted an error event";
              const text = event.error ?? event.content;
              if (text) {
                narrative.push(text);
                input.onTextDelta?.(text);
              }
            }
            else if (event.type === "tool_use") {
              const stockToolName = event.tool_name ?? "unknown";
              const canonicalName = mapClaudeDelegateToolName(stockToolName);
              const permitted = isPermittedDelegateTool(
                stockToolName,
                canonicalName,
                permittedStockTools,
                permittedCanonical,
              );
              const record: ToolCallRecord = {
                name: canonicalName,
                arguments: canonicalizeDelegateToolArguments(
                  (event.tool_input ?? {}) as Record<string, unknown>,
                ),
                output: permitted ? "" : "delegate_tool_not_permitted: tool is outside the root-confinable delegate set.",
                is_error: !permitted,
                ...(!permitted ? { error_code: "policy_denied" as const } : {}),
                duration_ms: 0,
              };
              if (!permitted) policyViolation = true;
              records.push(record);
              input.onToolUse?.(record);
              pending.set(event.tool_use_id ?? `anonymous-${records.length}`, { record, startedAt: now() });
            } else if (event.type === "tool_result") {
              const match = event.tool_use_id ? pending.get(event.tool_use_id) : undefined;
              if (match) {
                const resultOutput = event.tool_output ?? "";
                const normalizedOutput = match.record.error_code === "policy_denied"
                  ? `${match.record.output}\n\nRejected delegate output: ${resultOutput}`
                  : normalizeDelegateReadFileOutput(
                    match.record.name,
                    resultOutput,
                    match.record.arguments,
                  );
                // Directory-read normalization produces a guided error even when
                // the CLI marked the event non-error or left is_error unset.
                const directoryGuided =
                  match.record.name === "read_file"
                  && normalizedOutput !== resultOutput
                  && normalizedOutput.includes("list_directory");
                match.record.output = prepareToolResultForContext(
                  normalizedOutput,
                  delegateToolResultContextChars(),
                ).context;
                if (match.record.error_code !== "policy_denied") {
                  match.record.is_error = event.is_error === true || directoryGuided;
                }
                match.record.duration_ms = Math.max(0, now() - match.startedAt);
                pending.delete(event.tool_use_id!);
                // Mid-loop supervision observes completed tool outcomes. Await
                // so an abort/handoff decision can cancel the stream promptly.
                try {
                  await input.onToolResult?.(match.record);
                } catch {
                  // Supervision must never kill the stream on its own throw;
                  // pipeline handlers are expected to fail-open.
                }
              }
            }
          }
          if (cliFailureDetail?.startsWith("api_retry storm:")) break;
        }
        return { kind: "completed", exit: await delegatedProcess.exit };
      } catch (error) {
        return { kind: "stream_error", error };
      }
    })();

    const terminateAndCloseEventStream = async (): Promise<DelegateCleanupOutcome> => {
      const startedAt = Date.now();
      const cleanup = await terminateDelegateProcess(
        delegatedProcess, terminationGraceMs, cleanupTimeoutMs, treeKiller,
      );
      const closeBudgetMs = Math.max(1, cleanupTimeoutMs - (Date.now() - startedAt));
      await closeDelegateEventIterator(eventIterator, closeBudgetMs);
      return cleanup;
    };

    const executionResult = await operation.race(execution);
    let streamOutcome: { kind: "completed"; exit: DelegateProcessExit } | { kind: "stream_error"; error: unknown };
    if (executionResult.kind === "timeout" || executionResult.kind === "aborted") {
      records.push(cleanupRecord(await terminateAndCloseEventStream()));
      streamOutcome = { kind: "stream_error", error: executionResult.kind };
    } else if (executionResult.kind === "error") {
      records.push(cleanupRecord(await terminateAndCloseEventStream()));
      streamOutcome = { kind: "stream_error", error: executionResult.error };
    } else {
      streamOutcome = executionResult.value;
      if (streamOutcome.kind === "stream_error") {
        records.push(cleanupRecord(await terminateAndCloseEventStream()));
      }
    }

    const terminalBeforePostSnapshot = operation.state();
    const hasClaimedWrite = records.some(
      (record) => DELEGATE_WRITE_TOOLS.has(record.name) && record.error_code !== "policy_denied",
    );
    const cleanupUnconfirmed = records.some(
      (record) => record.name === "delegate_cleanup" && record.is_error,
    );
    const afterResult: GuardedResult<DelegateRootSnapshot[]> = cleanupUnconfirmed
      ? { kind: "error", error: new Error("Delegate process cleanup was not confirmed.") }
      : hasClaimedWrite
        ? await boundedVerification(
            input.snapshotFactory.capture(input.allowedRoots),
            verificationTimeoutMs,
          )
        : terminalBeforePostSnapshot
          ? (terminalBeforePostSnapshot === "timeout" ? { kind: "timeout" } : { kind: "aborted" })
          : await operation.race(input.snapshotFactory.capture(input.allowedRoots));
    const verificationAvailable = afterResult.kind === "value";
    const afterSnapshots = verificationAvailable ? afterResult.value : beforeSnapshots;
    const before = snapshotMap(beforeSnapshots);
    const after = snapshotMap(afterSnapshots);
    let unverifiedWrite = false;
    for (const record of records) {
      if (!DELEGATE_WRITE_TOOLS.has(record.name)) continue;
      if (record.error_code === "policy_denied") continue;
      if (!verificationAvailable || !writeVerified(record, input.allowedRoots, before, after)) {
        record.is_error = true;
        record.error_code = "delegate_write_unverified";
        const unverifiedOutput = record.output
          ? `${record.output}\n\ndelegate_write_unverified: no matching filesystem change was observed.`
          : "delegate_write_unverified: no matching filesystem change was observed.";
        record.output = prepareToolResultForContext(unverifiedOutput, delegateToolResultContextChars()).context;
        unverifiedWrite = true;
      }
    }
    records.push(gitMetadataRecord(afterSnapshots, verificationAvailable));

    // Capture process diagnostics after the child has settled (exit observed or
    // teardown attempted) so exit_code and stderr_tail are as complete as possible.
    processDiagnostics = delegatedProcess.diagnostics?.() ?? processDiagnostics;

    const terminal = operation.state()
      ?? (afterResult.kind === "timeout" || afterResult.kind === "aborted" ? afterResult.kind : undefined);
    if (cleanupUnconfirmed) {
      input.health.strike("termination_unconfirmed");
      return withDiagnostics({
        ok: false,
        narrative: narrative.join(""),
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_cleanup_unconfirmed",
      });
    }
    if (terminal) {
      if (unverifiedWrite) input.health.strike("unverified_write");
      return withDiagnostics(terminalOutput(terminal, records, narrative.join("")));
    }
    if (afterResult.kind === "error") narrative.push(`Ground-truth verification failed: ${String(afterResult.error)}`);
    if (unverifiedWrite) {
      input.health.strike("unverified_write");
      return withDiagnostics({
        ok: false,
        narrative: narrative.join(""),
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_write_unverified",
      });
    }
    if (policyViolation) {
      return withDiagnostics({
        ok: false,
        narrative: narrative.join(""),
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_tool_not_permitted",
      });
    }
    if (streamOutcome.kind === "stream_error") {
      return withDiagnostics({
        ok: false,
        narrative: `Claude delegate stream failed: ${String(streamOutcome.error)}`,
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_stream_error",
      });
    }
    if (eventCount === 0 && !cliFailureDetail) {
      input.health.strike("no_event_exit");
      return withDiagnostics({
        ok: false,
        narrative: "Claude delegate exited without emitting stream events.",
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_no_events",
      });
    }
    // Prefer a named CLI failure cause over generic no-events / bare exit codes
    // when stream-json already reported why the turn failed.
    if (cliFailureDetail) {
      const text = narrative.join("");
      const failureNarrative = text.includes(cliFailureDetail)
        ? (text || `Claude delegate failed: ${cliFailureDetail}`)
        : (text
          ? `${text}\nClaude delegate failed: ${cliFailureDetail}`
          : `Claude delegate failed: ${cliFailureDetail}`);
      // CLI error detail/prose can echo credential-bearing tokens; scrub before stage narrative.
      return withDiagnostics({
        ok: false,
        narrative: sanitizeDelegateDiagnosticText(failureNarrative),
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: cliFailureDetail.startsWith("api_retry storm:")
          ? "delegate_api_retry_storm"
          : "delegate_cli_error",
      });
    }
    if (streamOutcome.exit.code !== 0) {
      return withDiagnostics({
        ok: false,
        narrative: narrative.join(""),
        toolCalls: records,
        terminalStatus: "failed",
        errorCode: "delegate_exit_nonzero",
      });
    }
    input.health.markHealthy();
    return withDiagnostics({
      ok: true,
      narrative: narrative.join(""),
      toolCalls: records,
      terminalStatus: "completed",
    });
  } finally {
    invocation?.cleanup();
    operation.dispose();
  }
}

export type { ExecutionProfile };
