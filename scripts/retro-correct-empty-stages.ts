// One-off retro-correction. Run manually with:
//   bun scripts/retro-correct-empty-stages.ts
// Stop the live server before running so its collector cannot race the update.
// F1: model-only stages that returned empty completions were recorded as
// successful, which let the self-tuner keep rewarding dead stage candidates.
// Executor rows are intentionally excluded because tool-call turns can emit
// zero visible tokens while still producing valid evidence.
import { Database } from "bun:sqlite";

const DB_PATH = "C:/Users/ethan/.openclaw/jarvis/self-tuning.db";
const db = new Database(DB_PATH);

const preview = db.query(`
  SELECT mode_id, COUNT(*) AS n FROM stage_runs
  WHERE mode_id IN ('planner','reviewer','rewriter')
    AND (output_tokens = 0 OR output_tokens IS NULL)
    AND tool_calls_json = '[]'
    AND was_successful = 1
    AND created_at >= '2026-07-10'
  GROUP BY mode_id
`).all();
console.log("Rows to re-label:", JSON.stringify(preview));

db.run(`
  UPDATE stage_runs
  SET was_successful = 0,
      had_error = 1,
      error_message = 'empty_completion_retro_20260715'
  WHERE mode_id IN ('planner','reviewer','rewriter')
    AND (output_tokens = 0 OR output_tokens IS NULL)
    AND tool_calls_json = '[]'
    AND was_successful = 1
    AND created_at >= '2026-07-10'
`);
console.log("Done. Restart the server so heuristics re-read corrected labels.");
db.close();
