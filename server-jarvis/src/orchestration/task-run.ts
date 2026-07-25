import { isContinuationTurn, isWorkOrderFollowup } from "./turn-triage";
import { hasWriteIntent, type TurnRequirement } from "./turn-requirements";
import { isDeepReadRequest } from "./evidence-sufficiency";

export type TaskRunDepth = "standard" | "deep";
export type TaskRunStatus = "active" | "paused" | "completed" | "failed" | "cancelled";

/**
 * TaskRunContract schema version.
 * - 1 / missing: legacy (flat remainingWork + numeric evidenceCount only)
 * - 2: TaskPlan ledger with ordered items, acceptance checks, itemized evidence
 */
export type TaskRunSchemaVersion = 1 | 2;

/** Set on read of legacy contracts — Conductor must rebuild the plan before item-level work. */
export type TaskRunReconstructionState = "none" | "reconstruction_required";

/** Per-item ledger status (TaskPlan). Feeds overall TaskRunStatus via deriveTaskStatusFromPlan. */
export type TaskPlanItemStatus = "pending" | "active" | "verified" | "blocked";

/**
 * How an item was accepted.
 * - conductor_direct_diff: Conductor graded the item via direct diff / evidence
 * - reviewer_mediated: Reviewer accepted after Reviewer→Rewriter→Executor cycle(s)
 */
export type TaskPlanGradingMode = "conductor_direct_diff" | "reviewer_mediated";

/**
 * Pointer to durable evidence for a plan item — not a full transcript.
 * Lets the Conductor flush working context after mark-off while still answering
 * "is this done and why" without re-reading history.
 */
export interface TaskPlanEvidencePointer {
  /** Opaque durable reference (turn id, artifact id, store key, etc.). */
  ref: string;
  /** Short human/machine summary of why the item is considered done. */
  summary?: string;
  /** ISO timestamp when the pointer was recorded. */
  recordedAt?: string;
}

export interface TaskPlanAcceptanceCheck {
  id: string;
  description: string;
  /** Optional criterion kind for future automation. */
  kind?: "diff_match" | "test_pass" | "reviewer_pass" | "manual" | string;
}

export interface TaskPlanItem {
  id: string;
  title: string;
  description?: string;
  /** Item ids that must be `verified` before this item may become `active`. */
  dependsOn: string[];
  acceptanceChecks: TaskPlanAcceptanceCheck[];
  status: TaskPlanItemStatus;
  /** Set when verified — which grading path accepted it. */
  gradingMode?: TaskPlanGradingMode;
  /** How many Reviewer→Rewriter→Executor repair passes this item has taken. */
  repairCycleCount: number;
  /** Evidence pointer (not full transcript). */
  evidence?: TaskPlanEvidencePointer;
  blockedReason?: string;
  verifiedAt?: string;
  updatedAt?: string;
}

export interface TaskPlan {
  /** Ordered ledger items. */
  items: TaskPlanItem[];
  /** Id of the currently active item, or null when none is active. */
  activeItemId: string | null;
}

