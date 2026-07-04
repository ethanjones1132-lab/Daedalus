import type { Database } from "bun:sqlite";
import { extractTextToolCalls } from "../text-tools";

/**
 * Retro-repair for the 2026-07-03 reward-signal leak (session 1d4727cf,
 * run_81091960): the synthesizer emitted tool-call JSON as its "answer", the
 * stage was recorded was_successful=1, the run outcome=success, and the
 * tuning heuristics then boosted the offending model's capability score.
 *
 * This module finds runs poisoned by that bug and repairs the derived
 * reward state (agent_runs.outcome, model_attributions, agent_performance)
 * to reflect what actually happened. It is pure with respect to a `Database`
 * handle so it can be unit-tested against an in-memory DB (see
 * retro-mark.test.ts) and driven for real by
 * scripts/retro-mark-poisoned-runs.ts.
 */

/** The only stage whose output is shown to the user as the final answer. */
const ANSWER_STAGE_ID = "synthesizer";

export interface PoisonedRunRow {
  id: string;
  task_type: string;
  final_output: string | null;
  outcome: string | null;
  reason: "synthesis_failed_text" | "sanitizes_to_empty";
}

export interface RetroMarkOptions {
  /** Default false (dry run): compute + return the summary, write nothing. */
  apply: boolean;
}

export interface RetroMarkSummary {
  runsMarked: number;
  attributionsFlipped: number;
  performanceRowsAdjusted: number;
  details: string[];
}

interface AgentRunRow {
  id: string;
  task_type: string;
  final_output: string | null;
  outcome: string | null;
}

interface ModelAttributionRow {
  id: string;
  agent_run_id: string;
  stage_id: string;
  agent_id: string | null;
  was_successful: number;
  had_error: number;
}

/**
 * Runs whose `outcome` is still NULL or 'success' but whose `final_output` is
 * poisoned: either explicit "Synthesis failed: ..." error text, or non-empty
 * text that today's sanitizer (extractTextToolCalls) would strip down to
 * nothing — i.e. it was never actually an answer, just leaked tool-call JSON
 * (or similar tool-echo noise) that got recorded as if it were prose.
 */
export function findPoisonedRuns(db: Database): PoisonedRunRow[] {
  const candidates = db
    .query(
      `SELECT id, task_type, final_output, outcome FROM agent_runs
       WHERE (outcome IS NULL OR outcome = 'success')
         AND final_output IS NOT NULL
         AND trim(final_output) != ''`,
    )
    .all() as AgentRunRow[];

  const poisoned: PoisonedRunRow[] = [];
  for (const run of candidates) {
    const finalOutput = run.final_output ?? "";
    if (finalOutput.startsWith("Synthesis failed:")) {
      poisoned.push({ ...run, reason: "synthesis_failed_text" });
      continue;
    }
    // Guard: only classify (b) when final_output.trim() !== "" — already
    // guaranteed by the SQL WHERE clause above, kept explicit here too.
    if (finalOutput.trim() === "") continue;
    const { cleanedText } = extractTextToolCalls(finalOutput, []);
    if (cleanedText.trim() === "") {
      poisoned.push({ ...run, reason: "sanitizes_to_empty" });
    }
  }
  return poisoned;
}

/**
 * Marks poisoned runs outcome='failed' and repairs the derived reward state
 * that was built on top of the false 'success' signal:
 *  - flips was_successful=0, had_error=1 on each poisoned run's ANSWER-stage
 *    (synthesizer) model_attributions row (other stages' attributions, e.g.
 *    executor, are left alone — they may have genuinely succeeded),
 *  - decrements success_count / increments failure_count on the matching
 *    agent_performance row (keyed by agent_id + stage_id + task_type),
 *    clamped at >= 0.
 *
 * Dry-run (apply=false, the default) computes the exact same summary but
 * performs the work inside a transaction that is always rolled back, so the
 * database is left byte-for-byte unchanged.
 */
export function retroMarkPoisonedRuns(db: Database, options: RetroMarkOptions): RetroMarkSummary {
  const summary: RetroMarkSummary = {
    runsMarked: 0,
    attributionsFlipped: 0,
    performanceRowsAdjusted: 0,
    details: [],
  };

  const poisonedRuns = findPoisonedRuns(db);
  if (poisonedRuns.length === 0) return summary;

  const adjustedPerfKeys = new Set<string>();

  const doWork = () => {
    for (const run of poisonedRuns) {
      db.prepare(`UPDATE agent_runs SET outcome = 'failed' WHERE id = ?`).run(run.id);
      summary.runsMarked++;
      summary.details.push(
        `run ${run.id} (${run.reason}): outcome ${run.outcome ?? "NULL"} -> failed`,
      );

      const attributions = db
        .query(`SELECT * FROM model_attributions WHERE agent_run_id = ?`)
        .all(run.id) as ModelAttributionRow[];

      for (const attr of attributions) {
        if (attr.stage_id !== ANSWER_STAGE_ID) continue;
        if (attr.was_successful !== 1) continue;

        db.prepare(
          `UPDATE model_attributions SET was_successful = 0, had_error = 1 WHERE id = ?`,
        ).run(attr.id);
        summary.attributionsFlipped++;
        summary.details.push(
          `attribution ${attr.id} (run ${run.id}, stage ${attr.stage_id}): was_successful 1 -> 0, had_error 0 -> 1`,
        );

        if (!attr.agent_id) continue;

        const perfRow = db
          .query(
            `SELECT * FROM agent_performance WHERE agent_id = ? AND stage_id = ? AND task_type = ?`,
          )
          .get(attr.agent_id, attr.stage_id, run.task_type) as
          | { success_count: number; failure_count: number }
          | undefined;
        if (!perfRow) continue; // leave rows that don't exist alone

        const nextSuccess = Math.max(0, perfRow.success_count - 1);
        const nextFailure = perfRow.failure_count + 1;
        db.prepare(
          `UPDATE agent_performance SET success_count = ?, failure_count = ? WHERE agent_id = ? AND stage_id = ? AND task_type = ?`,
        ).run(nextSuccess, nextFailure, attr.agent_id, attr.stage_id, run.task_type);

        const perfKey = `${attr.agent_id}::${attr.stage_id}::${run.task_type}`;
        if (!adjustedPerfKeys.has(perfKey)) {
          adjustedPerfKeys.add(perfKey);
          summary.performanceRowsAdjusted++;
        }
        summary.details.push(
          `agent_performance ${perfKey}: success_count ${perfRow.success_count} -> ${nextSuccess}, failure_count ${perfRow.failure_count} -> ${nextFailure}`,
        );
      }
    }
  };

  if (options.apply) {
    db.transaction(doWork)();
  } else {
    // Compute the same summary and mutate the same rows, then roll back so
    // the database is left byte-for-byte unchanged — dry-run is the default.
    try {
      db.transaction(() => {
        doWork();
        throw new DryRunRollback();
      })();
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
  }

  return summary;
}

/** Sentinel used to force `db.transaction(...)` to roll back a dry run. */
class DryRunRollback extends Error {}
