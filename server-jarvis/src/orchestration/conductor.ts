import { loadPrompt } from "./prompt-loader";
import { ConductorBus, type ConductorDirective, type StageEvent } from "./conductor-bus";
import { extractJson } from "./json";
import type { CallModelFn, Complexity } from "./coordinator";
import { AgentPool } from "./agent-pool";
import type { StageName } from "./coordinator";
import type { EvidenceAssessment } from "./evidence-sufficiency";
import { assessWorkspaceEvidence, isDeepReadRequest } from "./evidence-sufficiency";
import { EVIDENCE_CAPABLE_STAGES } from "./reroute-policy";
import { WRITE_EFFECT_TOOLS } from "./effect-gate";
import type { ToolCallRecord } from "./stage-output";
import type { TaskPlanItem, TaskRunContract } from "./task-run";
import { getActivePlanItem } from "./task-run";
import {
  buildAutomaticRepairChainStages,
  decideRepairChain,
  gradeViaDirectDiff,
  mergeRepairChainIntoRemaining,
  reviewerFeedbackIsInsufficient,
  shouldEscalateToReviewer,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_REPAIR_CYCLES,
} from "./runtime-loop";
import { parseReviewerVerdict } from "./stage-output";

export interface ConductorStageEvidence {
  toolCalls?: ToolCallRecord[];
  request?: string;
  workerInstruction?: string;
  workspaceRoot?: string;
  workspaceRoots?: string[];
  /**
   * 2026-07-18: sticky/derived write intent for the turn. Without it the
   * conductor was WRITE-BLIND — a change-request executor stage that
   * completed with zero mutations had no failure, no tool errors, and no
   * read-evidence gap, so supervision returned a free "continue" (every
   * directive in the incident DB was "continue").
   */
  writeIntent?: boolean;
  /**
   * Owned-runtime-loop: active plan item id for per-item grading. When set
   * with planItem (or resolved via setPlanContext), afterStage can emit
   * mark_verified / escalate_reviewer / start_repair_chain.
   */
  planItemId?: string;
  planItem?: TaskPlanItem;
  /** Evidence pointer ref when marking verified (defaults to runId:stage). */
  evidenceRef?: string;
}

interface SupervisionDigest {
  stage: StageName;
  outcome: "completed" | "failed";
  outputSummary: string;  // first 500 chars of stage output or error
  recentToolErrors: string[];  // last N isError tool results
  toolCallCounts: Record<string, number>;
  toolErrorCount: number;
  /** Only set for evidence-capable stages (executor/rewriter). */
  evidenceAssessment?: EvidenceAssessment;
  requestSummary: string;
  workerInstruction: string;
  remainingQueue: StageName[];
  /** 2026-07-18: write contract visibility for the supervisor model. */
  writeIntent: boolean;
  successfulWrites: number;
}

/**
 * F7: supervise only when there is something to supervise — failures, tool
 * errors, or evidence gaps on evidence-capable stages. Clean planner/reviewer
 * completions are free (deterministic continue). Cap at 4 inferences/run.
 */
export function shouldSuperviseStage(args: {
  supervisionEnabled: boolean;
  outcome: "completed" | "failed";
  stage: StageName | string;
  remainingQueue: StageName[];
  consecutiveToolErrors: number;
  evidenceGap: boolean;
  supervisionCallsUsed: number;
}): boolean {
  if (!args.supervisionEnabled || args.remainingQueue.length === 0) return false;
  if (args.supervisionCallsUsed >= 4) return false;
  if (args.outcome === "failed") return true;
  if (args.consecutiveToolErrors > 0) return true;
  return EVIDENCE_CAPABLE_STAGES.has(args.stage) && args.evidenceGap;
}

export interface SupervisionAttribution {
  agentRunId: string;
  durationMs: number;
  wasSuccessful: boolean;
  hadError: boolean;
  provider?: string;
  modelId?: string;
}

