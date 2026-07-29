/**
 * Race a stage across several model lanes and keep the first one to produce a
 * token; abort the rest.
 *
 * 2026-07-29 evidence (self-tuning.db): time-to-first-token is 65–97% of every
 * stage's wall clock, and 44 of 51 calls went to a single free-tier lane. The
 * generation itself is not slow — provider queueing is. Racing two healthy
 * lanes converts that into min(ftt) and makes a provider hiccup free instead
 * of costing a full timeout-then-cascade.
 *
 * Only lanes with independently good health should be passed in; racing onto a
 * high-error model would trade latency for failure. See `AgentPool.raceCandidates`.
 */
export interface RaceCandidate<T> {
  id: string;
  launch: (signal: AbortSignal) => Promise<T>;
}

export interface RaceResult<T> {
  winnerId: string;
  value: T;
  /** False when only one candidate was supplied (no race was run). */
  raced: boolean;
}

export async function raceFirstToken<T>(
  candidates: readonly RaceCandidate<T>[],
): Promise<RaceResult<T>> {
  if (candidates.length === 0) throw new Error("raceFirstToken: no candidates");
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const controller = new AbortController();
    return { winnerId: only.id, value: await only.launch(controller.signal), raced: false };
  }

  const controllers = candidates.map(() => new AbortController());
  let settled = false;
  const failures: Error[] = [];

  return new Promise<RaceResult<T>>((resolve, reject) => {
    candidates.forEach((candidate, index) => {
      candidate
        .launch(controllers[index]!.signal)
        .then((value) => {
          if (settled) return;
          settled = true;
          // Abort every other lane; the winner's controller is left alone so
          // its stream can continue to completion.
          controllers.forEach((controller, other) => {
            if (other !== index) controller.abort();
          });
          resolve({ winnerId: candidate.id, value, raced: true });
        })
        .catch((error: unknown) => {
          if (settled) return;
          failures.push(error instanceof Error ? error : new Error(String(error)));
          if (failures.length === candidates.length) {
            settled = true;
            reject(
              new Error(
                `all ${candidates.length} race candidates failed: ` +
                  failures.map((f) => f.message).join("; "),
              ),
            );
          }
        });
    });
  });
}
