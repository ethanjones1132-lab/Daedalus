// ═══════════════════════════════════════════════════════════════
// Model pool eligibility audit
// ─────────────────────────────────────────────────────────────
// Reviewable surface that walks OPENCODE_GO_COST_RANKS +
// KNOWN_CAPABILITIES and (optionally) live /models discovery, then
// tags each known OpenCode Go id with wire protocol, pool wiring,
// and reachability. Prefer this over hand-picking model names when
// deciding what to add to DEFAULT_ORCHESTRATOR_AGENTS.
//
// Offline (catalog-only, no network, safe for CI):
//   bun run src/orchestration/model-pool-eligibility-audit.ts
//   bun run audit:pool
//
// Live discovery (requires OpenCode Go API key in config):
//   bun run src/orchestration/model-pool-eligibility-audit.ts --live
//
// Live measured capability priors (costs money; not invented here):
//   JARVIS_EVAL_LIVE=1 bun run src/eval/model-benchmark.ts
//   (scaffold lives in docs/superpowers/plans/2026-06-30-orchestrator-hardening.md
//    Group D Task D3 — implement/run when keys are present; never invent scores)
//
// Pricing: in-repo OPENCODE_GO_COST_RANKS is a relative plan order, NOT
// dollar amounts. Real $/token pricing must come from OpenCode's docs or
// dashboard; until then every entry's `pricing_usd` is null with a note.
// ═══════════════════════════════════════════════════════════════

import type { JarvisConfig } from "../config";
import {
  DEFAULT_ORCHESTRATOR_AGENTS,
  type AgentCapabilities,
  type OrchestratorAgent,
} from "./agent-pool";
import {
  KNOWN_CAPABILITIES,
  OPENCODE_GO_COST_RANKS,
  discoverLiveOrchestratorAgents,
  openCodeGoCostRank,
  openCodeGoKnownModelIds,
  openCodeGoProtocolForModel,
  type LiveModelCatalogOptions,
  type LiveModelCatalogSnapshot,
  type OpenCodeProtocol,
  type ProviderCatalogState,
} from "./live-model-catalog";

/** Reachability vs the live OpenCode Go /models catalog. */
export type ModelReachability =
  | "offline_unknown"
  | "reachable"
  | "not_in_catalog"
  | "catalog_unavailable"
  | "unconfigured";

export type CapabilityPriorSource = "hand_authored" | "none";

export interface ModelPoolEligibilityEntry {
  model_id: string;
  provider: "opencode_go";
  /** Relative plan rank from OPENCODE_GO_COST_RANKS (lower = cheaper). */
  cost_rank: number;
  /** Wire protocol for Claude-CLI / chat paths. */
  protocol: OpenCodeProtocol;
  /** Present in DEFAULT_ORCHESTRATOR_AGENTS as opencode_go. */
  wired: boolean;
  wired_agent_id?: string;
  wired_enabled?: boolean;
  wired_default_for: string[];
  /** Hand-authored prior only — never a measured score. */
  capability_prior: Partial<AgentCapabilities> | null;
  capability_prior_source: CapabilityPriorSource;
  /** Measured eval scores are never invented; always null until a live bench lands them. */
  measured_scores: null;
  reachability: ModelReachability;
  /**
   * Real per-token USD pricing from OpenCode docs/dashboard.
   * Always null offline — ranks are relative plan order only.
   */
  pricing_usd: null;
  /** 1-based provisional delegate preference, or null if not in the provisional shortlist. */
  provisional_delegate_rank: number | null;
}

export interface ModelPoolEligibilityReport {
  generated_at: string;
  mode: "offline" | "live";
  notes: string[];
  provisional_delegate_order: readonly string[];
  catalog_status?: ProviderCatalogState;
  entries: ModelPoolEligibilityEntry[];
  summary: {
    known_count: number;
    wired_count: number;
    unwired_count: number;
    reachable_count: number | null;
    theoretical_only_count: number | null;
    with_hand_authored_prior: number;
    without_capability_prior: number;
  };
  /** Known catalog ids that are not in DEFAULT_ORCHESTRATOR_AGENTS. */
  known_but_unwired: string[];
}