export class LiveConductor {
  private supervision: "on" | "off" = "on";
  private taskType = "general";
  private complexity: Complexity = "medium";
  private consecutiveToolErrors = 0;
  private recentToolErrors: string[] = [];
  private runId = "";
  private deepReadEvidenceRerouteUsed = false;
  /** 2026-07-18: one deterministic write-effect reroute per run (mirrors deep-read). */
  private writeEffectRerouteUsed = false;
  /** F7: per-run supervision inference counter (reset in setContext). */
  private supervisionCallsUsed = 0;
  /** Owned-runtime-loop: optional TaskPlan contract for per-item grading. */
  private planContract: TaskRunContract | undefined;
  /** Max repair cycles per item (from cfg or default). */
  private maxRepairCycles = DEFAULT_MAX_REPAIR_CYCLES;

  constructor(
    private callModel: CallModelFn,
    private bus: ConductorBus,
    private pool: AgentPool,
    private cfg: {
      supervision_timeout_ms: number;
      max_tool_errors_before_reroute: number;
      supervise_low_complexity: boolean;
      /** Optional override for automatic repair-chain cycles. */
      max_repair_cycles?: number;
    },
    /** Local supervisor path; defaults to callModel for backwards compatibility. */
    private supervisorModel: CallModelFn = callModel,
    /** F7/F10a: optional attribution sink for conductor_supervision rows. */
    private onSupervisionAttributed?: (row: SupervisionAttribution) => void,
  ) {
    if (typeof cfg.max_repair_cycles === "number" && Number.isFinite(cfg.max_repair_cycles)) {
      this.maxRepairCycles = Math.max(0, Math.floor(cfg.max_repair_cycles));
    }
  }

  setContext(taskType: string, complexity: "low" | "medium" | "high", runId: string): void {
    this.taskType = taskType;
    this.complexity = complexity;
    this.runId = runId;
    this.deepReadEvidenceRerouteUsed = false;
    this.writeEffectRerouteUsed = false;
    this.supervisionCallsUsed = 0;
    this.supervision = !this.cfg.supervise_low_complexity && complexity === "low" ? "off" : "on";
  }

  /**
   * Bind the current TaskPlan ledger for per-item grading in afterStage.
   * Pass undefined to clear (e.g. end of turn).
   */
  setPlanContext(contract: TaskRunContract | undefined): void {
    this.planContract = contract;
  }

  getPlanContext(): TaskRunContract | undefined {
    return this.planContract;
  }

  /** Expose consecutive tool-error count for runtime-loop backstop reuse. */
  getConsecutiveToolErrors(): number {
    return this.consecutiveToolErrors;
  }

  // Called from the executor/rewriter tool loop for each tool result
  onToolResult(stage: StageName, name: string, isError: boolean, summary: string): void {
    if (isError) {
      this.consecutiveToolErrors++;
      this.recentToolErrors.push(`${name}: ${summary.slice(0, 240)}`);
      this.recentToolErrors = this.recentToolErrors.slice(-3);
    } else {
      this.consecutiveToolErrors = 0;
    }
    this.bus.publish({ type: "tool_result", stage, name, isError, summary });
  }

