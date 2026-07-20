import type { JarvisConfig } from "../config";
import {
  buildLocalClaudeArgs,
  buildLocalClaudeEnv,
  decodeClaudeCliMessage,
  prepareClaudeCliInvocation,
  resolveClaudePath,
  type ClaudeStreamDecodeState,
} from "../claude-cli";
import { createHash } from "crypto";
import { execFile, spawn } from "child_process";
import { lstat, readdir } from "fs/promises";
import { createInterface } from "readline";
import { isAbsolute, join, relative, resolve } from "path";
import { prepareToolResultForContext } from "../tool-result-truncation";
import { EXECUTOR_TOOL_RESULT_CONTEXT_CHARS } from "./context-budget";
import type { ExecutorStageOutput, ToolCallRecord } from "./stage-output";
import type { ExecutionProfile } from "./route-normalization";

const DELEGATE_TOOL_NAMES: Record<string, string> = {
  edit: "edit_file",
  "edit-file": "edit_file",
  editfile: "edit_file",
  write: "write_file",
  multiedit: "multi_edit",
  read: "read_file",
  grep: "grep",
  glob: "glob",
  bash: "bash",
  websearch: "web_search",
  webfetch: "web_fetch",
  todowrite: "todo_write",
  task: "task",
};

const ROOT_CONFINABLE_CLAUDE_TOOLS = [
  "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob",
  "WebSearch", "WebFetch", "TodoWrite",
] as const;
const ROOT_CONFINABLE_CLAUDE_TOOL_SET = new Set<string>(ROOT_CONFINABLE_CLAUDE_TOOLS);

/** Unsafe/indirect configured entries remain stored but never reach stock CLI authority. */
function rootConfinableDelegateTools(configured: string[]): string[] {
  return configured.filter((name, index) =>
    ROOT_CONFINABLE_CLAUDE_TOOL_SET.has(name) && configured.indexOf(name) === index,
  );
}

export type DelegateHealthStrikeReason =
  | "spawn_error"
  | "no_event_exit"
  | "timeout_without_write"
  | "unverified_write";

export const DELEGATE_HEALTH_COOLDOWN_MS = 10 * 60 * 1_000;

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
    this.cooldownUntil = this.now() + DELEGATE_HEALTH_COOLDOWN_MS;
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
  const normalized = name.trim().toLowerCase();
  return DELEGATE_TOOL_NAMES[normalized]
    ?? `delegate_${normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"}`;
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
}