/**
 * Provisional OpenCode Go delegate order pending verification / measured
 * priors. Prefer direct Anthropic-route models first (no proxy risk), then
 * higher-capability proxy models, then cheap/fast proxy fallback.
 *
 * 1. minimax-m3 — direct Anthropic route, proven, no proxy risk
 * 2. deepseek-v4-pro — via proxy, higher code/reasoning prior
 * 3. deepseek-v4-flash — via proxy, cheap/fast fallback
 */
export const PROVISIONAL_DELEGATE_ORDER = [
  "minimax-m3",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

export const PRICING_NOTE =
  "pricing_usd is null: OPENCODE_GO_COST_RANKS is relative plan order only. " +
  "Fill real $/token from OpenCode docs/dashboard when available.";

export const MEASURED_SCORES_NOTE =
  "measured_scores is always null in this audit. Hand-authored KNOWN_CAPABILITIES " +
  "priors are labeled capability_prior_source=hand_authored. To replace priors with " +
  "measured scores, run JARVIS_EVAL_LIVE=1 bun run src/eval/model-benchmark.ts " +
  "(see orchestrator-hardening Group D) when API keys are present — do not invent scores.";

function provisionalRank(modelId: string): number | null {
  const idx = (PROVISIONAL_DELEGATE_ORDER as readonly string[]).indexOf(modelId);
  return idx >= 0 ? idx + 1 : null;
}

function wiredGoAgents(agents: OrchestratorAgent[]): Map<string, OrchestratorAgent> {
  const map = new Map<string, OrchestratorAgent>();
  for (const agent of agents) {
    if (agent.provider === "opencode_go") map.set(agent.model_id, agent);
  }
  return map;
}

function buildEntry(
  modelId: string,
  wired: Map<string, OrchestratorAgent>,
  reachability: ModelReachability,
): ModelPoolEligibilityEntry {
  const agent = wired.get(modelId);
  const prior = KNOWN_CAPABILITIES[modelId] ?? null;
  return {
    model_id: modelId,
    provider: "opencode_go",
    cost_rank: openCodeGoCostRank(modelId),
    protocol: openCodeGoProtocolForModel(modelId),
    wired: Boolean(agent),
    wired_agent_id: agent?.id,
    wired_enabled: agent?.enabled,
    wired_default_for: agent ? [...agent.default_for] : [],
    capability_prior: prior ? { ...prior } : null,
    capability_prior_source: prior ? "hand_authored" : "none",
    measured_scores: null,
    reachability,
    pricing_usd: null,
    provisional_delegate_rank: provisionalRank(modelId),
  };
}

function summarize(
  entries: ModelPoolEligibilityEntry[],
  mode: "offline" | "live",
): ModelPoolEligibilityReport["summary"] {
  const reachable = entries.filter((e) => e.reachability === "reachable").length;
  const theoretical = entries.filter((e) =>
    e.reachability === "not_in_catalog" || e.reachability === "offline_unknown"
  ).length;
  return {
    known_count: entries.length,
    wired_count: entries.filter((e) => e.wired).length,
    unwired_count: entries.filter((e) => !e.wired).length,
    reachable_count: mode === "live" ? reachable : null,
    theoretical_only_count: mode === "live"
      ? entries.filter((e) => e.reachability === "not_in_catalog").length
      : theoretical,
    with_hand_authored_prior: entries.filter((e) => e.capability_prior_source === "hand_authored").length,
    without_capability_prior: entries.filter((e) => e.capability_prior_source === "none").length,
  };
}

function baseNotes(): string[] {
  return [PRICING_NOTE, MEASURED_SCORES_NOTE];
}

/**
 * Offline / catalog-based audit: walks OPENCODE_GO_COST_RANKS against
 * DEFAULT_ORCHESTRATOR_AGENTS. No network. Reachability is offline_unknown.
 */
export function buildOfflineModelPoolEligibilityReport(
  configuredAgents: OrchestratorAgent[] = DEFAULT_ORCHESTRATOR_AGENTS,
): ModelPoolEligibilityReport {
  const wired = wiredGoAgents(configuredAgents);
  const knownIds = openCodeGoKnownModelIds().sort(
    (a, b) => openCodeGoCostRank(a) - openCodeGoCostRank(b) || a.localeCompare(b),
  );
  const entries = knownIds.map((id) => buildEntry(id, wired, "offline_unknown"));
  const knownButUnwired = entries.filter((e) => !e.wired).map((e) => e.model_id);

  return {
    generated_at: new Date().toISOString(),
    mode: "offline",
    notes: [
      ...baseNotes(),
      "mode=offline: live /models discovery was not queried; reachability is offline_unknown.",
      "Re-run with --live (or buildLiveModelPoolEligibilityReport) when OpenCode Go credentials are configured.",
    ],
    provisional_delegate_order: PROVISIONAL_DELEGATE_ORDER,
    entries,
    summary: summarize(entries, "offline"),
    known_but_unwired: knownButUnwired,
  };
}

function reachabilityFromCatalog(
  modelId: string,
  catalog: ProviderCatalogState | undefined,
  liveIds: Set<string>,
): ModelReachability {
  if (!catalog) return "offline_unknown";
  if (catalog.status === "unconfigured") return "unconfigured";
  if (catalog.status === "unavailable") return "catalog_unavailable";
  if (catalog.status === "live" || catalog.status === "cached") {
    return liveIds.has(modelId) ? "reachable" : "not_in_catalog";
  }
  return "offline_unknown";
}

/**
 * Live audit: same catalog walk, enriched with discoverLiveOrchestratorAgents
 * so each known id is tagged reachable vs theoretical (not in live /models).
 */
export async function buildLiveModelPoolEligibilityReport(
  cfg: JarvisConfig,
  options: LiveModelCatalogOptions = {},
  configuredAgents: OrchestratorAgent[] = cfg.orchestrator?.agents ?? DEFAULT_ORCHESTRATOR_AGENTS,
): Promise<ModelPoolEligibilityReport> {
  const snapshot: LiveModelCatalogSnapshot = await discoverLiveOrchestratorAgents(cfg, {
    forceRefresh: true,
    ...options,
  });
  const goState = snapshot.catalogs.opencode_go;
  const liveIds = new Set(
    snapshot.agents
      .filter((a) => a.provider === "opencode_go")
      .map((a) => a.model_id),
  );
  // Live snapshot may also surface dynamic-only ids not in OPENCODE_GO_COST_RANKS;
  // for reachability of *known* ids, also consult raw live set from agents.
  // Additionally, when catalog is live, agents include both configured + discovered.

  const wired = wiredGoAgents(configuredAgents);
  const knownIds = openCodeGoKnownModelIds().sort(
    (a, b) => openCodeGoCostRank(a) - openCodeGoCostRank(b) || a.localeCompare(b),
  );
  const entries = knownIds.map((id) =>
    buildEntry(id, wired, reachabilityFromCatalog(id, goState, liveIds)),
  );

  // Append live-discovered Go ids that are NOT in the static rank table so
  // reviewers see brand-new catalog models without hardcoding their names.
  const knownSet = new Set(knownIds);
  const extraLive = [...liveIds]
    .filter((id) => !knownSet.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of extraLive) {
    entries.push(buildEntry(id, wired, "reachable"));
  }

  const knownButUnwired = entries.filter((e) => !e.wired && knownSet.has(e.model_id)).map((e) => e.model_id);

  return {
    generated_at: snapshot.discovered_at,
    mode: "live",
    notes: [
      ...baseNotes(),
      `mode=live: opencode_go catalog status=${goState.status}` +
        (goState.error ? ` error=${goState.error}` : "") +
        ` model_count=${goState.model_count} eligible_count=${goState.eligible_count}.`,
      extraLive.length > 0
        ? `Live catalog also returned ${extraLive.length} id(s) not in OPENCODE_GO_COST_RANKS: ${extraLive.join(", ")}.`
        : "No live-only (unknown-rank) Go model ids beyond OPENCODE_GO_COST_RANKS.",
    ],
    provisional_delegate_order: PROVISIONAL_DELEGATE_ORDER,
    catalog_status: { ...goState },
    entries,
    summary: summarize(entries, "live"),
    known_but_unwired: knownButUnwired,
  };
}

/** Compact human-readable report for CLI / review. */
export function formatModelPoolEligibilityReport(report: ModelPoolEligibilityReport): string {
  const lines: string[] = [];
  lines.push(`# Model pool eligibility audit (${report.mode})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push("");
  lines.push("## Provisional delegate order (pending verification)");
  for (let i = 0; i < report.provisional_delegate_order.length; i++) {
    const id = report.provisional_delegate_order[i]!;
    const entry = report.entries.find((e) => e.model_id === id);
    const proto = entry?.protocol ?? openCodeGoProtocolForModel(id);
    const wired = entry?.wired ? "wired" : "UNWIRED";
    const reach = entry?.reachability ?? "offline_unknown";
    lines.push(`  ${i + 1}. opencode_go:${id}  protocol=${proto}  ${wired}  reachability=${reach}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(`  known=${report.summary.known_count} wired=${report.summary.wired_count} unwired=${report.summary.unwired_count}`);
  lines.push(`  hand_authored_priors=${report.summary.with_hand_authored_prior} no_prior=${report.summary.without_capability_prior}`);
  if (report.summary.reachable_count !== null) {
    lines.push(`  reachable=${report.summary.reachable_count} theoretical_only=${report.summary.theoretical_only_count}`);
  } else {
    lines.push(`  reachability=offline_unknown (use --live for /models discovery)`);
  }
  lines.push("");
  lines.push("## Known-but-unwired");
  if (report.known_but_unwired.length === 0) {
    lines.push("  (none)");
  } else {
    for (const id of report.known_but_unwired) {
      const e = report.entries.find((x) => x.model_id === id)!;
      lines.push(
        `  - ${id}  rank=${e.cost_rank}  protocol=${e.protocol}  reachability=${e.reachability}  prior=${e.capability_prior_source}`,
      );
    }
  }
  lines.push("");
  lines.push("## All known OpenCode Go models");
  lines.push(
    "model_id".padEnd(22) +
      "rank".padStart(5) +
      "  protocol   wired  enabled  reachability         prior            pricing",
  );
  for (const e of report.entries) {
    const wired = e.wired ? "yes" : "no ";
    const enabled = e.wired_enabled === undefined ? "  -  " : e.wired_enabled ? " yes " : " no  ";
    lines.push(
      e.model_id.padEnd(22) +
        String(e.cost_rank).padStart(5) +
        "  " +
        e.protocol.padEnd(10) +
        wired +
        "  " +
        enabled +
        "  " +
        e.reachability.padEnd(20) +
        e.capability_prior_source.padEnd(16) +
        "null",
    );
  }
  lines.push("");
  lines.push("## Notes");
  for (const note of report.notes) lines.push(`  - ${note}`);
  lines.push("");
  lines.push("## How to run");
  lines.push("  Offline:  bun run src/orchestration/model-pool-eligibility-audit.ts");
  lines.push("  Live:     bun run src/orchestration/model-pool-eligibility-audit.ts --live");
  lines.push("  Measured: JARVIS_EVAL_LIVE=1 bun run src/eval/model-benchmark.ts  # when scaffolded + keys present");
  return lines.join("\n");
}

/** Ensure static rank table and protocol map stay the audit's source of truth. */
export function assertCatalogCoherence(): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const ids = Object.keys(OPENCODE_GO_COST_RANKS);
  if (ids.length === 0) problems.push("OPENCODE_GO_COST_RANKS is empty");
  for (const id of PROVISIONAL_DELEGATE_ORDER) {
    if (!(id in OPENCODE_GO_COST_RANKS)) {
      problems.push(`provisional delegate ${id} missing from OPENCODE_GO_COST_RANKS`);
    }
  }
  for (const id of ids) {
    const protocol = openCodeGoProtocolForModel(id);
    if (protocol !== "openai" && protocol !== "anthropic") {
      problems.push(`unexpected protocol for ${id}: ${String(protocol)}`);
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ── CLI ──────────────────────────────────────────────────────────
if (import.meta.main) {
  const live = process.argv.includes("--live");
  const asJson = process.argv.includes("--json");

  let report: ModelPoolEligibilityReport;
  if (live) {
    const { loadConfig } = await import("../config");
    const cfg = loadConfig();
    report = await buildLiveModelPoolEligibilityReport(cfg);
  } else {
    report = buildOfflineModelPoolEligibilityReport();
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatModelPoolEligibilityReport(report));
  }
}