  // Called after each stage completes or fails. NEVER throws — always returns a directive.
  async afterStage(
    stage: StageName,
    outcome: "completed" | "failed",
    output: string,
    remainingQueue: StageName[],
    evidence: ConductorStageEvidence = {},
  ): Promise<ConductorDirective> {
    try {
      // Cheap heuristic pre-filter: if tool errors hit threshold, reroute immediately
      // without spending a supervisory inference call.
      // Reuses consecutiveToolErrors as the sole no-progress / backstop signal
      // (owned-runtime-loop model §9 — do not invent a parallel counter).
      if (this.cfg.max_tool_errors_before_reroute > 0 && this.consecutiveToolErrors >= this.cfg.max_tool_errors_before_reroute) {
        this.consecutiveToolErrors = 0;
        this.recentToolErrors = [];
        return {
          type: "reroute",
          newRemaining: ["re-enter:planner" as StageName, "executor" as StageName, "synthesizer" as StageName],
          reason: "consecutive tool errors reached threshold — re-entering planner",
        };
      }

      const successfulWrites = (evidence.toolCalls ?? []).filter(
        (call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name),
      ).length;

      // 2026-07-18 / Task 5 review: write-effect fence MUST run before
      // runtime-loop escalate_reviewer. Otherwise medium/high complexity + plan
      // item returns escalate and skips the one free executor re-enter that
      // actually applies the mutation. Prefer fence first when
      // writeIntent && successfulWrites===0.
      if (
        stage === "executor" &&
        outcome === "completed" &&
        evidence.writeIntent === true &&
        successfulWrites === 0 &&
        remainingQueue.length > 0 &&
        !this.writeEffectRerouteUsed
      ) {
        this.writeEffectRerouteUsed = true;
        return {
          type: "reroute",
          newRemaining: ["re-enter:executor" as StageName, ...remainingQueue],
          reason: "write-intent executor stage completed with zero successful mutations; re-entering executor once to APPLY the change with write_file/edit_file before continuing",
        };
      }

      // Owned-runtime-loop: per-item completion / repair directives (deterministic
      // first — no supervisory model call). Runs after write-effect fence so
      // escalate_reviewer cannot skip a needed write re-enter.
      const runtimeDirective = this.runtimeLoopDirective(stage, outcome, output, remainingQueue, evidence);
      if (runtimeDirective) return runtimeDirective;

      // F1: only evidence-capable stages get a workspace-evidence rubric.
      // Planner/reviewer/synthesizer digests must not claim "sufficient:false".
      const evidenceAssessment = EVIDENCE_CAPABLE_STAGES.has(stage)
        ? assessWorkspaceEvidence(
          evidence.toolCalls,
          evidence.request ?? "",
          evidence.workspaceRoots ?? evidence.workspaceRoot,
        )
        : undefined;
      if (
        stage === "executor" &&
        outcome === "completed" &&
        evidence.request &&
        isDeepReadRequest(evidence.request) &&
        evidenceAssessment &&
        !evidenceAssessment.sufficient &&
        !this.deepReadEvidenceRerouteUsed
      ) {
        this.deepReadEvidenceRerouteUsed = true;
        return {
          type: "reroute",
          newRemaining: ["re-enter:executor" as StageName, ...remainingQueue],
          reason: `deep-read evidence insufficient after completed executor stage: ${evidenceAssessment.reason}; re-entering executor once before continuing`,
        };
      }

      const writeGap = evidence.writeIntent === true && successfulWrites === 0;
      const evidenceGap = Boolean(
        evidenceAssessment && !evidenceAssessment.sufficient,
      ) || writeGap;
      if (!shouldSuperviseStage({
        supervisionEnabled: this.supervision === "on",
        outcome,
        stage,
        remainingQueue,
        consecutiveToolErrors: this.consecutiveToolErrors,
        evidenceGap,
        supervisionCallsUsed: this.supervisionCallsUsed,
      })) return { type: "continue" };

      const evidenceErrors = evidence.toolCalls === undefined
        ? undefined
        : recentToolErrorsFromEvidence(evidence.toolCalls);
      const digest: SupervisionDigest = {
        stage,
        outcome,
        outputSummary: output.slice(0, 500),
        recentToolErrors: evidenceErrors ?? [...this.recentToolErrors],
        toolCallCounts: toolCallCountsByName(evidence.toolCalls),
        toolErrorCount: evidence.toolCalls
          ? evidence.toolCalls.filter((call) => call.is_error).length
          : this.recentToolErrors.length,
        evidenceAssessment,
        requestSummary: (evidence.request ?? "").slice(0, 300),
        workerInstruction: evidence.workerInstruction ?? "",
        remainingQueue,
        writeIntent: evidence.writeIntent === true,
        successfulWrites,
      };

      this.supervisionCallsUsed += 1;
      const directive = await this.supervise(digest);
      this.recentToolErrors = [];
      // Admission is enforced in pipeline.afterConductorStage (rejectReroute)
      // so illegal model directives are audited as directive_type=reroute_rejected.
      return directive;
    } catch {
      return { type: "continue" };
    }
  }

