/**
 * `/tuning/proposals` and `/tuning/proposals/apply` — route contracts.
 *
 * The operator-facing defect: `POST /tuning/proposals/apply` truthiness-checked
 * only `body.id`, called a `void` function that swallowed every DB error, and
 * answered `{ ok: true }` unconditionally — so a stale or mistyped id reported
 * a success that never happened. Its sibling `GET /tuning/proposals` never
 * returned a measured conclusion at all, so none of it was detectable.
 */
import { describe, expect, test } from "bun:test";
import { handleTuningProposalsRequest } from "./tuning-routes";
import { SelfTuningStore, type AgentRun, type TuningProposal } from "./self-tuning/store";
import { evaluatePendingTuningOutcomes } from "./self-tuning/outcome-loop";

function seedRun(store: SelfTuningStore, opts: { id: string; taskType: string; outcome?: string; rating?: number }): void {
  const run: AgentRun = {
    id: opts.id,
    session_id: "sess_routes",
    user_request: `fixture ${opts.id}`,
    task_type: opts.taskType,
    pipeline: "[]",
    completed: 1,
    duration_ms: 5,
    tool_calls_count: 0,
    token_count: 0,
  };
  if (opts.rating !== undefined) run.user_rating = opts.rating;
  expect(store.insertAgentRun(run)).toBe(true);
  if (opts.outcome !== undefined) store.updateAgentRun(opts.id, { outcome: opts.outcome });
}

function seedProposal(store: SelfTuningStore, opts: { id: string; taskType: string; runId: string }): void {
  store.insertTuningProposal({
    id: opts.id,
    agent_run_id: opts.runId,
    proposal_type: "temperature",
    task_type: opts.taskType,
    current_value: "0.4",
    proposed_value: "0.3",
    rationale: "fixture proposal for route contracts",
    applied: 0,
  });
}

function getReq(path = "/tuning/proposals"): Request {
  return new Request(`http://local${path}`, { method: "GET" });
}

function postReq(path: string, body: unknown): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function appliedEntry(payload: any, id: string): any {
  return (payload.applied as any[]).find((p) => p.id === id);
}

