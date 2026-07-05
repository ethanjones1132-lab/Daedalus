import type { ConductorLearningConfig } from "../config";
import type { CoordinatorResult, StageName, TaskType, WorkerInstructions } from "../orchestration/coordinator";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import {
  SelfTuningStore,
  type ModelAttribution,
  type StageRun,
  type TuningProposal,
} from "./store";
import {
  applyLearnedCapabilities,
  fallbackBoostKey,
  getLearnedPoolState,
} from "./learned-pool-state";
import { hashInstruction, type InstructionVariantSelection } from "../orchestration/worker-prompt";

export interface RoutingRecordInput {
  agentRunId: string;
  sessionId: string;
  route: CoordinatorResult;
  normalizedPipeline: string[];
  routeSource?: string;
  conductorSource: "local" | "api" | "trivial" | "continuation_reuse";
  conductorModel?: string;
}

export interface RunCompletionInput {
  conductorRunId: string;
  agentRunId: string;
  sessionId: string;
  taskType: TaskType;
  route: CoordinatorResult;
  runOutcome: "success" | "degraded" | "failed";
  workerInstructions?: WorkerInstructions;
  instructionVariants: InstructionVariantSelection;
  stageRuns: StageRun[];
  modelAttributions: ModelAttribution[];
  durationMs: number;
  userRequest: string;
}

export interface HeuristicOptimizationResult {
  proposals: TuningProposal[];
  agentsAdjusted: number;
  fallbackBoostsApplied: number;
}

function successRate(success: number, failure: number): number {
  const total = success + failure;
  return total === 0 ? 0.5 : success / total;
}

export class ConductorLearningLoop {
  private pendingAttributions = new Map<string, ModelAttribution[]>();

  constructor(
    private store: SelfTuningStore = new SelfTuningStore(),
    private config: ConductorLearningConfig = {
      enabled: true,
      min_samples_for_heuristics: 5,
      capability_adjustment_step: 0.03,
      trajectory_export: true,
      instruction_ab_epsilon: 0.15,
      max_trajectory_snapshots: 500,
    },
  ) {}

  setConfig(config: ConductorLearningConfig): void {
    this.config = config;
  }

  recordRouting(input: RoutingRecordInput): string {
    if (!this.config.enabled) return "";
    const id = `cond_${crypto.randomUUID()}`;
    this.store.insertConductorRun({
      id,
      agent_run_id: input.agentRunId,
      session_id: input.sessionId,
      routing_json: JSON.stringify(input.route),
      conductor_source: input.conductorSource,
      conductor_model: input.conductorModel,
      task_type: input.route.task_type,
      topology: input.route.topology,
      pipeline_json: JSON.stringify(input.route.pipeline),
      normalized_pipeline_json: JSON.stringify(input.normalizedPipeline),
      route_source: input.routeSource,
    });
    this.pendingAttributions.set(input.agentRunId, []);
    return id;
  }

  recordStageModel(args: {
    agentRunId: string;
    stageId: string;
    agentId?: string;
    provider: string;
    modelId: string;
    durationMs?: number;
    fallbackUsed?: boolean;
    wasSuccessful?: boolean;
    hadError?: boolean;
  }): void {
    if (!this.config.enabled) return;
    const row: ModelAttribution = {
      id: `attr_${crypto.randomUUID()}`,
      agent_run_id: args.agentRunId,
      stage_id: args.stageId,
      agent_id: args.agentId,
      provider: args.provider,
      model_id: args.modelId,
      was_successful: args.wasSuccessful === false ? 0 : 1,
      had_error: args.hadError ? 1 : 0,
      duration_ms: args.durationMs,
      fallback_used: args.fallbackUsed ? 1 : 0,
    };
    this.store.insertModelAttribution(row);
    const pending = this.pendingAttributions.get(args.agentRunId) ?? [];
    pending.push(row);
    this.pendingAttributions.set(args.agentRunId, pending);
  }