  /**
   * Owned-runtime-loop verdict path (Task 5).
   * - Executor completed + low complexity → direct-diff grade → mark_verified or continue
   * - Executor completed + medium/high (or reviewer_pass checks) → escalate_reviewer
   * - Reviewer completed + accept → mark_verified (reviewer_mediated)
   * - Reviewer completed + insufficient → start_repair_chain (deterministic; no model)
   * - Backstop via consecutiveToolErrors / repairCycleCount → block_item
   *
   * Returns null when the runtime-loop has nothing to say (fall through to
   * existing evidence fences + supervision).
   */
  private runtimeLoopDirective(
    stage: StageName,
    outcome: "completed" | "failed",
    output: string,
    remainingQueue: StageName[],
    evidence: ConductorStageEvidence,
  ): ConductorDirective | null {
    const item = this.resolvePlanItem(evidence);
    if (!item) return null;

    // --- Reviewer stage: accept → verify; insufficient → automatic repair chain ---
    if (stage === "reviewer" && outcome === "completed") {
      const insufficient = reviewerFeedbackIsInsufficient(output);
      if (!insufficient) {
        const verdict = parseReviewerVerdict(output);
        if (verdict === "accept" || !this.hasIssuesHeuristic(output)) {
          return {
            type: "mark_verified",
            itemId: item.id,
            evidenceRef: evidence.evidenceRef ?? `${this.runId || "run"}:reviewer:${item.id}`,
            evidenceSummary: output.slice(0, 240),
            gradingMode: "reviewer_mediated",
            reason: "reviewer accepted — mark verified and advance",
          };
        }
      }

      const decision = decideRepairChain({
        reviewerHasIssues: true,
        writeIntent: evidence.writeIntent === true,
        repairCycleCount: item.repairCycleCount,
        maxRepairCycles: this.maxRepairCycles,
        consecutiveFailures: this.consecutiveToolErrors,
        maxConsecutiveFailures:
          this.cfg.max_tool_errors_before_reroute > 0
            ? this.cfg.max_tool_errors_before_reroute
            : DEFAULT_MAX_CONSECUTIVE_FAILURES,
      });

      if (decision.backstop) {
        return {
          type: "block_item",
          itemId: item.id,
          reason: decision.reason,
        };
      }
      if (decision.fire) {
        return {
          type: "start_repair_chain",
          itemId: item.id,
          reason: decision.reason,
          flaggedIssues: output.slice(0, 400),
          newRemaining: mergeRepairChainIntoRemaining(
            remainingQueue,
            buildAutomaticRepairChainStages(),
          ),
        };
      }
      return null;
    }

    // --- Executor stage: direct-diff grade or escalate to reviewer ---
    if (stage === "executor" && outcome === "completed") {
      const localGrade = gradeViaDirectDiff({
        item,
        output,
        toolCalls: evidence.toolCalls,
        writeIntent: evidence.writeIntent,
      });

      if (
        shouldEscalateToReviewer({
          complexity: this.complexity,
          item,
          localGrade,
        })
      ) {
        // Only emit escalate when reviewer is not already queued (avoid noise).
        if (!remainingQueue.includes("reviewer")) {
          return {
            type: "escalate_reviewer",
            itemId: item.id,
            reason: localGrade.sufficient
              ? `complexity=${this.complexity} requires reviewer mediation`
              : localGrade.reason,
            newRemaining: ["reviewer", ...remainingQueue.filter((s) => s !== "reviewer")],
          };
        }
        return null;
      }

      if (localGrade.sufficient) {
        return {
          type: "mark_verified",
          itemId: item.id,
          evidenceRef: evidence.evidenceRef ?? `${this.runId || "run"}:executor:${item.id}`,
          evidenceSummary: localGrade.reason,
          gradingMode: "conductor_direct_diff",
          reason: localGrade.reason,
        };
      }
    }

    return null;
  }

  private resolvePlanItem(evidence: ConductorStageEvidence): TaskPlanItem | undefined {
    if (evidence.planItem) return evidence.planItem;
    if (evidence.planItemId && this.planContract?.plan) {
      return this.planContract.plan.items.find((i) => i.id === evidence.planItemId);
    }
    if (this.planContract) return getActivePlanItem(this.planContract);
    return undefined;
  }

  private hasIssuesHeuristic(reviewText: string): boolean {
    const normalized = reviewText.toUpperCase();
    return normalized.includes("PARTIAL") || normalized.includes("MISSING");
  }