describe("GET /tuning/proposals", () => {
  test("keeps the pending/applied keys and reports both lists", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "g0", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_g_pending", taskType: "coding", runId: "g0" });
    seedProposal(store, { id: "prop_g_applied", taskType: "coding", runId: "g0" });
    store.applyTuningProposal("prop_g_applied");

    const res = await handleTuningProposalsRequest(getReq(), store);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const payload = await res!.json();
    expect(Object.keys(payload).sort()).toEqual(["applied", "pending"]);
    expect(payload.pending.map((p: TuningProposal) => p.id)).toEqual(["prop_g_pending"]);
    expect(payload.applied.map((p: TuningProposal) => p.id)).toEqual(["prop_g_applied"]);
  });

  test("an applied + measured proposal reports its conclusion with checkable provenance", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "m0", taskType: "coding", outcome: "failed" });
    seedRun(store, { id: "m1", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_m_measured", taskType: "coding", runId: "m1" });
    store.applyTuningProposal("prop_m_measured");
    seedRun(store, { id: "p0", taskType: "coding", outcome: "success" });
    seedRun(store, { id: "p1", taskType: "coding", outcome: "success" });
    seedRun(store, { id: "p2", taskType: "coding", outcome: "success" });
    expect(evaluatePendingTuningOutcomes(store, { minSamples: 3 })).toHaveLength(1);

    const payload = await (await handleTuningProposalsRequest(getReq(), store))!.json();
    const entry = appliedEntry(payload, "prop_m_measured");
    expect(entry.measurement.state).toBe("measured");
    expect(entry.measurement.reason).toBeNull();
    expect(entry.measurement.measured).toBeCloseTo(1, 5);
    expect(entry.measurement.baseline).toBeCloseTo(0, 5);
    expect(entry.measurement.improved).toBe(1);
    expect(entry.measurement.sample_n).toBe(3);
    expect(entry.measurement.minSamples).toBe(3);
    expect(typeof entry.measurement.measured_at).toBe("string");
    // Apply-time provenance travels with the same row.
    expect(typeof entry.applied_at).toBe("string");
    expect(entry.baseline_success_rate).toBeCloseTo(0, 5);
    expect(entry.pre_apply_run_count).toBe(2);
  });

  test("a proposal with too few post-apply runs reads as awaiting samples, not absent or failed", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "a0", taskType: "coding", outcome: "success" });
    seedProposal(store, { id: "prop_awaiting", taskType: "coding", runId: "a0" });
    store.applyTuningProposal("prop_awaiting");
    seedRun(store, { id: "a_post_0", taskType: "coding", outcome: "success" });

    const payload = await (await handleTuningProposalsRequest(getReq(), store))!.json();
    const entry = appliedEntry(payload, "prop_awaiting");
    expect(entry.measurement.state).toBe("awaiting_samples");
    expect(entry.measurement.reason).toBe("post_apply_samples_below_minimum");
    expect(entry.measurement.sample_n).toBe(1);
    expect(entry.measurement.measured).toBeNull();
    expect(entry.measurement.improved).toBeNull();
    expect(entry.measurement.baseline).toBeCloseTo(1, 5);
    expect(entry.measurement.measured_at).toBeNull();
  });

  test("a proposal whose baseline was never measurable states that instead of showing 0", async () => {
    const store = new SelfTuningStore(":memory:");
    seedProposal(store, { id: "prop_nobase", taskType: "coding", runId: "nonexistent" });
    // Applied with no prior runs for the task_type: the baseline is unavailable.
    expect(store.applyTuningProposal("prop_nobase").ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      seedRun(store, { id: `nb_post_${i}`, taskType: "coding", outcome: "success" });
    }

    const payload = await (await handleTuningProposalsRequest(getReq(), store))!.json();
    const entry = appliedEntry(payload, "prop_nobase");
    expect(entry.measurement.state).toBe("baseline_unavailable");
    expect(entry.measurement.reason).toBe("baseline_unavailable");
    expect(entry.measurement.baseline).toBeNull();
    expect(entry.measurement.improved).toBeNull();
    expect(entry.baseline_success_rate).toBeNull();
    expect(entry.measurement.measured).toBeCloseTo(1, 5);
  });

  test("an unrated post-apply run is reported as unknown, not as a success", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "u0", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_unrated", taskType: "coding", runId: "u0" });
    store.applyTuningProposal("prop_unrated");
    seedRun(store, { id: "u_post_0", taskType: "coding" });
    seedRun(store, { id: "u_post_1", taskType: "coding" });
    seedRun(store, { id: "u_post_2", taskType: "coding" });

    const payload = await (await handleTuningProposalsRequest(getReq(), store))!.json();
    const entry = appliedEntry(payload, "prop_unrated");
    expect(entry.measurement.state).toBe("awaiting_samples");
    expect(entry.measurement.reason).toBe("post_apply_outcomes_unknown");
    expect(entry.measurement.unknown_n).toBe(3);
    expect(entry.measurement.known_n).toBe(0);
    expect(entry.measurement.measured).toBeNull();
    expect(entry.measurement.improved).toBeNull();
  });

  test("an unapplied proposal carries no fabricated measurement window", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "q0", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_unapplied", taskType: "coding", runId: "q0" });

    const payload = await (await handleTuningProposalsRequest(getReq(), store))!.json();
    const entry = (payload.pending as any[]).find((p) => p.id === "prop_unapplied");
    expect(entry.measurement.state).toBe("awaiting_samples");
    expect(entry.measurement.sample_n).toBe(0);
    expect(entry.measurement.measured).toBeNull();
    expect(entry.applied_at).toBeNull();
  });

  test("GET never applies anything (read path stays read-only)", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "ro0", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_readonly", taskType: "coding", runId: "ro0" });

    const before = store.getTuningProposal("prop_readonly");
    await handleTuningProposalsRequest(getReq(), store);
    const after = store.getTuningProposal("prop_readonly");
    expect(after?.applied).toBe(before?.applied);
    expect(after?.applied_at).toBeNull();
  });
});

