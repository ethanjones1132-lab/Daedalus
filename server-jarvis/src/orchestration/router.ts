import { loadPrompt } from "./prompt-loader";
import {
  Coordinator,
  CoordinatorError,
  type CallModelFn,
  type ChatMessage,
  type CoordinatorContext,
  type CoordinatorResult,
  type CoordinatorRouteOptions,
  type CoordinatorStageDecision,
  type StageName,
  type TaskType,
  type Topology,
} from "./coordinator";

export interface RoutingResult {
  task_type: TaskType;
  pipeline: string[];
  context: CoordinatorContext;
  routing_rationale: string;
}

/**
 * Compatibility shim for the old eval harness and any stale imports. The live
 * orchestrator path uses Coordinator directly so coordinator failures surface
 * instead of silently selecting a default pipeline.
 */
export class PredictiveRouter {
  constructor(private callModel: CallModelFn) {}

  async route(request: string): Promise<RoutingResult> {
    const routerPrompt = loadPrompt("router.md");
    try {
      const resp = await this.callModel([
        { role: "system", content: routerPrompt },
        { role: "user", content: request },
      ], {
        temperature: 0.1,
        max_tokens: 512,
      });

      const parsed = this.extractJson<Partial<RoutingResult>>(resp.content);
      return this.normalize(parsed);
    } catch (e: any) {
      console.warn(`[PredictiveRouter] Routing failed, using default pipeline: ${e.message}`);
      return {
        task_type: "general",
        pipeline: ["planner", "executor", "reviewer", "synthesizer"],
        context: {
          needs_workspace_inspection: true,
          needs_memory: true,
          estimated_complexity: "medium",
        },
        routing_rationale: `Fallback routing due to error: ${e.message}`,
      };
    }
  }

  private normalize(parsed: Partial<RoutingResult>): RoutingResult {
    const taskType = parsed.task_type ?? "general";
    return {
      task_type: taskType,
      pipeline: parsed.pipeline ?? ["planner", "executor", "reviewer", "synthesizer"],
      context: {
        needs_workspace_inspection: parsed.context?.needs_workspace_inspection ?? false,
        needs_memory: parsed.context?.needs_memory ?? true,
        estimated_complexity: parsed.context?.estimated_complexity ?? "medium",
      },
      routing_rationale: parsed.routing_rationale ?? "Auto-routed.",
    };
  }

  private extractJson<T>(text: string): T {
    try {
      return JSON.parse(text.trim()) as T;
    } catch {}

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const jsonStr = text.substring(start, end + 1);
      try {
        return JSON.parse(jsonStr) as T;
      } catch {}
    }
    throw new Error(`Failed to parse JSON from model output: ${text}`);
  }
}

export {
  Coordinator,
  CoordinatorError,
  type CallModelFn,
  type ChatMessage,
  type CoordinatorContext,
  type CoordinatorResult,
  type CoordinatorRouteOptions,
  type CoordinatorStageDecision,
  type StageName,
  type TaskType,
  type Topology,
};