  private async supervise(digest: SupervisionDigest): Promise<ConductorDirective> {
    const startedAt = Date.now();
    let parseOk = false;
    try {
      const conductorPrompt = loadPrompt("conductor.md");
      const userContent = [
        `Stage: ${digest.stage} — ${digest.outcome}`,
        `Output summary: ${digest.outputSummary || "(empty)"}`,
        `Tool call counts: ${formatToolCallCounts(digest.toolCallCounts)}`,
        `Tool error count: ${digest.toolErrorCount}`,
        digest.recentToolErrors.length > 0
          ? `Recent tool errors: ${digest.recentToolErrors.join("; ")}`
          : "Recent tool errors: none",
        digest.evidenceAssessment
          ? `Evidence assessment: ${JSON.stringify(digest.evidenceAssessment)}`
          : `Evidence assessment: not applicable — the ${digest.stage} stage produces no tool calls by design`,
        `Write intent: ${digest.writeIntent ? `TRUE — successful mutations so far: ${digest.successfulWrites}` : "no"}`,
        `Request (300 chars): ${digest.requestSummary || "(not provided)"}`,
        `Worker instruction: ${digest.workerInstruction || "(not provided)"}`,
        `Remaining queue: ${digest.remainingQueue.length > 0 ? digest.remainingQueue.join(" → ") : "(none)"}`,
      ].join("\n");

      // Race: supervisory inference vs timeout
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Supervision timeout")), this.cfg.supervision_timeout_ms);
      });
      let result: Awaited<ReturnType<typeof this.callModel>>;
      try {
        result = await Promise.race([
          this.supervisorModel(
            [
              { role: "system", content: conductorPrompt },
              { role: "user", content: userContent },
            ],
            {
              temperature: 0.1,
              max_tokens: 200,
              stageLabel: "coordinator",
              suppressActivity: true,
            }
          ),
          timeoutPromise,
        ]);
        clearTimeout(timeoutHandle);
      } catch (error) {
        clearTimeout(timeoutHandle);
        throw error;
      }

      let parsed: {
        directive: string;
        newRemaining?: string[];
        forStage?: string;
        note?: string;
        stage?: string;
        reason?: string;
      };
      try {
        parsed = extractJson<{
          directive: string;
          newRemaining?: string[];
          forStage?: string;
          note?: string;
          stage?: string;
          reason?: string;
        }>(result.content);
        parseOk = Boolean(parsed.directive);
      } catch {
        parseOk = false;
        parsed = { directive: "continue" };
      }

      console.log(
        `[LiveConductor] supervised run=${this.runId} stage=${digest.stage} ` +
        `outcome=${digest.outcome} directive=${parsed.directive || "continue"} latency_ms=${Date.now() - startedAt}`,
      );

      this.emitAttribution(Date.now() - startedAt, parseOk, !parseOk);

      if (parsed.directive === "reroute" && Array.isArray(parsed.newRemaining)) {
        return {
          type: "reroute",
          newRemaining: parsed.newRemaining as StageName[],
          reason: parsed.reason ?? "",
        };
      }
      if (parsed.directive === "inject_context" && parsed.forStage && parsed.note) {
        return {
          type: "inject_context",
          forStage: parsed.forStage as StageName,
          note: parsed.note,
          reason: parsed.reason ?? "",
        };
      }
      if (parsed.directive === "abort_stage" && parsed.stage) {
        return {
          type: "abort_stage",
          stage: parsed.stage as StageName,
          reason: parsed.reason ?? "",
        };
      }
      // Default: continue (includes explicit "continue" directive)
      return { type: "continue" };
    } catch (error) {
      // Any error (timeout, parse failure, model error) → safe default
      console.warn(
        `[LiveConductor] supervision fallback run=${this.runId} stage=${digest.stage} ` +
        `latency_ms=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`,
      );
      this.emitAttribution(Date.now() - startedAt, false, true);
      return { type: "continue" };
    }
  }

  private emitAttribution(durationMs: number, wasSuccessful: boolean, hadError: boolean): void {
    if (!this.onSupervisionAttributed || !this.runId) return;
    try {
      this.onSupervisionAttributed({
        agentRunId: this.runId,
        durationMs,
        wasSuccessful,
        hadError,
        provider: "conductor",
        modelId: "supervision",
      });
    } catch (e) {
      console.warn(
        `[LiveConductor] supervision attribution failed run=${this.runId}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

function toolCallCountsByName(toolCalls: ToolCallRecord[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of toolCalls ?? []) {
    counts[call.name] = (counts[call.name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function formatToolCallCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function recentToolErrorsFromEvidence(toolCalls: ToolCallRecord[] | undefined): string[] {
  return (toolCalls ?? [])
    .filter((call) => call.is_error)
    .map((call) => `${call.name}: ${(call.output || "").slice(0, 240)}`)
    .slice(-3);
}