describe("POST /tuning/proposals/apply", () => {
  test("a real id is applied and answers with the snapshot it captured", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "s0", taskType: "coding", outcome: "success" });
    seedRun(store, { id: "s1", taskType: "coding", outcome: "failed" });
    seedProposal(store, { id: "prop_ok", taskType: "coding", runId: "s1" });

    const res = await handleTuningProposalsRequest(
      postReq("/tuning/proposals/apply", { id: "prop_ok" }),
      store,
    );
    expect(res!.status).toBe(200);
    const payload = await res!.json();
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(true);
    expect(payload.id).toBe("prop_ok");
    expect(typeof payload.applied_at).toBe("string");
    expect(payload.baseline).toBeCloseTo(0.5, 5);
    expect(payload.baseline_state).toBe("available");
    expect(payload.pre_apply_run_count).toBe(2);
  });

  test("a nonexistent id is a 404, never { ok: true }", async () => {
    const store = new SelfTuningStore(":memory:");
    const res = await handleTuningProposalsRequest(
      postReq("/tuning/proposals/apply", { id: "prop_does_not_exist" }),
      store,
    );
    expect(res!.status).toBe(404);
    const payload = await res!.json();
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("not_found");
    expect(payload.applied).toBe(false);
  });

  test("a no-op re-apply reports applied=false and keeps the original snapshot", async () => {
    const store = new SelfTuningStore(":memory:");
    seedRun(store, { id: "n0", taskType: "coding", outcome: "success" });
    seedProposal(store, { id: "prop_again", taskType: "coding", runId: "n0" });
    const first = await handleTuningProposalsRequest(
      postReq("/tuning/proposals/apply", { id: "prop_again" }),
      store,
    );
    const firstPayload = await first!.json();
    const original = store.getTuningProposal("prop_again");

    // A second apply after new runs have landed must not re-snapshot the baseline.
    seedRun(store, { id: "n1", taskType: "coding", outcome: "failed" });
    const second = await handleTuningProposalsRequest(
      postReq("/tuning/proposals/apply", { id: "prop_again" }),
      store,
    );
    expect(second!.status).toBe(200);
    const payload = await second!.json();
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(false);
    expect(payload.baseline).toBeCloseTo(firstPayload.baseline, 5);
    const after = store.getTuningProposal("prop_again");
    expect(after?.applied_at).toBe(original?.applied_at);
    expect(after?.baseline_success_rate).toBeCloseTo(1, 5);
    expect(after?.pre_apply_run_count).toBe(1);
  });

  test("a malformed id is rejected before SQLite is touched", async () => {
    const store = new SelfTuningStore(":memory:");
    const calls: string[] = [];
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "applyTuningProposal") {
          return (id: string) => {
            calls.push(id);
            return target.applyTuningProposal(id);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    for (const body of [{}, { id: "" }, { id: 42 }, { id: null }, { id: "a".repeat(129) }, { id: "prop' OR 1=1" }, { id: "  prop_x  " }]) {
      const res = await handleTuningProposalsRequest(
        postReq("/tuning/proposals/apply", body),
        spy as unknown as SelfTuningStore,
      );
      expect(res!.status).toBe(400);
      const payload = await res!.json();
      expect(payload.ok).toBe(false);
      expect(payload.reason).toBe("invalid_id");
    }
    expect(calls).toEqual([]);
  });

  test("an unparseable body is a 400, not a 500 and not a silent success", async () => {
    const store = new SelfTuningStore(":memory:");
    const res = await handleTuningProposalsRequest(
      new Request("http://local/tuning/proposals/apply", { method: "POST", body: "{not json" }),
      store,
    );
    expect(res!.status).toBe(400);
    const payload = await res!.json();
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("invalid_id");
  });

  test("a store failure is reported, never as ok:true", async () => {
    const unavailable = {
      getPendingProposals: () => [],
      getAppliedProposals: () => [],
      getTuningOutcomes: () => [],
      getCompletedAgentRunsForTaskType: () => [],
      applyTuningProposal: () => ({ ok: false, id: "prop_x", reason: "store_unavailable" as const }),
    };
    const failed = { ...unavailable, applyTuningProposal: () => ({ ok: false, id: "prop_x", reason: "store_failed" as const }) };

    const a = await handleTuningProposalsRequest(postReq("/tuning/proposals/apply", { id: "prop_x" }), unavailable as any);
    expect(a!.status).toBe(503);
    expect((await a!.json()).reason).toBe("store_unavailable");

    const b = await handleTuningProposalsRequest(postReq("/tuning/proposals/apply", { id: "prop_x" }), failed as any);
    expect(b!.status).toBe(500);
    expect((await b!.json()).reason).toBe("store_failed");
  });

  test("an unrelated path is left for the caller's own 404", async () => {
    const store = new SelfTuningStore(":memory:");
    expect(await handleTuningProposalsRequest(getReq("/tuning/other"), store)).toBeNull();
    expect(await handleTuningProposalsRequest(postReq("/tuning/proposals", { id: "x" }), store)).toBeNull();
    expect(
      await handleTuningProposalsRequest(
        new Request("http://local/tuning/proposals/apply", { method: "DELETE" }),
        store,
      ),
    ).toBeNull();
  });
});
