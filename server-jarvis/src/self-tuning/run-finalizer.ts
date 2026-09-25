import { summarizeTurnMetrics } from "../orchestration/turn-metrics";
import type { CoordinatorResult, TaskType, WorkerInstructions } from "../orchestration/coordinator";
import type { InstructionVariantSelection } from "../orchestration/worker-prompt";
import type { InstructionRevisionReport } from "../orchestration/instruction-binding";
import { ConductorLearningLoop, type RunCompletionInput } from "./conductor-learning";
import { SessionOutcomeCollector } from "./collector";
import { evaluatePendingTuningOutcomes } from "./outcome-loop";
import {
  SelfTuningStore,
  type ModelAttribution,
  type RunCompletionBundle,
  type RunFinalizationStatus,
  type StageRun,
  type TerminalRunInput,
} from "./store";

export interface RunFinalizerOptions {
  agentRunId: string;
  sessionId: string;
  userRequest: string;
  taskType: TaskType;
  pipeline: string[];
  route: CoordinatorResult;
  normalizedPipeline: string[];
  routeSource?: string;
  conductorSource: "local" | "api" | "trivial" | "continuation_reuse" | "deterministic";
  conductorModel?: string;
  latencyMs?: number;
  requirement?: string;
  store?: SelfTuningStore;
  collector?: SessionOutcomeCollector;
  learning?: ConductorLearningLoop;
  onTerminal?: () => void;
}

export interface RunFinalizationInput {
  finalOutput: string;
  durationMs: number;
  outcome: TerminalRunInput["outcome"];
  toolCallsCount?: number;
  tokenCount?: number;
  verifiedVia?: string | null;
  checkTier?: string | null;
  checkDeclinedReason?: string | null;
  rewardScore?: number | null;
  rewardJson?: string | null;
  stageRuns?: StageRun[];
  modelAttributions?: ModelAttribution[];
  instructionVariants?: InstructionVariantSelection;
}

export class RunFinalizer {
  private readonly store: SelfTuningStore;
  private readonly collector: SessionOutcomeCollector;
  private readonly learning: ConductorLearningLoop;
  private readonly onTerminal?: () => void;
  private started = false;
  private finalized = false;
  private conductorRunId = "";
  private instructionVariants: InstructionVariantSelection = { variants: {} };
  /**
   * The instruction set the workers actually received. Starts as the A/B
   * selection and is replaced only when a replan reports a revision. Never
   * re-derived from `route.worker_instructions`: that is the text the
   * *selector* considered, and a baseline pick means the workers were
   * deliberately sent something else.
   */
  private executedInstructions: WorkerInstructions | undefined;

  constructor(private readonly options: RunFinalizerOptions) {
    this.store = options.store ?? options.collector?.store ?? new SelfTuningStore();
    this.collector = options.collector ?? new SessionOutcomeCollector(this.store);
    this.learning = options.learning ?? new ConductorLearningLoop(this.store);
    this.onTerminal = options.onTerminal;
  }

  get runConductorId(): string {
    return this.conductorRunId;
  }

  start(): boolean {
    if (this.started || this.finalized) return false;
    const existing = this.store.getAgentRuns().find((run) => run.id === this.options.agentRunId);
    if (existing) {
      this.started = true;
      this.conductorRunId = this.store.getConductorRuns(this.options.agentRunId)[0]?.id ?? "";
      return true;
    }
    const started = this.collector.startAgentRun(
      this.options.agentRunId,
      this.options.sessionId,
      this.options.userRequest,
      this.options.taskType,
      this.options.pipeline,
    );
    if (!started) return false;
    this.started = true;
    try {
      this.conductorRunId = this.learning.recordRouting({
        agentRunId: this.options.agentRunId,
        sessionId: this.options.sessionId,
        route: this.options.route,
        normalizedPipeline: this.options.normalizedPipeline,
        routeSource: this.options.routeSource,
        conductorSource: this.options.conductorSource,
        conductorModel: this.options.conductorModel,
        latencyMs: this.options.latencyMs,
        requirement: this.options.requirement,
      });
    } catch (error) {
      console.warn("[RunFinalizer] routing telemetry unavailable:", error);
      this.conductorRunId = "";
    }
    return true;
  }

  setInstructionVariants(selection: InstructionVariantSelection): void {
    this.instructionVariants = selection;
    this.executedInstructions = selection.instructions;
  }

  /** Records the instruction set a replan actually sent the remaining workers. */
  setExecutedInstructions(report: InstructionRevisionReport): void {
    if (!report.revised) return;
    this.executedInstructions = report.instructions;
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  hasPendingAttributions(): boolean {
    return this.learning.hasPendingAttributions(this.options.agentRunId);
  }

  finalize(input: RunFinalizationInput): RunFinalizationStatus {
    if (!this.started) return "not_started";
    if (this.finalized) return "already_terminal";
    if (this.learning.isEnabled() && !this.conductorRunId) {
      this.learning.releasePendingAttributions(this.options.agentRunId);
      return "missing_conductor";
    }

    const stageRuns = input.stageRuns ?? this.store.getStageRuns(this.options.agentRunId);
    const modelAttributions = input.modelAttributions ?? this.store.getModelAttributions(this.options.agentRunId);
    const metrics = summarizeTurnMetrics({ stages: stageRuns, attributions: modelAttributions });
    const instructionVariants = input.instructionVariants ?? this.instructionVariants;
    const learningOutcome = input.outcome === "partial"
      ? "degraded"
      : input.outcome === "cancelled"
        ? "failed"
        : input.outcome;
    const completionInput: RunCompletionInput = {
      conductorRunId: this.conductorRunId,
      agentRunId: this.options.agentRunId,
      sessionId: this.options.sessionId,
      taskType: this.options.taskType,
      route: this.options.route,
      runOutcome: learningOutcome,
      // The executed set, not `route.worker_instructions`: a baseline pick or a
      // replan revision means the workers ran something other than the route's
      // own text, and recording that route would describe a prompt nobody sent.
      workerInstructions: this.executedInstructions,
      instructionVariants,
      stageRuns,
      modelAttributions,
      durationMs: input.durationMs,
      userRequest: this.options.userRequest,
    };

    let completion: RunCompletionBundle;
    try {
      completion = this.learning.prepareCompletion(completionInput, {
        suppressLearning: input.outcome === "cancelled",
      });
    } catch (error) {
      console.warn("[RunFinalizer] completion preparation failed:", error);
      this.learning.releasePendingAttributions(this.options.agentRunId);
      return "unavailable";
    }

    let status: RunFinalizationStatus;
    try {
      status = this.store.finalizeRun(
        this.options.agentRunId,
        {
          finalOutput: input.finalOutput,
          durationMs: input.durationMs,
          toolCallsCount: input.toolCallsCount ?? metrics.tool_calls,
          tokenCount: input.tokenCount ?? metrics.tokens_total,
          outcome: input.outcome,
          verifiedVia: input.verifiedVia,
          checkTier: input.checkTier,
          checkDeclinedReason: input.checkDeclinedReason,
          rewardScore: input.rewardScore,
          rewardJson: input.rewardJson,
        },
        completion,
      );
    } finally {
      this.learning.releasePendingAttributions(this.options.agentRunId);
    }

    if (status === "claimed" || status === "already_terminal") {
      this.finalized = true;
    }
    if (status === "claimed") {
      try {
        evaluatePendingTuningOutcomes(this.store);
      } catch (error) {
        console.warn("[RunFinalizer] tuning outcome evaluation failed:", error);
      }
      this.onTerminal?.();
    }
    return status;
  }
}
