import { OutcomeAnalyzer, type TuningSuggestion } from "./analyzer";
import { SelfTuningStore, type TuningProposal } from "./store";

export class SelfTuningProposer {
  private store: SelfTuningStore;
  private analyzer: OutcomeAnalyzer;

  constructor(store?: SelfTuningStore, analyzer?: OutcomeAnalyzer) {
    this.store = store || new SelfTuningStore();
    this.analyzer = analyzer || new OutcomeAnalyzer(this.store);
  }

  initializeTunedConfigs(): void {
    // Tuning is proposal-driven today. This hook keeps orchestrator call-sites stable
    // without mutating active runtime configuration mid-run.
  }

  async proposeAndApply(agentRunId: string, taskType: string): Promise<TuningProposal[]> {
    const suggestions = this.analyzer.analyze(taskType);
    if (suggestions.length === 0) return [];

    const existing = new Set(
      this.store.getPendingProposals().map((p) => `${p.proposal_type}:${p.task_type}:${p.proposed_value}`)
    );

    const proposals: TuningProposal[] = [];
    for (const suggestion of suggestions) {
      const key = `${suggestion.proposal_type}:${suggestion.task_type}:${suggestion.proposed_value}`;
      if (existing.has(key)) continue;

      const proposal: TuningProposal = {
        id: `prop_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        proposal_type: suggestion.proposal_type,
        task_type: suggestion.task_type,
        current_value: suggestion.current_value,
        proposed_value: suggestion.proposed_value,
        rationale: suggestion.rationale,
        applied: 0,
      };
      this.store.insertTuningProposal(proposal);
      proposals.push(proposal);
    }

    return proposals;
  }
}

export const selfTuningProposer = new SelfTuningProposer();