  selectInstructionVariants(
    instructions: WorkerInstructions | undefined,
    taskType: TaskType,
  ): InstructionVariantSelection {
    if (!this.config.enabled || !instructions) {
      return { instructions, variants: {} };
    }

    const variants: InstructionVariantSelection["variants"] = {};
    const adjusted: WorkerInstructions = { ...instructions };
    const stats = this.store.getInstructionVariantStats(taskType);
    const epsilon = this.config.instruction_ab_epsilon;

    for (const stage of Object.keys(instructions) as StageName[]) {
      const text = instructions[stage]?.trim();
      if (!text) continue;

      const conductorKey = `conductor:${hashInstruction(text)}`;
      const baselineKey = "baseline";
      const conductorStats = stats.find((s) => s.variant_id === conductorKey && s.stage_id === stage);
      const baselineStats = stats.find((s) => s.variant_id === baselineKey && s.stage_id === stage);

      const explore = Math.random() < epsilon;
      let pick: "conductor" | "baseline" = "conductor";

      if (!explore && conductorStats && baselineStats && conductorStats.sample_count >= 3 && baselineStats.sample_count >= 3) {
        const conductorRate = successRate(conductorStats.success_count, conductorStats.failure_count);
        const baselineRate = successRate(baselineStats.success_count, baselineStats.failure_count);
        pick = conductorRate >= baselineRate ? "conductor" : "baseline";
      } else if (!explore && conductorStats && conductorStats.sample_count >= 3 && (!baselineStats || baselineStats.sample_count < 3)) {
        const conductorRate = successRate(conductorStats.success_count, conductorStats.failure_count);
        pick = conductorRate >= 0.45 ? "conductor" : "baseline";
      }

      if (pick === "baseline") {
        delete adjusted[stage];
        variants[stage] = baselineKey;
      } else {
        variants[stage] = conductorKey;
      }
    }

    return { instructions: Object.keys(adjusted).length > 0 ? adjusted : undefined, variants };
  }

  completeRun(input: RunCompletionInput): void {
    if (!this.config.enabled) return;

    this.store.updateConductorRun(input.conductorRunId, { run_outcome: input.runOutcome });

    const stageByMode = new Map(input.stageRuns.map((s) => [s.mode_id, s]));
    for (const [stage, variant] of Object.entries(input.instructionVariants.variants)) {
      const stageRun = stageByMode.get(stage);
      if (!stageRun) continue;
      const custom = input.workerInstructions?.[stage as StageName]?.trim();
      const ok = stageRun.was_successful === 1 && stageRun.had_error === 0;
      this.store.upsertInstructionVariantStats(variant, stage, input.taskType, ok);
      this.store.insertWorkerInstructionOutcome({
        id: `wi_${crypto.randomUUID()}`,
        agent_run_id: input.agentRunId,
        stage_id: stage,
        instruction_hash: custom ? hashInstruction(custom) : "baseline",
        instruction_variant: variant,
        instruction_text: custom?.slice(0, 2000),
        was_successful: stageRun.was_successful,
        had_error: stageRun.had_error,
      });
    }

    for (const attr of input.modelAttributions) {
      if (!attr.agent_id) continue;
      const ok = attr.was_successful === 1 && attr.had_error === 0;
      this.store.upsertAgentPerformance(
        attr.agent_id,
        attr.stage_id,
        input.taskType,
        ok,
        attr.duration_ms ?? 0,
      );
    }

    if (this.config.trajectory_export) {
      const snapshot = {
        version: 1,
        agent_run_id: input.agentRunId,
        session_id: input.sessionId,
        task_type: input.taskType,
        run_outcome: input.runOutcome,
        duration_ms: input.durationMs,
        routing: input.route,
        worker_instructions: input.workerInstructions,
        instruction_variants: input.instructionVariants.variants,
        stage_runs: input.stageRuns,
        model_attributions: input.modelAttributions,
        user_request: input.userRequest.slice(0, 4000),
      };
      this.store.insertTrajectorySnapshot({
        id: `traj_${crypto.randomUUID()}`,
        agent_run_id: input.agentRunId,
        session_id: input.sessionId,
        snapshot_json: JSON.stringify(snapshot),
      });
      this.store.pruneTrajectorySnapshots(this.config.max_trajectory_snapshots);
    }

    this.pendingAttributions.delete(input.agentRunId);
  }