export interface TaskRunContract {
  /**
   * Schema version. Missing on disk is treated as 1 (legacy) by
   * {@link normalizeTaskRunOnRead}. New contracts are always 2.
   */
  schemaVersion: TaskRunSchemaVersion;
  taskRunId: string;
  sessionId: string;
  objective: string;
  workspacePath?: string;
  /** Absolute filesystem roots explicitly granted during this task run. */
  sessionGrants?: string[];
  requirement: TurnRequirement;
  depth: TaskRunDepth;
  estimatedComplexity: "low" | "medium" | "high";
  turnCount: number;
  status: TaskRunStatus;
  /**
   * Turn-level evidence aggregate (tool results gathered this run). Still used
   * by {@link assessTaskRunAcceptance}. Prefer itemized {@link TaskPlanItem.evidence}
   * for plan-level "is this done and why".
   */
  evidenceCount: number;
  /**
   * @deprecated Dead in v1 (always empty). On v2 plan mutations this is derived
   * from non-verified plan item titles for any legacy reader.
   */
  remainingWork: string[];
  /**
   * TaskPlan ledger (v2). Ordered items with deps, acceptance checks, and
   * itemized evidence. Absent or ignored when reconstruction is required.
   */
  plan?: TaskPlan;
  /**
   * Legacy rows (schemaVersion !== 2) are marked `reconstruction_required` on
   * read. New contracts use `none`.
   */
  reconstruction: TaskRunReconstructionState;
  /**
   * 2026-07-18: sticky write intent for the whole task run. Derived from the
   * objective at creation and escalated by any later write-phrased turn, so
   * mid-task follow-ups ("re-execute", "continue") keep the executor's write
   * contract even though the follow-up text itself names no mutation.
   * Optional because pre-existing persisted sessions lack the field.
   */
  writeIntent?: boolean;
  lastOutcome?: string;
  lastTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskPlanItemInput {
  id?: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  acceptanceChecks?: Array<string | TaskPlanAcceptanceCheck>;
}

export interface CreateTaskRunInput {
  taskRunId: string;
  sessionId: string;
  objective: string;
  workspacePath?: string;
  sessionGrants?: string[];
  requirement: TurnRequirement;
  depth?: TaskRunDepth;
  estimatedComplexity?: "low" | "medium" | "high";
  /** Optional ordered plan items to seed the v2 ledger. */
  planItems?: CreateTaskPlanItemInput[];
}

export interface TaskRunAcceptanceInput {
  requirement: TurnRequirement;
  depth: TaskRunDepth;
  pipelineOutcome: "success" | "degraded" | "failed" | "partial";
  answer: string;
  evidenceCount: number;
}

export interface TaskRunAcceptanceResult {
  accepted: boolean;
  status: Extract<TaskRunStatus, "completed" | "paused" | "failed">;
  reason: string;
}

export interface MarkPlanItemVerifiedInput {
  gradingMode: TaskPlanGradingMode;
  evidence: TaskPlanEvidencePointer;
  /** When true (default), activate the next ready pending item. */
  advance?: boolean;
}

export function resolveDeepReadIntent(message: string, depth: TaskRunDepth | undefined): boolean {
  return depth === "deep" || isDeepReadRequest(message);
}

export function terminalSubtypeForRunOutcome(
  outcome: "success" | "degraded" | "failed" | "partial",
): "success" | "partial" | "error" {
  if (outcome === "success") return "success";
  if (outcome === "failed") return "error";
  return "partial";
}

// 2026-07-18 live gap: the synthesizer honestly wrote "partially applied"
// and "could not be confirmed as completed", but this pattern only knew
// "partially complete" — the half-done write task was ACCEPTED as completed,
// the task run's objective/workspace evaporated, and the user's "re-execute"
// minted a fresh objective-less task that wandered into the default
// workspace. Match the honesty vocabulary broadly: a false "paused" merely
// keeps continuation stickiness armed (cheap), a false "completed" strands
// the task (expensive).
const INCOMPLETE_PROGRESS_PATTERN =
  /\b(?:incomplete|unfinished|cut short|partial(?:ly)?|could not be (?:confirmed|completed|applied|written|verified)|not (?:yet )?(?:applied|completed|confirmed|written)|was not (?:applied|modified|updated|written)|remains? (?:unchanged|unmodified|unapplied|to be)|more (?:files|work|evidence)|still (?:need|needs|needed|remains?|pending)|not enough evidence|could not gather|unable to complete|remaining work)\b/i;

function newTaskRunId(): string {
  return `task_${crypto.randomUUID()}`;
}

function newPlanItemId(): string {
  return `pi_${crypto.randomUUID().slice(0, 8)}`;
}

function newAcceptanceCheckId(): string {
  return `ac_${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// 2026-07-21 (F5): isWorkOrderFollowup is deliberately topic-agnostic — any
// short, non-question message during a live task IS a work order, by design
// (see the comment above isWorkOrderFollowup). That is correct for bare
// continuation cues ("go", "continue", "re-execute") which carry no topic of
// their own to compare. It is NOT correct once the message is substantial
// enough to express its own distinct objective: a live repro against a
// PAUSED (incomplete/partial) task run showed an unrelated new request
// ("create a different file in a different directory") being classified as a
// continuation and inheriting the previous, unrelated objective verbatim —
// which then got injected into the new turn's context ("[In-progress task]
// Objective: ...") and drove the executor to attempt the stale sub-task.
//
// This gate only applies to the isWorkOrderFollowup branch of the
// continuation OR-condition; isContinuationTurn (the narrow, explicit
// continuation-phrase list) is untouched — bare cues always continue.
const GENERIC_FOLLOWUP_MAX_CHARS = 48;
const OBJECTIVE_STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "onto", "then", "just", "please",
  "also", "using", "make", "makes", "made", "have", "having", "does", "each",
  "your", "will", "would", "could", "should", "about", "which", "there",
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./\\-]+/i)
      .filter((tok) => tok.length >= 4 && !OBJECTIVE_STOPWORDS.has(tok)),
  );
}

/**
 * Whether `message` plausibly continues `objective`'s topic. A short/generic
 * message (<=48 chars — "go", "continue", "re-execute", "please apply the
 * edits") has no topic of its own to conflict with, so it passes through
 * unconditionally — that preserves the bare-continuation use case this
 * heuristic exists for. A longer, substantial message must share at least one
 * significant token (>=4 chars, path-like tokens included) with the previous
 * objective; otherwise it is treated as an unrelated new request rather than
 * a continuation, so its own objective is not silently discarded.
 */
export function sharesObjectiveSignal(objective: string, message: string): boolean {
  const trimmedMessage = message.trim();
  if (trimmedMessage.length <= GENERIC_FOLLOWUP_MAX_CHARS) return true;
  const objectiveTokens = significantTokens(objective);
  const messageTokens = significantTokens(trimmedMessage);
  // Fail open when there is nothing concrete to compare — do not regress a
  // case this heuristic previously admitted just because both sides happen
  // to be token-poor.
  if (objectiveTokens.size === 0 || messageTokens.size === 0) return true;
  for (const token of messageTokens) {
    if (objectiveTokens.has(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// TaskPlan ledger — constructors
// ---------------------------------------------------------------------------

export function makeEvidencePointer(
  ref: string,
  summary?: string,
  recordedAt: string = nowIso(),
): TaskPlanEvidencePointer {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error("makeEvidencePointer: ref must be non-empty");
  }
  const pointer: TaskPlanEvidencePointer = { ref: trimmed, recordedAt };
  if (summary?.trim()) pointer.summary = summary.trim();
  return pointer;
}

export function hasEvidencePointer(item: TaskPlanItem): boolean {
  return Boolean(item.evidence?.ref?.trim());
}

export function createAcceptanceCheck(
  description: string,
  opts: { id?: string; kind?: TaskPlanAcceptanceCheck["kind"] } = {},
): TaskPlanAcceptanceCheck {
  const desc = description.trim();
  if (!desc) throw new Error("createAcceptanceCheck: description must be non-empty");
  const check: TaskPlanAcceptanceCheck = {
    id: opts.id?.trim() || newAcceptanceCheckId(),
    description: desc,
  };
  if (opts.kind) check.kind = opts.kind;
  return check;
}

function normalizeAcceptanceChecks(
  checks: Array<string | TaskPlanAcceptanceCheck> | undefined,
): TaskPlanAcceptanceCheck[] {
  if (!checks?.length) return [];
  return checks.map((entry) => {
    if (typeof entry === "string") return createAcceptanceCheck(entry);
    const description = entry.description?.trim() || "acceptance check";
    return {
      id: entry.id?.trim() || newAcceptanceCheckId(),
      description,
      ...(entry.kind ? { kind: entry.kind } : {}),
    };
  });
}

export function createTaskPlanItem(input: CreateTaskPlanItemInput): TaskPlanItem {
  const title = input.title.trim();
  if (!title) throw new Error("createTaskPlanItem: title must be non-empty");
  const now = nowIso();
  return {
    id: input.id?.trim() || newPlanItemId(),
    title,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    dependsOn: [...(input.dependsOn ?? [])],
    acceptanceChecks: normalizeAcceptanceChecks(input.acceptanceChecks),
    status: "pending",
    repairCycleCount: 0,
    updatedAt: now,
  };
}

export function createTaskPlan(items: CreateTaskPlanItemInput[] = []): TaskPlan {
  return {
    items: items.map((item) => createTaskPlanItem(item)),
    activeItemId: null,
  };
}

export function emptyTaskPlan(): TaskPlan {
  return { items: [], activeItemId: null };
}

// ---------------------------------------------------------------------------
// TaskPlan ledger — queries
// ---------------------------------------------------------------------------

export function getPlanItem(contract: TaskRunContract, itemId: string): TaskPlanItem | undefined {
  return contract.plan?.items.find((item) => item.id === itemId);
}

export function getActivePlanItem(contract: TaskRunContract): TaskPlanItem | undefined {
  const plan = contract.plan;
  if (!plan?.activeItemId) return undefined;
  return plan.items.find((item) => item.id === plan.activeItemId);
}

export function listPendingPlanItems(contract: TaskRunContract): TaskPlanItem[] {
  return (contract.plan?.items ?? []).filter((item) => item.status === "pending");
}

export function listVerifiedPlanItems(contract: TaskRunContract): TaskPlanItem[] {
  return (contract.plan?.items ?? []).filter((item) => item.status === "verified");
}

export function listBlockedPlanItems(contract: TaskRunContract): TaskPlanItem[] {
  return (contract.plan?.items ?? []).filter((item) => item.status === "blocked");
}

/** Titles of non-verified items — used to populate legacy remainingWork. */
export function remainingWorkFromPlan(plan: TaskPlan): string[] {
  return plan.items
    .filter((item) => item.status !== "verified")
    .map((item) => item.title);
}

/** Count of items that carry an evidence pointer. */
export function countItemizedEvidence(plan: TaskPlan): number {
  return plan.items.filter((item) => hasEvidencePointer(item)).length;
}

export function planItemDependenciesSatisfied(
  item: TaskPlanItem,
  items: readonly TaskPlanItem[],
): boolean {
  if (item.dependsOn.length === 0) return true;
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  return item.dependsOn.every((depId) => byId.get(depId)?.status === "verified");
}

/**
 * Overall task status derived from plan item statuses.
 * - all verified → completed
 * - any blocked → paused
 * - otherwise active (including empty plan)
 * Does not emit failed/cancelled (those remain explicit operator/pipeline outcomes).
 */
export function deriveTaskStatusFromPlan(
  plan: TaskPlan,
): Extract<TaskRunStatus, "active" | "paused" | "completed"> {
  if (plan.items.length === 0) return "active";
  if (plan.items.every((item) => item.status === "verified")) return "completed";
  if (plan.items.some((item) => item.status === "blocked")) return "paused";
  return "active";
}

/**
 * Reconcile end-of-turn acceptance status with the TaskPlan ledger.
 *
 * Mid-turn ledger mutations set overall status via {@link deriveTaskStatusFromPlan}.
 * Historically, post-pipeline {@link assessTaskRunAcceptance} then *unconditionally*
 * overwrote that status from synthesizer prose / evidence floors — so a multi-item
 * plan with only item 1 verified could become `completed` while items 2–N remained
 * pending. Prefer the ledger when it still has work; keep turn authority for
 * terminal failure and for legacy/no-plan contracts.
 *
 * - forcePaused (repetition guard) → paused
 * - turn failed → failed (terminal failure authority)
 * - v2 plan with items and reconstruction === "none":
 *   - plan active/paused (work remaining or blocked) beats turn `completed`
 *   - plan completed (all verified) → completed (failed already handled)
 *   - turn paused with plan still open → paused (pipeline partial / incomplete prose)
 * - no plan / legacy / reconstruction_required → turnAcceptanceStatus
 */
export function reconcileTaskRunStatus(input: {
  contract: TaskRunContract;
  turnAcceptanceStatus: Extract<TaskRunStatus, "completed" | "paused" | "failed">;
  forcePaused?: boolean;
}): TaskRunStatus {
  if (input.forcePaused) return "paused";

  const turn = input.turnAcceptanceStatus;
  if (turn === "failed") return "failed";

  const { contract } = input;
  const plan = contract.plan;
  const hasLivePlan =
    contract.schemaVersion === 2 &&
    contract.reconstruction === "none" &&
    !!plan &&
    plan.items.length > 0;

  if (!hasLivePlan) {
    return turn;
  }

  const planStatus = deriveTaskStatusFromPlan(plan);

  // Ledger still has open work (pending/active) or blocked items: never promote
  // to completed from turn-level synthesizer acceptance alone.
  if (planStatus === "active" || planStatus === "paused") {
    if (turn === "completed") return planStatus;
    // turn is paused: keep paused whether plan is active or blocked.
    return "paused";
  }

  // All items verified → overall completed (turn failed already returned above).
  return "completed";
}

export function isTaskRunV2(contract: TaskRunContract): boolean {
  return contract.schemaVersion === 2 && contract.reconstruction !== "reconstruction_required";
}

// ---------------------------------------------------------------------------
// TaskPlan ledger — mutations (pure; return new contract)
// ---------------------------------------------------------------------------

function requirePlan(contract: TaskRunContract): TaskPlan {
  if (!isTaskRunV2(contract)) {
    throw new Error("TaskPlan ledger requires schemaVersion 2 without reconstruction_required");
  }
  return contract.plan ?? emptyTaskPlan();
}

function withUpdatedPlan(contract: TaskRunContract, plan: TaskPlan, updatedAt = nowIso()): TaskRunContract {
  const nextStatus =
    ["failed", "cancelled"].includes(contract.status)
      ? contract.status
      : plan.items.length > 0
        ? deriveTaskStatusFromPlan(plan)
        : contract.status;
  return {
    ...contract,
    schemaVersion: 2,
    reconstruction: "none",
    plan,
    remainingWork: remainingWorkFromPlan(plan),
    status: nextStatus,
    updatedAt,
  };
}

function mapPlanItem(
  contract: TaskRunContract,
  itemId: string,
  mapper: (item: TaskPlanItem) => TaskPlanItem,
): TaskRunContract {
  const plan = requirePlan(contract);
  const index = plan.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    throw new Error(`TaskPlan item not found: ${itemId}`);
  }
  const items = plan.items.slice();
  items[index] = mapper(items[index]);
  const activeItemId =
    plan.activeItemId && items.some((item) => item.id === plan.activeItemId && item.status === "active")
      ? plan.activeItemId
      : items.find((item) => item.status === "active")?.id ?? null;
  return withUpdatedPlan(contract, { items, activeItemId });
}

/** Replace/set the entire plan (e.g. after Conductor reconstruction). */
export function setTaskPlan(
  contract: TaskRunContract,
  items: CreateTaskPlanItemInput[],
  opts: { activateFirst?: boolean } = {},
): TaskRunContract {
  const plan = createTaskPlan(items);
  let next = withUpdatedPlan(
    {
      ...contract,
      schemaVersion: 2,
      reconstruction: "none",
    },
    plan,
  );
  if (opts.activateFirst !== false && plan.items.length > 0) {
    next = advancePlanQueue(next);
  }
  return next;
}

/**
 * Activate the first pending item whose dependencies are all verified.
 * No-op when an item is already active, or when no ready pending item exists.
 */
export function advancePlanQueue(contract: TaskRunContract): TaskRunContract {
  const plan = requirePlan(contract);
  const existingActive = plan.items.find((item) => item.status === "active");
  if (existingActive) {
    if (plan.activeItemId === existingActive.id) return contract;
    return withUpdatedPlan(contract, { ...plan, activeItemId: existingActive.id });
  }

  const items = plan.items.map((item) => ({ ...item }));
  let activeItemId: string | null = null;
  const now = nowIso();
  for (const item of items) {
    if (item.status !== "pending") continue;
    if (!planItemDependenciesSatisfied(item, items)) continue;
    item.status = "active";
    item.updatedAt = now;
    activeItemId = item.id;
    break;
  }
  return withUpdatedPlan(contract, { items, activeItemId }, now);
}

/** Force a specific pending item active (deps must be satisfied). */
export function activatePlanItem(contract: TaskRunContract, itemId: string): TaskRunContract {
  const plan = requirePlan(contract);
  const target = plan.items.find((item) => item.id === itemId);
  if (!target) throw new Error(`TaskPlan item not found: ${itemId}`);
  if (target.status === "verified") {
    throw new Error(`cannot activate verified item: ${itemId}`);
  }
  if (target.status === "blocked") {
    throw new Error(`cannot activate blocked item: ${itemId}`);
  }
  if (!planItemDependenciesSatisfied(target, plan.items)) {
    throw new Error(`dependencies not satisfied for item: ${itemId}`);
  }

  const now = nowIso();
  const items = plan.items.map((item) => {
    if (item.id === itemId) {
      return { ...item, status: "active" as const, updatedAt: now, blockedReason: undefined };
    }
    if (item.status === "active") {
      return { ...item, status: "pending" as const, updatedAt: now };
    }
    return item;
  });
  return withUpdatedPlan(contract, { items, activeItemId: itemId }, now);
}

/**
 * Mark an item verified, store grading mode + evidence pointer, optionally
 * advance the queue to the next ready item.
 */
export function markPlanItemVerified(
  contract: TaskRunContract,
  itemId: string,
  input: MarkPlanItemVerifiedInput,
): TaskRunContract {
  const evidence = makeEvidencePointer(
    input.evidence.ref,
    input.evidence.summary,
    input.evidence.recordedAt ?? nowIso(),
  );
  const now = nowIso();
  let next = mapPlanItem(contract, itemId, (item) => ({
    ...item,
    status: "verified",
    gradingMode: input.gradingMode,
    evidence,
    verifiedAt: now,
    updatedAt: now,
    blockedReason: undefined,
  }));
  if (input.advance !== false) {
    next = advancePlanQueue(next);
  }
  return next;
}

/** Mark an item blocked with a reason (Conductor / Reviewer stall). */
export function markPlanItemBlocked(
  contract: TaskRunContract,
  itemId: string,
  reason: string,
): TaskRunContract {
  const blockedReason = reason.trim() || "blocked";
  const now = nowIso();
  return mapPlanItem(contract, itemId, (item) => ({
    ...item,
    status: "blocked",
    blockedReason,
    updatedAt: now,
  }));
}

/** Clear blocked status back to pending (does not auto-activate). */
export function unblockPlanItem(contract: TaskRunContract, itemId: string): TaskRunContract {
  const now = nowIso();
  return mapPlanItem(contract, itemId, (item) => {
    if (item.status !== "blocked") return item;
    return {
      ...item,
      status: "pending",
      blockedReason: undefined,
      updatedAt: now,
    };
  });
}

/** Increment Reviewer→Rewriter→Executor repair-cycle count for an item. */
export function incrementPlanItemRepairCycle(
  contract: TaskRunContract,
  itemId: string,
  by = 1,
): TaskRunContract {
  if (!Number.isFinite(by) || by <= 0) {
    throw new Error("incrementPlanItemRepairCycle: by must be a positive number");
  }
  const now = nowIso();
  return mapPlanItem(contract, itemId, (item) => ({
    ...item,
    repairCycleCount: item.repairCycleCount + by,
    updatedAt: now,
  }));
}

/** Attach or replace an evidence pointer without changing status. */
export function setPlanItemEvidence(
  contract: TaskRunContract,
  itemId: string,
  evidence: TaskPlanEvidencePointer,
): TaskRunContract {
  const pointer = makeEvidencePointer(evidence.ref, evidence.summary, evidence.recordedAt ?? nowIso());
  const now = nowIso();
  return mapPlanItem(contract, itemId, (item) => ({
    ...item,
    evidence: pointer,
    updatedAt: now,
  }));
}

// ---------------------------------------------------------------------------
// Legacy read path
// ---------------------------------------------------------------------------

/**
 * Normalize a persisted task-run blob on read.
 *
 * Legacy rows (missing schemaVersion or schemaVersion !== 2) are marked
 * `reconstruction_required`. There is no structural migration: remainingWork
 * was never populated in production, so every pre-v2 row needs a fresh plan.
 */
export function normalizeTaskRunOnRead(raw: unknown): TaskRunContract | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.taskRunId !== "string" || typeof r.sessionId !== "string") return undefined;
  if (typeof r.objective !== "string") return undefined;

  const schemaVersion: TaskRunSchemaVersion = r.schemaVersion === 2 ? 2 : 1;
  const requirement = (typeof r.requirement === "string" ? r.requirement : "conversational") as TurnRequirement;
  const depth: TaskRunDepth = r.depth === "deep" ? "deep" : "standard";
  const estimatedComplexity =
    r.estimatedComplexity === "low" || r.estimatedComplexity === "high"
      ? r.estimatedComplexity
      : "medium";
  const status = isTaskRunStatus(r.status) ? r.status : "active";
  const base: TaskRunContract = {
    schemaVersion,
    taskRunId: r.taskRunId,
    sessionId: r.sessionId,
    objective: r.objective,
    workspacePath: typeof r.workspacePath === "string" ? r.workspacePath : undefined,
    sessionGrants: Array.isArray(r.sessionGrants)
      ? r.sessionGrants.filter((g): g is string => typeof g === "string")
      : [],
    requirement,
    depth,
    estimatedComplexity,
    turnCount: typeof r.turnCount === "number" && Number.isFinite(r.turnCount) ? r.turnCount : 1,
    status,
    evidenceCount: typeof r.evidenceCount === "number" && Number.isFinite(r.evidenceCount) ? r.evidenceCount : 0,
    remainingWork: Array.isArray(r.remainingWork)
      ? r.remainingWork.filter((w): w is string => typeof w === "string")
      : [],
    writeIntent: typeof r.writeIntent === "boolean" ? r.writeIntent : undefined,
    lastOutcome: typeof r.lastOutcome === "string" ? r.lastOutcome : undefined,
    lastTurnId: typeof r.lastTurnId === "string" ? r.lastTurnId : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
    reconstruction: "none",
  };

  if (schemaVersion !== 2) {
    return {
      ...base,
      schemaVersion: 1,
      reconstruction: "reconstruction_required",
      // Do not trust a partial plan on legacy rows.
      plan: undefined,
    };
  }

  const plan = normalizePlanOnRead(r.plan);
  return {
    ...base,
    schemaVersion: 2,
    reconstruction: r.reconstruction === "reconstruction_required" ? "reconstruction_required" : "none",
    plan,
    remainingWork: plan ? remainingWorkFromPlan(plan) : base.remainingWork,
  };
}

function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return value === "active"
    || value === "paused"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}

function isPlanItemStatus(value: unknown): value is TaskPlanItemStatus {
  return value === "pending" || value === "active" || value === "verified" || value === "blocked";
}

function normalizePlanOnRead(raw: unknown): TaskPlan | undefined {
  if (!raw || typeof raw !== "object") return emptyTaskPlan();
  const p = raw as Record<string, unknown>;
  const rawItems = Array.isArray(p.items) ? p.items : [];
  const items: TaskPlanItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") continue;
    const acceptanceChecks = Array.isArray(item.acceptanceChecks)
      ? item.acceptanceChecks
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => ({
          id: typeof c.id === "string" ? c.id : newAcceptanceCheckId(),
          description: typeof c.description === "string" ? c.description : "acceptance check",
          ...(typeof c.kind === "string" ? { kind: c.kind } : {}),
        }))
      : [];
    let evidence: TaskPlanEvidencePointer | undefined;
    if (item.evidence && typeof item.evidence === "object") {
      const ev = item.evidence as Record<string, unknown>;
      if (typeof ev.ref === "string" && ev.ref.trim()) {
        evidence = {
          ref: ev.ref.trim(),
          ...(typeof ev.summary === "string" ? { summary: ev.summary } : {}),
          ...(typeof ev.recordedAt === "string" ? { recordedAt: ev.recordedAt } : {}),
        };
      }
    }
    const gradingMode =
      item.gradingMode === "conductor_direct_diff" || item.gradingMode === "reviewer_mediated"
        ? item.gradingMode
        : undefined;
    items.push({
      id: item.id,
      title: item.title,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      dependsOn: Array.isArray(item.dependsOn)
        ? item.dependsOn.filter((d): d is string => typeof d === "string")
        : [],
      acceptanceChecks,
      status: isPlanItemStatus(item.status) ? item.status : "pending",
      ...(gradingMode ? { gradingMode } : {}),
      repairCycleCount:
        typeof item.repairCycleCount === "number" && Number.isFinite(item.repairCycleCount)
          ? Math.max(0, item.repairCycleCount)
          : 0,
      ...(evidence ? { evidence } : {}),
      ...(typeof item.blockedReason === "string" ? { blockedReason: item.blockedReason } : {}),
      ...(typeof item.verifiedAt === "string" ? { verifiedAt: item.verifiedAt } : {}),
      ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
    });
  }
  const activeItemId =
    typeof p.activeItemId === "string" && items.some((item) => item.id === p.activeItemId)
      ? p.activeItemId
      : items.find((item) => item.status === "active")?.id ?? null;
  return { items, activeItemId };
}

// ---------------------------------------------------------------------------
// create / resolve / accept (existing surface)
// ---------------------------------------------------------------------------

export function createTaskRun(input: CreateTaskRunInput): TaskRunContract {
  const now = nowIso();
  const plan = createTaskPlan(input.planItems ?? []);
  let contract: TaskRunContract = {
    schemaVersion: 2,
    reconstruction: "none",
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    workspacePath: input.workspacePath,
    sessionGrants: input.sessionGrants ?? [],
    requirement: input.requirement,
    depth: input.depth ?? "standard",
    estimatedComplexity: input.estimatedComplexity ?? "medium",
    turnCount: 1,
    status: "active",
    evidenceCount: 0,
    remainingWork: remainingWorkFromPlan(plan),
    plan,
    writeIntent: input.requirement === "full_execution" && hasWriteIntent(input.objective),
    createdAt: now,
    updatedAt: now,
  };
  if (plan.items.length > 0) {
    contract = advancePlanQueue(contract);
  }
  return contract;
}

export function resolveTaskRunTurn(
  previous: TaskRunContract | undefined,
  message: string,
  classifiedRequirement: TurnRequirement,
  options: Partial<Pick<CreateTaskRunInput, "sessionId" | "workspacePath" | "sessionGrants" | "estimatedComplexity" | "depth" | "planItems">> = {},
): { contract: TaskRunContract; isContinuation: boolean } {
  const previousLive = Boolean(
    previous && !["completed", "failed", "cancelled"].includes(previous.status),
  );
  // 2026-07-18 polarity flip (mirrors resolveTurnRequirement): during a live
  // full-execution task, any short non-question work order resumes the task
  // run — otherwise "re-execute" mints a NEW task whose objective is the
  // literal word "re-execute" and every sticky property (workspace, depth,
  // write intent) is lost.
  const continuation = previousLive && (
    isContinuationTurn(message) ||
    (previous!.requirement === "full_execution" &&
      isWorkOrderFollowup(message) &&
      sharesObjectiveSignal(previous!.objective, message))
  );

  if (continuation && previous) {
    // Ensure continuation contracts carry v2 shape when previous was already v2.
    const base = previous.schemaVersion === 2
      ? previous
      : normalizeTaskRunOnRead(previous) ?? previous;
    return {
      isContinuation: true,
      contract: {
        ...base,
        sessionGrants: Array.from(new Set([
          ...(base.sessionGrants ?? []),
          ...(options.sessionGrants ?? []),
        ])),
        turnCount: base.turnCount + 1,
        status: "active",
        // A write-phrased follow-up escalates a read task's contract; write
        // intent never de-escalates while the same task run is live.
        writeIntent: base.writeIntent === true ||
          (base.requirement === "full_execution" && hasWriteIntent(message)),
        lastOutcome: undefined,
        updatedAt: nowIso(),
      },
    };
  }

  return {
    isContinuation: false,
    contract: createTaskRun({
      taskRunId: newTaskRunId(),
      sessionId: options.sessionId ?? previous?.sessionId ?? "unknown",
      objective: message,
      workspacePath: options.workspacePath ?? previous?.workspacePath,
      sessionGrants: options.sessionGrants,
      requirement: classifiedRequirement,
      depth: options.depth ?? "standard",
      estimatedComplexity: options.estimatedComplexity ?? "medium",
      planItems: options.planItems,
    }),
  };
}

export function assessTaskRunAcceptance(input: TaskRunAcceptanceInput): TaskRunAcceptanceResult {
  const answer = input.answer.trim();
  // F9: a failed/empty turn that still gathered evidence must *pause* so
  // "continue…" resumes the real objective/workspace/depth instead of minting
  // a new task run whose objective is the literal word "continue".
  if (input.pipelineOutcome === "failed" || !answer) {
    return input.evidenceCount > 0
      ? { accepted: false, status: "paused", reason: "pipeline_failed_with_evidence" }
      : { accepted: false, status: "failed", reason: "pipeline_failed_or_empty" };
  }
  if (input.pipelineOutcome === "partial") {
    return { accepted: false, status: "paused", reason: "pipeline_partial" };
  }
  if (INCOMPLETE_PROGRESS_PATTERN.test(answer)) {
    return { accepted: false, status: "paused", reason: "answer_declares_incomplete_progress" };
  }
  if (input.depth === "deep" && input.evidenceCount < 3) {
    return { accepted: false, status: "paused", reason: "deep_task_evidence_floor_not_met" };
  }
  if ((input.requirement === "workspace_read" || input.requirement === "full_execution") && input.evidenceCount < 1) {
    return { accepted: false, status: "paused", reason: "workspace_task_has_no_evidence" };
  }
  return { accepted: true, status: "completed", reason: "objective_completion_contract_met" };
}
