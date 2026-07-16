import { describe, expect, test } from "bun:test";
import { SelfTuningStore } from "./store";

describe("SelfTuningStore recent stage attributions", () => {
  test("returns newest-first rows for a stage since a cutoff and respects the limit", () => {
    const store = new SelfTuningStore(":memory:");
    const insertedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `attr-${i}`;
      insertedIds.push(id);
      store.insertModelAttribution({
        id,
        agent_run_id: `run-${i}`,
        stage_id: "coordinator",
        provider: "opencode_go",
        model_id: "deepseek-v4-flash",
        was_successful: i % 2 === 0 ? 1 : 0,
        had_error: i % 2 === 0 ? 0 : 1,
        fallback_used: 0,
      });
    }
    store.insertModelAttribution({
      id: "attr-other-stage",
      agent_run_id: "run-other-stage",
      stage_id: "executor",
      provider: "opencode_go",
      model_id: "deepseek-v4-flash",
      was_successful: 1,
      had_error: 0,
      fallback_used: 0,
    });

    const rows = store.getRecentStageAttributions("coordinator", "1970-01-01T00:00:00.000Z", 3);
    const futureRows = store.getRecentStageAttributions("coordinator", "2999-01-01T00:00:00.000Z", 3);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.stage_id)).toEqual(["coordinator", "coordinator", "coordinator"]);
    expect(rows.map((row) => row.id)).toEqual(insertedIds.slice(-3).reverse());
    expect(futureRows).toEqual([]);
  });
});
