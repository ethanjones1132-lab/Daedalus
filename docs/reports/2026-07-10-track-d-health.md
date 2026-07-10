# Track D health check — 2026-07-10

## Verdict

D-01 had a real exporter and a documented JSONL contract, but the live export was not trustworthy before this pass. It could export stale route, outcome, reward, and model-attribution data after run repair. Those integrity defects are fixed without changing the JSONL schema.

There is still no real downstream trainer or consumer in this repository. The only JSONL consumers found are the CLI path and tests. That is consistent with D-02 through D-05 remaining human-gated/unimplemented, but it means Track D is a trustworthy producer, not an operating offline-RL loop.

## Live audit

Audit source: `C:\Users\ethan\.openclaw\jarvis\self-tuning.db` at the start of this pass.

- 163 agent runs
- 2,152 stage runs
- 383 model attributions
- 92 conductor runs
- 90 trajectory snapshots containing 390 frozen stage rows and 382 frozen attributions
- 0 malformed snapshots
- 0 orphan snapshot/run identities
- 0 session/task/duration/stage-identity mismatches

Three systematic defects were found:

- 34 of 90 snapshots exported the raw coordinator route instead of the canonical executable `agent_runs.pipeline`.
- 9 retro-repaired failed runs still exported the snapshot's stale success outcome, inflating reward by exactly 0.40 under the default outcome weight.
- The same 9 runs exported stale successful model attributions from the frozen snapshot.

## Repair

`corpus.ts` now:

- rejects snapshot/run identity mismatches;
- uses the repairable canonical `agent_runs.outcome` when valid;
- uses the canonical executable `agent_runs.pipeline` when valid;
- reads current same-run model attributions, falling back to the frozen snapshot only when no canonical rows exist; and
- preserves all existing JSONL fields and reward semantics.

After the repair, the live audit reported zero pipeline, outcome, attribution, or reward mismatches. The CLI default quality gate (`--min-reward 0.25`) scanned 90 snapshots, kept 89, filtered 1, emitted 89 valid JSONL rows, and emitted 0 malformed rows. The temporary export was removed after validation.

## Verification and downstream status

- Focused training tests: 26 passed after the repair.
- Full Bun suite: 725 passed, 0 failed after reconvergence.
- TypeScript typecheck and production bundle: passed.
- Export format: unchanged.

No code imports or consumes the JSONL for training, checkpoint promotion, or shadow deployment. `redistill` and skill promotion read raw trajectory snapshots directly; they are not D-01 JSONL consumers. The live database also had zero user ratings and zero replan events in the audited corpus, and no eval replay map was supplied. Consequently, the current reward is dominated by outcome plus neutral/default components. D-02 remains the correct human-in-the-loop boundary before any learning job is introduced.

