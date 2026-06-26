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

export class LiveConductor {
  private supervision: "on" | "off" = "on";
  private taskType = "general";
  private consecutiveToolErrors = 0;
  private runId = "";

  constructor(
    private callModel: CallModelFn,
    private bus: ConductorBus,
    private pool: AgentPool,
    private cfg: {
      supervision_timeout_ms: number;
      max_tool_errors_before_reroute: number;
      supervise_low_complexity: boolean;
    }
  ) {}

  setContext(taskType: string, complexity: "low" | "medium" | "high", runId: string): void {
    this.taskType = taskType;
    this.runId = runId;
    if (!this.cfg.supervise_low_complexity && complexity === "low") {
      this.supervision = "off";
    }
  }

  // Called from the executor/rewriter tool loop for each tool result
  onToolResult(stage: StageName, name: string, isError: boolean, summary: string): void {
    if (isError) {
      this.consecutiveToolErrors++;
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
        return {
          type: "reroute",
          newRemaining: ["re-enter:planner" as StageName, "executor" as StageName, "synthesizer" as StageName],
          reason: "consecutive tool errors reached threshold — re-entering planner",
        };
      }

      if (this.supervision === "off") return { type: "continue" };
      if (outcome === "completed" && remainingQueue.length === 0) return { type: "continue" };

      const digest: SupervisionDigest = {
        stage,
        outcome,
        outputSummary: output.slice(0, 500),
        recentToolErrors: [], // populated from bus events; simplified here
        remainingQueue,
      };

      return await this.supervise(digest);
    } catch {
      return { type: "continue" };
    }
  }

  private async supervise(digest: SupervisionDigest): Promise<ConductorDirective> {
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
          this.callModel(
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
      } catch {
        clearTimeout(timeoutHandle);
        return { type: "continue" };
      }

      const parsed = extractJson<{
        directive: string;
        newRemaining?: string[];
        forStage?: string;
        note?: string;
        stage?: string;
        reason?: string;
      }>(result.content);

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
    } catch {
      // Any error (timeout, parse failure, model error) → safe default
      return { type: "continue" };
    }
  }
}
