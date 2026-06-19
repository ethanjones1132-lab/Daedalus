
export class SelfTuningStore {
  private cachedDb: Database | null = null;

  constructor(private dbPathOverride?: string) {}

  private getDb(): Database | null {
    try {
      if (this.dbPathOverride === ":memory:") {
        if (!this.cachedDb) {
          const db = new Database(":memory:");
          db.close = () => {}; // Make close a no-op so the in-memory DB stays alive
          this.cachedDb = db;
        }
        return this.cachedDb;
      }
      const dbPath = this.dbPathOverride || locateJarvisDb();
      if (!dbPath) return null;
      return this.dbPathOverride ? new Database(dbPath, { create: true }) : new Database(dbPath);
    } catch (e) {
      console.error("[SelfTuningStore] open failed:", e);
      return null;
    }
  }

  insertAgentRun(run: AgentRun): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO agent_runs (id, session_id, user_request, task_type, pipeline, completed, final_output, user_rating, duration_ms, tool_calls_count, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id,
        run.session_id,
        run.user_request,
        run.task_type,
        run.pipeline,
        run.completed,
        run.final_output ?? null,
        run.user_rating ?? null,
        run.duration_ms ?? null,
        run.tool_calls_count ?? null,
        run.token_count ?? null
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertAgentRun failed:", e);
    } finally {
      db.close();
    }
  }

  updateAgentRun(runId: string, updates: Partial<AgentRun>): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const keys = Object.keys(updates);
      if (keys.length === 0) return;
      const setClause = keys.map((k) => `${k} = ?`).join(", ");
      const params = keys.map((k) => (updates as any)[k]);
      params.push(runId);
      db.prepare(`UPDATE agent_runs SET ${setClause} WHERE id = ?`).run(...params);
    } catch (e) {
      console.error("[SelfTuningStore] updateAgentRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertStageRun(stage: StageRun): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO stage_runs (id, agent_run_id, mode_id, turn_number, input_tokens, output_tokens, tool_calls_json, duration_ms, was_successful, had_error, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stage.id,
        stage.agent_run_id,
        stage.mode_id,
        stage.turn_number,
        stage.input_tokens ?? null,
        stage.output_tokens ?? null,
        stage.tool_calls_json ?? "[]",
        stage.duration_ms ?? null,
        stage.was_successful,
        stage.had_error,
        stage.error_message ?? null
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertStageRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertTuningProposal(prop: TuningProposal): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO tuning_proposals (id, agent_run_id, proposal_type, task_type, current_value, proposed_value, rationale, applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        prop.id,
        prop.agent_run_id,
        prop.proposal_type,
        prop.task_type,
        prop.current_value ?? null,
        prop.proposed_value ?? null,
        prop.rationale ?? null,
        prop.applied
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertTuningProposal failed:", e);
    } finally {
      db.close();
    }
  }

  insertTuningOutcome(outcome: TuningOutcome): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO tuning_outcomes (id, proposal_id, user_rating_delta, token_delta, success_rate_delta)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        outcome.id,
        outcome.proposal_id,