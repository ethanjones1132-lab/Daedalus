import { loadPrompt } from "./prompt-loader";
import { ConductorBus, type ConductorDirective, type StageEvent } from "./conductor-bus";
import { extractJson } from "./json";
import type { CallModelFn } from "./coordinator";
import { AgentPool } from "./agent-pool";
import type { StageName } from "./coordinator";
import type { EvidenceAssessment } from "./evidence-sufficiency";
import { assessWorkspaceEvidence, isDeepReadRequest } from "./evidence-sufficiency";
import { EVIDENCE_CAPABLE_STAGES } from "./reroute-policy";
import type { ToolCallRecord } from "./stage-output";

export interface ConductorStageEvidence {
  toolCalls?: ToolCallRecord[];
  request?: string;
  workerInstruction?: string;
  workspaceRoot?: string;
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
  private consecutiveToolErrors = 0;
  private recentToolErrors: string[] = [];
  private runId = "";
  private deepReadEvidenceRerouteUsed = false;
  /** F7: per-run supervision inference counter (reset in setContext). */
  private supervisionCallsUsed = 0;

  constructor(
    private callModel: CallModelFn,
    private bus: ConductorBus,
    private pool: AgentPool,
    private cfg: {
      supervision_timeout_ms: number;
      max_tool_errors_before_reroute: number;
      supervise_low_complexity: boolean;
    },
    /** Local supervisor path; defaults to callModel for backwards compatibility. */
    private supervisorModel: CallModelFn = callModel,
    /** F7/F10a: optional attribution sink for conductor_supervision rows. */
    private onSupervisionAttributed?: (row: SupervisionAttribution) => void,
  ) {}

  setContext(taskType: string, complexity: "low" | "medium" | "high", runId: string): void {
    this.taskType = taskType;
    this.runId = runId;
    this.deepReadEvidenceRerouteUsed = false;
    this.supervisionCallsUsed = 0;
    this.supervision = !this.cfg.supervise_low_complexity && complexity === "low" ? "off" : "on";
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
      if (this.cfg.max_tool_errors_before_reroute > 0 && this.consecutiveToolErrors >= this.cfg.max_tool_errors_before_reroute) {
        this.consecutiveToolErrors = 0;
        this.recentToolErrors = [];
        return {
          type: "reroute",
          newRemaining: ["re-enter:planner" as StageName, "executor" as StageName, "synthesizer" as StageName],
          reason: "consecutive tool errors reached threshold — re-entering planner",
        };
      }

      // F1: only evidence-capable stages get a workspace-evidence rubric.
      // Planner/reviewer/synthesizer digests must not claim "sufficient:false".
      const evidenceAssessment = EVIDENCE_CAPABLE_STAGES.has(stage)
        ? assessWorkspaceEvidence(
          evidence.toolCalls,
          evidence.request ?? "",
          evidence.workspaceRoot,
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

      const evidenceGap = Boolean(
        evidenceAssessment && !evidenceAssessment.sufficient,
      );
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
