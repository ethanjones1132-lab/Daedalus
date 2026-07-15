import { loadPrompt } from "./prompt-loader";
import { ConductorBus, type ConductorDirective, type StageEvent } from "./conductor-bus";
import { extractJson } from "./json";
import type { CallModelFn } from "./coordinator";
import { AgentPool } from "./agent-pool";
import type { StageName } from "./coordinator";

interface SupervisionDigest {
  stage: StageName;
  outcome: "completed" | "failed";
  outputSummary: string;  // first 500 chars of stage output or error
  recentToolErrors: string[];  // last N isError tool results
  remainingQueue: StageName[];
}

export function shouldSuperviseStage(args: {
  supervisionEnabled: boolean;
  outcome: "completed" | "failed";
  remainingQueue: StageName[];
  consecutiveToolErrors: number;
}): boolean {
  if (!args.supervisionEnabled || args.remainingQueue.length === 0) return false;
  // Medium/high-complexity turns opted into supervision must actually be
  // supervised. The previous predicate only called the model after failures,
  // making a "live" conductor observationally inert on every clean stage.
  return true;
}

export class LiveConductor {
  private supervision: "on" | "off" = "on";
  private taskType = "general";
  private consecutiveToolErrors = 0;
  private recentToolErrors: string[] = [];
  private runId = "";

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
  ) {}

  setContext(taskType: string, complexity: "low" | "medium" | "high", runId: string): void {
    this.taskType = taskType;
    this.runId = runId;
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
    remainingQueue: StageName[]
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

      if (!shouldSuperviseStage({
        supervisionEnabled: this.supervision === "on",
        outcome,
        remainingQueue,
        consecutiveToolErrors: this.consecutiveToolErrors,
      })) return { type: "continue" };

      const digest: SupervisionDigest = {
        stage,
        outcome,
        outputSummary: output.slice(0, 500),
        recentToolErrors: [...this.recentToolErrors],
        remainingQueue,
      };

      const directive = await this.supervise(digest);
      this.recentToolErrors = [];
      return directive;
    } catch {
      return { type: "continue" };
    }
  }

  private async supervise(digest: SupervisionDigest): Promise<ConductorDirective> {
    const startedAt = Date.now();
    try {
      const conductorPrompt = loadPrompt("conductor.md");
      const userContent = [
        `Stage: ${digest.stage} — ${digest.outcome}`,
        `Output summary: ${digest.outputSummary || "(empty)"}`,
        digest.recentToolErrors.length > 0
          ? `Recent tool errors: ${digest.recentToolErrors.join("; ")}`
          : "Recent tool errors: none",
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

      const parsed = extractJson<{
        directive: string;
        newRemaining?: string[];
        forStage?: string;
        note?: string;
        stage?: string;
        reason?: string;
      }>(result.content);

      console.log(
        `[LiveConductor] supervised run=${this.runId} stage=${digest.stage} ` +
        `outcome=${digest.outcome} directive=${parsed.directive || "continue"} latency_ms=${Date.now() - startedAt}`,
      );

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
      return { type: "continue" };
    }
  }
}
