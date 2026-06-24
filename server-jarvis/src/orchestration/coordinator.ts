import { loadPrompt } from "./prompt-loader";

export type TaskType = "code_review" | "debug" | "refactor" | "general" | "plan" | "research" | "test" | "docs";
export type Complexity = "low" | "medium" | "high";
export type StageName = "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer";
export type Topology = "linear" | "speculative_parallel" | "speculative_cascade" | "recursive";
export type CoordinatorStageDecision = StageName | null | `re-enter:${StageName}`;

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
    stageLabel?: string;
    cascadeTier?: "cheap" | "strong";
    surfaceAsAnswer?: boolean;
    suppressActivity?: boolean;
  }
) => Promise<{ content: string; tool_calls?: any[] }>;

export interface CoordinatorContext {
  needs_workspace_inspection: boolean;
  needs_memory: boolean;
  estimated_complexity: Complexity;
}

export interface CoordinatorResult {
  task_type: TaskType;
  pipeline: CoordinatorStageDecision[];
  topology: Topology;
  context: CoordinatorContext;
  coordinator_rationale: string;
}

export interface CoordinatorRouteOptions {
  sessionId: string;
  history?: ChatMessage[];
  lastOutcome?: string;
}

interface CoordinatorState {
  sessionId: string;
  turns: number;
  lastOutcome?: string;
  lastDecision?: CoordinatorResult;
}

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

const VALID_TASK_TYPES = new Set<TaskType>(["code_review", "debug", "refactor", "general", "plan", "research", "test", "docs"]);
const VALID_COMPLEXITIES = new Set<Complexity>(["low", "medium", "high"]);
const VALID_STAGES = new Set<StageName>(["planner", "executor", "reviewer", "rewriter", "synthesizer"]);
const VALID_TOPOLOGIES = new Set<Topology>(["linear", "speculative_parallel", "speculative_cascade", "recursive"]);

export class Coordinator {
  private static readonly MAX_STATES = 256;
  private static readonly states = new Map<string, CoordinatorState>();

  constructor(private callModel: CallModelFn) {}

  async route(request: string, options: CoordinatorRouteOptions): Promise<CoordinatorResult> {
    const state = this.getState(options.sessionId);
    const coordinatorPrompt = loadPrompt("coordinator.md");
    const history = (options.history ?? [])
      .slice(-8)
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 1200)}${m.content.length > 1200 ? "..." : ""}`)
      .join("\n");

    const response = await this.callModel([
      { role: "system", content: coordinatorPrompt },
      {
        role: "user",
        content: [
          `Session ID: ${options.sessionId}`,
          `Coordinator turn: ${state.turns + 1}`,
          `Last outcome: ${options.lastOutcome ?? state.lastOutcome ?? "none"}`,
          history ? `Recent session history:\n${history}` : "Recent session history: none",
          `Current request:\n${request}`,
        ].join("\n\n"),
      },
    ], {
      temperature: 0.1,
      max_tokens: 700,
      stageLabel: "coordinator",
      suppressActivity: true,
    });

    const parsed = this.extractJson<unknown>(response.content);
    const decision = this.validate(parsed);
    state.turns += 1;
    state.lastOutcome = options.lastOutcome ?? state.lastOutcome;
    state.lastDecision = decision;
    Coordinator.states.delete(options.sessionId);
    Coordinator.states.set(options.sessionId, state);
    this.pruneStates();
    return decision;
  }

  executablePipeline(decision: CoordinatorResult): StageName[] {
    const stages: StageName[] = [];
    for (const step of decision.pipeline) {
      if (!step) continue;
      const stage = step as string;
      if (stage.startsWith("re-enter:")) {
        stages.push(stage.slice("re-enter:".length) as StageName);
      } else {
        stages.push(stage as StageName);
      }
    }
    return stages.length > 0 ? stages : ["synthesizer"];
  }

  private getState(sessionId: string): CoordinatorState {
    const existing = Coordinator.states.get(sessionId);
    if (existing) {
      Coordinator.states.delete(sessionId);
      Coordinator.states.set(sessionId, existing);
      return existing;
    }
    const state: CoordinatorState = { sessionId, turns: 0 };
    Coordinator.states.set(sessionId, state);
    this.pruneStates();
    return state;
  }

  private pruneStates() {
    while (Coordinator.states.size > Coordinator.MAX_STATES) {
      const oldest = Coordinator.states.keys().next().value;
      if (!oldest) break;
      Coordinator.states.delete(oldest);
    }
  }

  private validate(raw: unknown): CoordinatorResult {
    if (!raw || typeof raw !== "object") {
      throw new CoordinatorError("Coordinator returned non-object JSON");
    }
    const obj = raw as Record<string, any>;
    if (!VALID_TASK_TYPES.has(obj.task_type)) {
      throw new CoordinatorError(`Coordinator returned invalid task_type: ${String(obj.task_type)}`);
    }
    if (!Array.isArray(obj.pipeline)) {
      throw new CoordinatorError("Coordinator returned invalid pipeline");
    }
    const pipeline = obj.pipeline.map((step: unknown) => this.validateStageDecision(step));
    const topology = VALID_TOPOLOGIES.has(obj.topology) ? obj.topology as Topology : "linear";
    const context = obj.context ?? {};
    const estimated = VALID_COMPLEXITIES.has(context.estimated_complexity) ? context.estimated_complexity as Complexity : "medium";
    return {
      task_type: obj.task_type,
      pipeline,
      topology,
      context: {
        needs_workspace_inspection: context.needs_workspace_inspection ?? false,
        needs_memory: context.needs_memory ?? true,
        estimated_complexity: estimated,
      },
      coordinator_rationale: typeof obj.coordinator_rationale === "string"
        ? obj.coordinator_rationale
        : typeof obj.routing_rationale === "string"
          ? obj.routing_rationale
          : "Coordinator selected a route.",
    };
  }

  private validateStageDecision(step: unknown): CoordinatorStageDecision {
    if (step === null) return null;
    if (typeof step !== "string") {
      throw new CoordinatorError(`Coordinator returned non-string stage decision: ${String(step)}`);
    }
    if (VALID_STAGES.has(step as StageName)) return step as StageName;
    if (step.startsWith("re-enter:")) {
      const stage = step.slice("re-enter:".length);
      if (VALID_STAGES.has(stage as StageName)) return step as `re-enter:${StageName}`;
    }
    throw new CoordinatorError(`Coordinator returned invalid stage decision: ${step}`);
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
    throw new CoordinatorError(`Failed to parse JSON from coordinator output: ${text}`);
  }
}
