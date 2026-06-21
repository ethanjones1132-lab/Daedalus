import { loadPrompt } from "./prompt-loader";

export interface RoutingResult {
  task_type: "code_review" | "debug" | "refactor" | "general" | "plan" | "research" | "test" | "docs";
  pipeline: string[];
  context: {
    needs_workspace_inspection: boolean;
    needs_memory: boolean;
    estimated_complexity: "low" | "medium" | "high";
  };
  routing_rationale: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
}

export type CallModelFn = (
  messages: Array<ChatMessage>,
  options?: {
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
    tools?: any[];
  }
) => Promise<{ content: string; tool_calls?: any[] }>;

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

      const parsed = this.extractJson<RoutingResult>(resp.content);
      // Validate the returned object structure and provide safe fallbacks
      return {
        task_type: parsed.task_type || "general",
        pipeline: parsed.pipeline || ["planner", "executor", "reviewer", "synthesizer"],
        context: {
          needs_workspace_inspection: parsed.context?.needs_workspace_inspection ?? false,
          needs_memory: parsed.context?.needs_memory ?? true,
          estimated_complexity: parsed.context?.estimated_complexity || "medium",
        },
        routing_rationale: parsed.routing_rationale || "Auto-routed.",
      };
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