  async optimizeAndApply(agentRunId: string, taskType: TaskType, agents: OrchestratorAgent[]): Promise<HeuristicOptimizationResult> {
    if (!this.config.enabled) {
      return { proposals: [], agentsAdjusted: 0, fallbackBoostsApplied: 0 };
    }

    const minSamples = this.config.min_samples_for_heuristics;
    const step = this.config.capability_adjustment_step;
    const performance = this.store.getAgentPerformance(taskType);
    const state = getLearnedPoolState();
    const proposals: TuningProposal[] = [];
    let agentsAdjusted = 0;
    let fallbackBoostsApplied = 0;

    for (const row of performance) {
      if (row.sample_count < minSamples) continue;
      const rate = successRate(row.success_count, row.failure_count);
      const agent = agents.find((a) => a.id === row.agent_id);
      if (!agent) continue;

      const deltas = state.capabilityDeltas.get(agent.id) ?? {};
      let changed = false;

      if (rate >= 0.75) {
        const capKey = row.stage_id === "executor" || row.stage_id === "rewriter" ? "code" : "reasoning";
        const prev = deltas[capKey] ?? 0;
        const next = Math.min(0.15, prev + step);
        if (next !== prev) {
          deltas[capKey] = next;
          changed = true;
          proposals.push({
            id: `prop_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            proposal_type: "agent_capability_boost",
            task_type: taskType,
            current_value: String(agent.capabilities[capKey]),
            proposed_value: String(Math.min(1, agent.capabilities[capKey] + step)),
            rationale: `Agent ${agent.id} succeeded ${(rate * 100).toFixed(0)}% on ${row.stage_id}/${taskType} over ${row.sample_count} samples.`,
            applied: 1,
          });
        }
        const boostKey = fallbackBoostKey(agent.id, row.stage_id, taskType);
        state.fallbackBoosts.set(boostKey, (rate - 0.5) * 0.4);
        fallbackBoostsApplied++;
      } else if (rate <= 0.35) {
        const capKey = row.stage_id === "executor" || row.stage_id === "rewriter" ? "code" : "reasoning";
        const prev = deltas[capKey] ?? 0;
        const next = Math.max(-0.15, prev - step);
        if (next !== prev) {
          deltas[capKey] = next;
          changed = true;
          proposals.push({
            id: `prop_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            proposal_type: "agent_capability_penalty",
            task_type: taskType,
            current_value: String(agent.capabilities[capKey]),
            proposed_value: String(Math.max(0, agent.capabilities[capKey] - step)),
            rationale: `Agent ${agent.id} succeeded only ${(rate * 100).toFixed(0)}% on ${row.stage_id}/${taskType} over ${row.sample_count} samples.`,
            applied: 1,
          });
        }
        const boostKey = fallbackBoostKey(agent.id, row.stage_id, taskType);
        state.fallbackBoosts.set(boostKey, (rate - 0.5) * 0.4);
        fallbackBoostsApplied++;
      }

      if (changed) {
        state.capabilityDeltas.set(agent.id, deltas);
        agentsAdjusted++;
      }
    }

    for (const proposal of proposals) {
      this.store.insertTuningProposal(proposal);
    }

    return { proposals, agentsAdjusted, fallbackBoostsApplied };
  }

  applyLearnedAgents(agents: OrchestratorAgent[]): OrchestratorAgent[] {
    return agents.map(applyLearnedCapabilities);
  }
}

export const conductorLearning = new ConductorLearningLoop();