export function buildClaudeDelegateInvocation(
  input: BuildClaudeDelegateInvocationInput,
): ClaudeDelegateInvocation {
  if (input.allowedRoots.length === 0) {
    throw new Error("Claude delegate requires a P0-authorized primary root");
  }
  const delegate = input.config.claude_cli.delegate;
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", delegate.permission_mode,
    "--session-id", input.sessionId,
    "--no-session-persistence",
  ];
  if (delegate.model.trim()) args.push("--model", delegate.model.trim());
  if (input.allowedRoots.length > 1) args.push("--add-dir", ...input.allowedRoots.slice(1));
  const rootConfinableTools = rootConfinableDelegateTools(delegate.allowed_tools);
  // --allowedTools only controls auto-approval. --tools is the actual
  // availability boundary that prevents Bash/Task from escaping P0 roots.
  args.push("--tools", rootConfinableTools.join(","));
  if (rootConfinableTools.length > 0) args.push("--allowedTools", rootConfinableTools.join(","));

  const executable = input.executable ?? resolveClaudePath(input.config.claude_cli.path);
  const launchOptions = { authMode: input.config.claude_cli.auth_mode } as const;
  const prepared = prepareClaudeCliInvocation(
    executable,
    buildLocalClaudeArgs(args, launchOptions),
    input.prompt,
  );
  const configuredTimeout = delegate.timeout_ms > 0 ? delegate.timeout_ms : 420_000;

  return {
    executable,
    args: prepared.args,
    promptOnStdin: prepared.promptOnStdin,
    cleanup: prepared.cleanup,
    cwd: input.allowedRoots[0],
    env: buildLocalClaudeEnv(input.baseEnv ?? process.env, launchOptions),
    timeoutMs: Math.max(0, Math.min(input.stageRemainingMs, configuredTimeout, 420_000)),
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

export interface DelegateProcess {
  /** Native root PID of the spawned process tree, when available. */
  pid?: number;
  events: AsyncIterable<unknown>;
  exit: Promise<DelegateProcessExit>;
  writeStdin?: (text: string) => void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
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

async function* readJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<unknown> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
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
  const exit = new Promise<DelegateProcessExit>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", () => resolveExit({ code: null, signal: null }));
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
  // The delegate protocol is stdout-only; drain stderr so a noisy child can
  // never block on a full pipe while the caller waits for JSON events.
  child.stderr?.resume();
  return {
    pid: child.pid,
    events: readJsonLines(stdout),
    exit,
    writeStdin: stdin ? (text) => stdin.end(text) : undefined,
    kill: (signal) => { child.kill(signal); },
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

/** Platform tree signaling: taskkill /T on Windows, process-group kill on Unix. */
export const platformDelegateProcessTreeKiller: DelegateProcessTreeKiller = {
  async signalTree(childProcess, signal): Promise<void> {
    const pid = childProcess.pid;
    if (pid && process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (signal === "SIGKILL") args.push("/F");
      try {
        await execFileText("taskkill", args);
      } catch {
        // taskkill reports an error when the tree already exited; that is the
        // desired terminal state and forced cleanup still proceeds safely.
      }
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

async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    return `${info.mtimeMs}:${info.size}:${info.mode}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

async function filesystemFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[pathKey(path)] = await fileIdentity(path);
    }
  };
  await walk(root);
  return files;
}

async function gitFiles(root: string, top: string): Promise<Record<string, string>> {
  const output = await execFileText("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z", "--", "."]);
  const files: Record<string, string> = {};
  for (const listed of output.split("\0").filter(Boolean)) {
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
  treeKiller?: DelegateProcessTreeKiller;
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
    output: prepareToolResultForContext(output, EXECUTOR_TOOL_RESULT_CONTEXT_CHARS).context,
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

async function terminateDelegateProcess(
  childProcess: DelegateProcess,
  graceMs: number,
  treeKiller: DelegateProcessTreeKiller,
): Promise<void> {
  await treeKiller.signalTree(childProcess, "SIGTERM");
  await delay(graceMs);
  // Always force-signal the whole tree after grace, even when the direct
  // parent already exited: a grandchild may have ignored TERM and outlived it.
  await treeKiller.signalTree(childProcess, "SIGKILL");
  await childProcess.exit;
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
  const permittedStockTools = new Set(rootConfinableDelegateTools(input.config.claude_cli.delegate.allowed_tools));
  const terminalOutput = (
    kind: DelegateOperationTerminal,
    toolCalls: ToolCallRecord[] = [],
    narrative = "",
  ): ExecutorStageOutput => {
    if (kind === "timeout" && !toolCalls.some((record) => DELEGATE_WRITE_TOOLS.has(record.name) && !record.is_error)) {
      input.health.strike("timeout_without_write");
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
    const launchPromise = input.processFactory({ ...invocation, prompt: input.prompt, signal: operation.signal });
    const launchResult = await operation.race(launchPromise);
    if (launchResult.kind === "timeout" || launchResult.kind === "aborted") {
      // A non-cancellable factory may resolve after this method returns. Fence
      // it to cleanup immediately and never continue into stream processing.
      void launchPromise.then(
        (lateProcess) => terminateDelegateProcess(lateProcess, input.terminationGraceMs ?? 10_000, treeKiller),
        () => {},
      );
      return terminalOutput(launchResult.kind);
    }
    if (launchResult.kind === "error") {
      input.health.strike("spawn_error");
      return delegateFailure("delegate_spawn_error", `Failed to spawn Claude delegate: ${String(launchResult.error)}`);
    }
    const delegatedProcess = launchResult.value;
    if (operation.state()) {
      await terminateDelegateProcess(delegatedProcess, input.terminationGraceMs ?? 10_000, treeKiller);
      return terminalOutput(operation.state()!);
    }
    if (invocation.promptOnStdin) delegatedProcess.writeStdin?.(input.prompt);

    const records: ToolCallRecord[] = [];
    const pending = new Map<string, { record: ToolCallRecord; startedAt: number }>();
    const narrative: string[] = [];
    const decodeState: ClaudeStreamDecodeState = { partialTextSeen: false };
    let eventCount = 0;
    let policyViolation = false;
    const execution = (async (): Promise<
      | { kind: "completed"; exit: DelegateProcessExit }
      | { kind: "stream_error"; error: unknown }
    > => {
      try {
        for await (const rawEvent of delegatedProcess.events) {
          const events = decodeClaudeCliMessage(rawEvent, decodeState);
          eventCount += events.length;
          for (const event of events) {
            if (event.type === "stream_event" && event.delta?.text) narrative.push(event.delta.text);
            else if (event.type === "result" && event.content) narrative.push(event.content);
            else if (event.type === "tool_use") {
              const stockToolName = event.tool_name ?? "unknown";
              const permitted = permittedStockTools.has(stockToolName);
              const record: ToolCallRecord = {
                name: mapClaudeDelegateToolName(stockToolName),
                arguments: event.tool_input ?? {},
                output: permitted ? "" : "delegate_tool_not_permitted: tool is outside the root-confinable delegate set.",
                is_error: !permitted,
                ...(!permitted ? { error_code: "policy_denied" as const } : {}),
                duration_ms: 0,
              };
              if (!permitted) policyViolation = true;
              records.push(record);
              pending.set(event.tool_use_id ?? `anonymous-${records.length}`, { record, startedAt: now() });
            } else if (event.type === "tool_result") {
              const match = event.tool_use_id ? pending.get(event.tool_use_id) : undefined;
              if (match) {
                const resultOutput = event.tool_output ?? "";
                match.record.output = prepareToolResultForContext(
                  match.record.error_code === "policy_denied"
                    ? `${match.record.output}\n\nRejected delegate output: ${resultOutput}`
                    : resultOutput,
                  EXECUTOR_TOOL_RESULT_CONTEXT_CHARS,
                ).context;
                if (match.record.error_code !== "policy_denied") match.record.is_error = event.is_error === true;
                match.record.duration_ms = Math.max(0, now() - match.startedAt);
                pending.delete(event.tool_use_id!);
              }
            }
          }
        }
        return { kind: "completed", exit: await delegatedProcess.exit };
      } catch (error) {
        return { kind: "stream_error", error };
      }
    })();

    const executionResult = await operation.race(execution);
    let streamOutcome: { kind: "completed"; exit: DelegateProcessExit } | { kind: "stream_error"; error: unknown };
    if (executionResult.kind === "timeout" || executionResult.kind === "aborted") {
      await terminateDelegateProcess(delegatedProcess, input.terminationGraceMs ?? 10_000, treeKiller);
      streamOutcome = { kind: "stream_error", error: executionResult.kind };
    } else if (executionResult.kind === "error") {
      await terminateDelegateProcess(delegatedProcess, input.terminationGraceMs ?? 10_000, treeKiller);
      streamOutcome = { kind: "stream_error", error: executionResult.error };
    } else {
      streamOutcome = executionResult.value;
      if (streamOutcome.kind === "stream_error") {
        await terminateDelegateProcess(delegatedProcess, input.terminationGraceMs ?? 10_000, treeKiller);
      }
    }

    const terminalBeforePostSnapshot = operation.state();
    const afterResult: GuardedResult<DelegateRootSnapshot[]> = terminalBeforePostSnapshot
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
        record.output = prepareToolResultForContext(unverifiedOutput, EXECUTOR_TOOL_RESULT_CONTEXT_CHARS).context;
        unverifiedWrite = true;
      }
    }
    records.push(gitMetadataRecord(afterSnapshots, verificationAvailable));

    const terminal = operation.state()
      ?? (afterResult.kind === "timeout" || afterResult.kind === "aborted" ? afterResult.kind : undefined);
    if (terminal) {
      if (unverifiedWrite) input.health.strike("unverified_write");
      return terminalOutput(terminal, records, narrative.join(""));
    }
    if (afterResult.kind === "error") narrative.push(`Ground-truth verification failed: ${String(afterResult.error)}`);
    if (unverifiedWrite) {
      input.health.strike("unverified_write");
      return { ok: false, narrative: narrative.join(""), toolCalls: records, terminalStatus: "failed", errorCode: "delegate_write_unverified" };
    }
    if (policyViolation) {
      return { ok: false, narrative: narrative.join(""), toolCalls: records, terminalStatus: "failed", errorCode: "delegate_tool_not_permitted" };
    }
    if (streamOutcome.kind === "stream_error") {
      return { ok: false, narrative: `Claude delegate stream failed: ${String(streamOutcome.error)}`, toolCalls: records, terminalStatus: "failed", errorCode: "delegate_stream_error" };
    }
    if (eventCount === 0) {
      input.health.strike("no_event_exit");
      return { ok: false, narrative: "Claude delegate exited without emitting stream events.", toolCalls: records, terminalStatus: "failed", errorCode: "delegate_no_events" };
    }
    if (streamOutcome.exit.code !== 0) {
      return { ok: false, narrative: narrative.join(""), toolCalls: records, terminalStatus: "failed", errorCode: "delegate_exit_nonzero" };
    }
    input.health.markHealthy();
    return { ok: true, narrative: narrative.join(""), toolCalls: records, terminalStatus: "completed" };
  } finally {
    invocation?.cleanup();
    operation.dispose();
  }
}

export type { ExecutionProfile };
