import { OutcomeAnalyzer, type TuningSuggestion } from "./analyzer";
import { BUILTIN_MODES } from "../orchestration/modes";

export class SelfTuningProposer {
  private store: SelfTuningStore;
  private analyzer: OutcomeAnalyzer;

  constructor(store?: SelfTuningStore, analyzer?: OutcomeAnalyzer) {
    this.store = store || new SelfTuningStore();
    this.analyzer = analyzer || new OutcomeAnalyzer(this.store);

    const runsCount = this.store.getAgentRuns().length;
    const isSuggestionOnly = runsCount <= 10;

    for (const sugg of suggestions) {
      const proposalId = `prop_${crypto.randomUUID()}`;
      
      // Determine if this should be auto-applied
      let shouldAutoApply = false;

      if (!isSuggestionOnly) {
        // Check historical proposals of same type and task type
        const history = this.store.getAppliedProposals().filter(
          (p) => p.proposal_type === sugg.proposal_type && p.task_type === sugg.task_type && p.proposed_value === sugg.proposed_value
        );

        if (history.length >= 3) {
          // Check if outcomes were positive
          // Retrieve outcomes for these proposals
          let positiveOutcomes = 0;
          for (const prev of history) {
            const db = (this.store as any).getDb();
            if (db) {
              try {
                const outcome = db.query("SELECT 