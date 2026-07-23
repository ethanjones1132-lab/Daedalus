import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";
import {
  KNOWN_CAPABILITIES,
  OPENCODE_GO_COST_RANKS,
  openCodeGoKnownModelIds,
  openCodeGoProtocolForModel,
  resetLiveModelCatalogCache,
} from "./live-model-catalog";
import {
  MEASURED_SCORES_NOTE,
  PRICING_NOTE,
  PROVISIONAL_DELEGATE_ORDER,
  assertCatalogCoherence,
  buildLiveModelPoolEligibilityReport,
  buildOfflineModelPoolEligibilityReport,
  formatModelPoolEligibilityReport,
} from "./model-pool-eligibility-audit";

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("model pool eligibility audit (offline/catalog)", () => {
  test("catalog coherence: provisional order and rank table agree", () => {
    expect(assertCatalogCoherence()).toEqual({ ok: true });
  });

  test("offline report walks every OPENCODE_GO_COST_RANKS id", () => {
    const report = buildOfflineModelPoolEligibilityReport();
    const known = new Set(openCodeGoKnownModelIds());
    expect(report.mode).toBe("offline");
    expect(report.summary.known_count).toBe(known.size);
    expect(report.entries.map((e) => e.model_id).sort()).toEqual([...known].sort());
    for (const entry of report.entries) {
      expect(entry.provider).toBe("opencode_go");
      expect(entry.cost_rank).toBe(OPENCODE_GO_COST_RANKS[entry.model_id] ?? 1_000);
      expect(entry.protocol).toBe(openCodeGoProtocolForModel(entry.model_id));
      expect(entry.reachability).toBe("offline_unknown");
      expect(entry.pricing_usd).toBeNull();
      expect(entry.measured_scores).toBeNull();
    }
  });

  test("tags wired vs known-but-unwired against DEFAULT_ORCHESTRATOR_AGENTS", () => {
    const report = buildOfflineModelPoolEligibilityReport();
    const wiredGo = new Set(
      DEFAULT_ORCHESTRATOR_AGENTS
        .filter((a) => a.provider === "opencode_go")
        .map((a) => a.model_id),
    );

    expect(wiredGo.has("minimax-m3")).toBe(true);
    expect(wiredGo.has("deepseek-v4-pro")).toBe(true);
    expect(wiredGo.has("deepseek-v4-flash")).toBe(true);

    for (const id of ["minimax-m3", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5"] as const) {
      const entry = report.entries.find((e) => e.model_id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.wired).toBe(true);
      expect(report.known_but_unwired).not.toContain(id);
    }

    // Theoretical / not yet wired catalog members — do not hardcode a full
    // allow-list of *wired* names elsewhere; surface unwired ids from the pool.
    for (const id of ["glm-5", "kimi-k2.7-code", "grok-4.5", "qwen3.7-max"] as const) {
      expect(OPENCODE_GO_COST_RANKS[id]).toBeDefined();
      expect(wiredGo.has(id)).toBe(false);
      const entry = report.entries.find((e) => e.model_id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.wired).toBe(false);
      expect(report.known_but_unwired).toContain(id);
    }

    expect(report.summary.wired_count).toBe(wiredGo.size);
    expect(report.summary.unwired_count).toBe(report.known_but_unwired.length);
  });

  test("tags wire protocol via openCodeGoProtocolForModel", () => {
    const report = buildOfflineModelPoolEligibilityReport();
    const byId = Object.fromEntries(report.entries.map((e) => [e.model_id, e]));

    expect(byId["minimax-m3"]!.protocol).toBe("anthropic");
    expect(byId["qwen3.7-max"]!.protocol).toBe("anthropic");
    expect(byId["qwen3.5-plus"]!.protocol).toBe("anthropic");
    expect(byId["deepseek-v4-pro"]!.protocol).toBe("openai");
    expect(byId["deepseek-v4-flash"]!.protocol).toBe("openai");
    expect(byId["glm-5"]!.protocol).toBe("openai");
    expect(byId["kimi-k2.7-code"]!.protocol).toBe("openai");
    expect(byId["grok-4.5"]!.protocol).toBe("openai");
  });

  test("surfaces hand-authored priors without inventing measured scores", () => {
    const report = buildOfflineModelPoolEligibilityReport();
    const flash = report.entries.find((e) => e.model_id === "deepseek-v4-flash")!;
    const glm = report.entries.find((e) => e.model_id === "glm-5")!;

    expect(flash.capability_prior_source).toBe("hand_authored");
    expect(flash.capability_prior).toEqual(KNOWN_CAPABILITIES["deepseek-v4-flash"]);
    expect(flash.measured_scores).toBeNull();

    expect(glm.capability_prior_source).toBe("none");
    expect(glm.capability_prior).toBeNull();
    expect(glm.measured_scores).toBeNull();

    expect(report.notes.some((n) => n.includes("measured_scores"))).toBe(true);
    expect(MEASURED_SCORES_NOTE.length).toBeGreaterThan(20);
    expect(PRICING_NOTE.length).toBeGreaterThan(20);
  });

  test("documents provisional delegate order with ranks 1..3", () => {
    const report = buildOfflineModelPoolEligibilityReport();
    expect(report.provisional_delegate_order).toEqual([
      "minimax-m3",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
    expect([...PROVISIONAL_DELEGATE_ORDER]).toEqual([...report.provisional_delegate_order]);

    for (let i = 0; i < PROVISIONAL_DELEGATE_ORDER.length; i++) {
      const id = PROVISIONAL_DELEGATE_ORDER[i]!;
      const entry = report.entries.find((e) => e.model_id === id)!;
      expect(entry.provisional_delegate_rank).toBe(i + 1);
      expect(entry.wired).toBe(true);
    }

    const unwired = report.entries.find((e) => e.model_id === "glm-5")!;
    expect(unwired.provisional_delegate_rank).toBeNull();
  });

  test("format report includes provisional order, unwired list, and how-to-run", () => {
    const text = formatModelPoolEligibilityReport(buildOfflineModelPoolEligibilityReport());
    expect(text).toContain("Provisional delegate order");
    expect(text).toContain("opencode_go:minimax-m3");
    expect(text).toContain("opencode_go:deepseek-v4-pro");
    expect(text).toContain("opencode_go:deepseek-v4-flash");
    expect(text).toContain("Known-but-unwired");
    expect(text).toContain("glm-5");
    expect(text).toContain("kimi-k2.7-code");
    expect(text).toContain("--live");
    expect(text).toContain("model-benchmark.ts");
    expect(text).toContain("pricing_usd is null");
  });

  test("offline path accepts a custom agent list (test-exportable)", () => {
    const report = buildOfflineModelPoolEligibilityReport([
      {
        id: "only-flash",
        provider: "opencode_go",
        model_id: "deepseek-v4-flash",
        capabilities: { code: 0.9, reasoning: 0.8, speed: 0.8, cost: 0.8, json_reliability: 0.9 },
        default_for: ["coordinator"],
        enabled: true,
      },
    ]);
    expect(report.entries.find((e) => e.model_id === "deepseek-v4-flash")!.wired).toBe(true);
    expect(report.entries.find((e) => e.model_id === "minimax-m3")!.wired).toBe(false);
    expect(report.known_but_unwired).toContain("minimax-m3");
    expect(report.summary.wired_count).toBe(1);
  });
});

describe("model pool eligibility audit (live discovery path)", () => {
  test("live mode marks reachable vs theoretical-only known ids", async () => {
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.opencode_go.api_key = "go-test-key-for-audit";
    cfg.openrouter.api_key = "";
    cfg.opencode_zen.api_key = "";
    cfg.orchestrator.agents = DEFAULT_ORCHESTRATOR_AGENTS.filter((a) => a.provider === "opencode_go");

    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/zen/go/") || url.includes("opencode")) {
        return json([
          { id: "deepseek-v4-flash" },
          { id: "minimax-m3" },
          { id: "deepseek-v4-pro" },
          { id: "brand-new-go-model" },
        ]);
      }
      return new Response("unconfigured", { status: 401 });
    };

    const report = await buildLiveModelPoolEligibilityReport(cfg, { fetcher, forceRefresh: true });
    expect(report.mode).toBe("live");
    expect(report.catalog_status?.status).toBe("live");

    const byId = Object.fromEntries(report.entries.map((e) => [e.model_id, e]));
    expect(byId["deepseek-v4-flash"]!.reachability).toBe("reachable");
    expect(byId["minimax-m3"]!.reachability).toBe("reachable");
    expect(byId["deepseek-v4-pro"]!.reachability).toBe("reachable");
    expect(byId["glm-5"]!.reachability).toBe("not_in_catalog");
    expect(byId["kimi-k2.7-code"]!.reachability).toBe("not_in_catalog");
    expect(byId["grok-4.5"]!.reachability).toBe("not_in_catalog");

    // Live-only id beyond the static rank table is surfaced, still with null pricing/measured.
    expect(byId["brand-new-go-model"]).toBeDefined();
    expect(byId["brand-new-go-model"]!.reachability).toBe("reachable");
    expect(byId["brand-new-go-model"]!.pricing_usd).toBeNull();
    expect(byId["brand-new-go-model"]!.measured_scores).toBeNull();
    expect(byId["brand-new-go-model"]!.cost_rank).toBe(1_000);

    expect(report.summary.reachable_count).toBeGreaterThanOrEqual(4);
    expect(report.summary.theoretical_only_count).toBeGreaterThan(0);
    expect(report.known_but_unwired).toContain("glm-5");
  });

  test("live mode reports unconfigured when Go key is missing", async () => {
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.opencode_go.api_key = "";
    cfg.openrouter.api_key = "";
    cfg.opencode_zen.api_key = "";

    const report = await buildLiveModelPoolEligibilityReport(cfg, {
      fetcher: async () => {
        throw new Error("should not fetch without key");
      },
      forceRefresh: true,
    });

    expect(report.mode).toBe("live");
    expect(report.catalog_status?.status).toBe("unconfigured");
    expect(report.entries.every((e) => e.reachability === "unconfigured" || e.model_id === "brand-new-go-model")).toBe(true);
    // No live ids when unconfigured — every known id is unconfigured.
    for (const entry of report.entries) {
      if (entry.model_id in OPENCODE_GO_COST_RANKS) {
        expect(entry.reachability).toBe("unconfigured");
      }
    }
  });
});
