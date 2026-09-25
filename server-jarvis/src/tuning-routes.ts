/**
 * `/tuning/proposals` — the operator's view of the self-tuning loop.
 *
 * Both routes used to be unreachable for the truth: `POST .../apply`
 * truthiness-checked only `body.id`, called a `void` store function that
 * swallowed every DB error, and answered `{ ok: true }` unconditionally — so a
 * stale or mistyped id reported a success that never happened. `GET
 * /tuning/proposals` returned raw proposal rows and never a measured
 * conclusion, so a proposal that could never be measured looked identical to one
 * that had not been reached yet.
 *
 * Now: an apply answers with what it did (`applied`, the captured snapshot) or a
 * stable reason, and the read answers with `decideProposalMeasurement` per
 * proposal — `measured`, `awaiting_samples`, or `baseline_unavailable` — so a
 * proposal that is waiting is visibly waiting.
 *
 * The module takes a store port rather than the store itself so the routes stay
 * testable without booting the server (`SelfTuningStore` satisfies it
 * structurally).
 */

import {
  DEFAULT_MIN_POST_APPLY_SAMPLES,
  decideProposalMeasurement,
  type ProposalMeasurement,
} from "./self-tuning/tuning-measurement";
import {
  isTuningProposalId,
  type AgentRun,
  type ApplyTuningProposalResult,
  type TuningOutcome,
  type TuningProposal,
} from "./self-tuning/store";

export interface TuningProposalStore {
  getPendingProposals(): TuningProposal[];
  getAppliedProposals(): TuningProposal[];
  getTuningOutcomes(proposalId?: string): TuningOutcome[];
  getCompletedAgentRunsForTaskType(taskType: string): AgentRun[];
  applyTuningProposal(id: string): ApplyTuningProposalResult;
}

/** Attach the measurement decision to one proposal row. */
function projectProposal(
  store: TuningProposalStore,
  proposal: TuningProposal,
  minSamples: number,
): TuningProposal & { measurement: ProposalMeasurement } {
  const [outcome] = store.getTuningOutcomes(proposal.id);
  return {
    ...proposal,
    measurement: decideProposalMeasurement({
      proposal,
      outcome: outcome ?? null,
      completedRuns: proposal.applied === 1
        ? store.getCompletedAgentRunsForTaskType(proposal.task_type)
        : [],
      minSamples,
    }),
  };
}

function applyStatus(result: Extract<ApplyTuningProposalResult, { ok: false }>): number {
  switch (result.reason) {
    case "invalid_id":
      return 400;
    case "not_found":
      return 404;
    case "store_unavailable":
      return 503;
    case "store_failed":
      return 500;
  }
}

export async function handleTuningProposalsRequest(
  req: Request,
  store: TuningProposalStore,
): Promise<Response | null> {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;

  if (path === "/tuning/proposals" && req.method === "GET") {
    const minSamples = DEFAULT_MIN_POST_APPLY_SAMPLES;
    return Response.json({
      pending: store.getPendingProposals().map((p) => projectProposal(store, p, minSamples)),
      applied: store.getAppliedProposals().map((p) => projectProposal(store, p, minSamples)),
    });
  }

  if (path === "/tuning/proposals/apply" && req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const id =
      typeof body === "object" && body !== null && "id" in body
        ? (body as { id?: unknown }).id
        : undefined;
    // Refused before the store is consulted, so a malformed id never reaches
    // SQLite — and never reads as a silent success.
    if (!isTuningProposalId(id)) {
      return Response.json(
        { ok: false, applied: false, reason: "invalid_id" },
        { status: 400 },
      );
    }
    const result = store.applyTuningProposal(id);
    if (!result.ok) {
      return Response.json(
        { ok: false, applied: false, id: result.id, reason: result.reason },
        { status: applyStatus(result) },
      );
    }
    return Response.json({ ...result });
  }

  return null;
}
