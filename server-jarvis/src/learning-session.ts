// ═══════════════════════════════════════════════════════════════
// ── Learning Session research service ──
// ═══════════════════════════════════════════════════════════════
// Bounded source-grounded research for the native learning session. Reached
// only over the private capability-authenticated `/internal/learning/*` route;
// the caller (native-memory route handler) has already verified the app bearer
// capability.
//
// Trust boundary:
//   * Native validates the persisted Session → owner Agent → canonical
//     workspace → exact completed Agent run tuple before dispatch. This module
//     receives that already-validated identity tuple only. It never accepts a
//     caller Agent, workspace, snapshot JSON, permission, or trajectory payload.
//   * The source trajectory evidence is resolved from this process's existing
//     SelfTuningStore by the exact (agent_run_id, session_id) tuple; it must be
//     unique, strictly decode, and match the tuple. Absent/ambiguous/failed
//     lookups return unavailable BEFORE any ToolRuntime is created.
//   * Retrieval runs only through the canonical ToolRuntime's existing
//     `web_search`/`web_fetch` tools under the current permission policy, with
//     the context bound to the validated Session and workspace. It never issues
//     a direct HTTP request, never sets `skip_approval_gate`, and never runs a
//     tool for which policy does not resolve to `allow`.
//   * Findings carry the verified run identity and trajectory digest plus the
//     actual source/tool provenance. No research run id is minted.
//
// Nothing is written to disk here; native owns output and writes only when
// genuine findings exist.

import { createHash, randomUUID } from "node:crypto";
import type { JarvisConfig } from "./config";
import {
  createToolRuntime,
  evaluatePolicy,
  makeExecutionContext,
  type ExecutionContext,
  type ToolRuntime,
} from "./tool-runtime";
import { registerWebBundle } from "./web-bundle";
import { decodeSkillTrajectorySnapshot } from "./intelligence/skill-source-evidence";
import { SelfTuningStore } from "./self-tuning/store";

export interface LearningResearchRequest {
  request_id: string;
  agent_run_id: string;
  session_id: string;
  agent_id: string;
  project_root: string;
  topic: string;
  subtopic: string;
  seed_urls?: string[];
  max_sources?: number;
  timeout_ms?: number;
}

export interface LearningFinding {
  subtopic: string;
  source_url: string;
  source_host: string;
  retrieved_at: string;
  content_digest: string;
  excerpt: string;
  reference: string;
  tool_name: string;
  tool_call_id: string;
  run_id: string;
  trajectory_digest: string;
  bun_instance_id: string;
}

export type LearningOutcome = "complete" | "partial" | "unavailable";

export interface LearningEvidenceBinding {
  status: "bound" | "unavailable";
  agent_run_id?: string;
  session_id?: string;
  tool_sequence_digest?: string;
  reason?: string;
}

export interface LearningRejectedSource {
  url: string;
  reason: string;
}

export interface LearningResearchResponse {
  request_id: string;
  bun_instance_id: string;
  run_id: string;
  outcome: LearningOutcome;
  reason?: string;
  findings: LearningFinding[];
  rejected_sources: LearningRejectedSource[];
  evidence_binding: LearningEvidenceBinding;
  started_at: string;
  finished_at: string;
}

const MAX_SOURCES = 8;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESEARCH_TIMEOUT_MS = 180_000;
const PER_CALL_TIMEOUT_MS = 20_000;
const EXCERPT_CHARS = 1_500;

// ── Host allowlist (parsed hostname only; never path/query text) ──────────────

const TIER1_HOSTS = [
  "arxiv.org",
  "github.com",
  "gitlab.com",
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "ieee.org",
  "acm.org",
  "wikipedia.org",
];
const TIER1_SUFFIXES = [".edu", ".gov"];
const REJECTED_HOSTS = [
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "w3schools.com",
];

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

export type SourceUrlEvaluation =
  | { ok: true; canonicalUrl: string; host: string }
  | { ok: false; url: string; reason: string };

/**
 * Parse a URL and decide its source tier from the hostname alone. Malformed
 * URLs, non-HTTP(S) schemes, embedded credentials, social/low-quality hosts,
 * and lookalike suffixes are rejected with a concrete reason; path and query
 * text are never inspected.
 */
export function evaluateSourceUrl(rawUrl: unknown): SourceUrlEvaluation {
  const input = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!input) return { ok: false, url: "", reason: "empty URL" };

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, url: input, reason: "malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, url: input, reason: `unsupported scheme: ${parsed.protocol}` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, url: input, reason: "URL contains credentials" };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, url: input, reason: "URL has no host" };

  for (const bad of REJECTED_HOSTS) {
    if (hostMatches(host, bad)) {
      return {
        ok: false,
        url: parsed.toString(),
        reason: `social or low-quality surface: ${bad}`,
      };
    }
  }

  const allowed =
    TIER1_HOSTS.some((good) => hostMatches(host, good)) ||
    TIER1_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    return { ok: false, url: parsed.toString(), reason: "domain not on Tier 1 allowlist" };
  }

  return { ok: true, canonicalUrl: parsed.toString(), host };
}

// ── Tool execution (canonical policy; no approval bypass) ─────────────────────

type ToolOutcome =
  | { ok: true; output: string; callId: string }
  | { ok: false; callId: string; error_code: string; reason: string };

async function executeResearchTool(
  runtime: ToolRuntime,
  cfg: JarvisConfig,
  controller: AbortController,
  sessionId: string,
  workspacePath: string,
  name: "web_search" | "web_fetch",
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const callId = `${name}-${randomUUID()}`;
  const def = runtime.listTools().find((entry) => entry.function.name === name);
  if (!def) {
    return { ok: false, callId, error_code: "unknown_tool", reason: `${name} is not registered` };
  }

  // Context is bound to the native-validated Session and workspace so the
  // existing policy sees the real scope of the run.
  const ctx: ExecutionContext = makeExecutionContext("agent", cfg, {
    interactive: false,
    session_id: sessionId,
    workspace_path: workspacePath,
    timeout_ms: PER_CALL_TIMEOUT_MS,
    signal: controller.signal,
  });

  // The tool may run only when the existing ToolRuntime permission policy
  // explicitly resolves to `allow` for this context. `ask` (approval required)
  // and `deny` both fail closed without invoking the tool. `skip_approval_gate`
  // is never set, no approval hook is wired, and no grant is invented.
  const policy = evaluatePolicy(def, ctx);
  if (policy.decision !== "allow") {
    return {
      ok: false,
      callId,
      error_code: policy.decision === "ask" ? "approval_required" : "policy_denied",
      reason: policy.reason || policy.source,
    };
  }

  const result = await runtime.execute({ id: callId, name, arguments: args }, ctx);
  if (result.is_error) {
    return {
      ok: false,
      callId,
      error_code: result.error_code ?? "handler_error",
      reason: result.error || result.output || `${name} failed`,
    };
  }
  return {
    ok: true,
    callId,
    output: typeof result.output === "string" ? result.output : String(result.output ?? ""),
  };
}

function extractCandidateUrls(searchOutput: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = JSON.parse(searchOutput) as {
      abstract_url?: unknown;
      results?: Array<{ url?: unknown }>;
      related_topics?: Array<{ url?: unknown }>;
    };
    if (typeof parsed?.abstract_url === "string") urls.push(parsed.abstract_url);
    if (Array.isArray(parsed?.results)) {
      for (const result of parsed.results) {
        if (result && typeof result.url === "string") urls.push(result.url);
      }
    }
    if (Array.isArray(parsed?.related_topics)) {
      for (const topic of parsed.related_topics) {
        if (topic && typeof topic.url === "string") urls.push(topic.url);
      }
    }
  } catch {
    // Non-JSON search output contributes no candidates.
  }
  return urls;
}

/** Split the `web_fetch` envelope into the canonical URL and the content body. */
function splitFetchedContent(output: string): { canonicalUrl: string | null; content: string } {
  const prefix = output.match(/^Content from (\S+) \(extraction prompt:[\s\S]*?\):\n\n/);
  if (prefix) {
    return { canonicalUrl: prefix[1], content: output.slice(prefix[0].length) };
  }
  return { canonicalUrl: null, content: output };
}

// ── Stored trajectory binding (exact tuple; never caller-supplied) ────────────

interface StoredTrajectoryBinding {
  agent_run_id: string;
  session_id: string;
  tool_sequence_digest: string;
}

type StoredTrajectoryResolution =
  | { ok: true; binding: StoredTrajectoryBinding }
  | { ok: false; reason: string };

/**
 * Resolve the exact persisted source trajectory for the native-validated run
 * and Session from this process's existing SelfTuningStore. Requires exactly
 * one row, strict decoding, and an exact identity/digest match. Never accepts a
 * caller-supplied snapshot and never mints a run id.
 */
function resolveStoredTrajectory(
  agentRunId: string,
  sessionId: string,
): StoredTrajectoryResolution {
  const store = new SelfTuningStore();
  const snapshot = store.getTrajectorySnapshotByRunAndSession(agentRunId, sessionId);
  if (!snapshot) {
    return {
      ok: false,
      reason: "no unique persisted trajectory snapshot exists for the selected run and Session",
    };
  }

  const decoded = decodeSkillTrajectorySnapshot(snapshot);
  if (!decoded.ok) {
    return { ok: false, reason: `persisted trajectory failed strict decode: ${decoded.code}` };
  }
  const trajectory = decoded.trajectory;
  if (trajectory.agent_run_id !== agentRunId || trajectory.session_id !== sessionId) {
    return {
      ok: false,
      reason: "persisted trajectory identity does not match the selected run and Session",
    };
  }

  // A matching run/session identity alone is insufficient: the persisted run
  // must have reached the successful terminal outcome before any ToolRuntime is
  // created or any tool is dispatched. Degraded/failed runs fail closed.
  if (trajectory.run_outcome !== "success") {
    return {
      ok: false,
      reason: `persisted trajectory run did not complete successfully (outcome: ${trajectory.run_outcome})`,
    };
  }

  if (!trajectory.tool_sequence_digest) {
    return { ok: false, reason: "persisted trajectory has no tool-sequence digest" };
  }

  // The trajectory payload persists run/session identity only; it carries no
  // Agent or workspace field, so there is nothing further to cross-check. Agent
  // and workspace authority remain native-validated and are used only as the
  // ToolRuntime context, never trusted from the caller.
  return {
    ok: true,
    binding: {
      agent_run_id: trajectory.agent_run_id,
      session_id: trajectory.session_id,
      tool_sequence_digest: trajectory.tool_sequence_digest,
    },
  };
}

// ── Research execution ────────────────────────────────────────────────────────

export async function executeLearningResearch(
  request: LearningResearchRequest,
  cfg: JarvisConfig,
  bunInstanceId: string,
): Promise<LearningResearchResponse> {
  const startedAt = new Date().toISOString();
  const requestId = typeof request?.request_id === "string" ? request.request_id : "";
  const respond = (
    outcome: LearningOutcome,
    reason: string | undefined,
    findings: LearningFinding[],
    rejected: LearningRejectedSource[],
    binding: LearningEvidenceBinding,
  ): LearningResearchResponse => ({
    request_id: requestId,
    bun_instance_id: bunInstanceId,
    // No research run id is ever minted. The only run identity is the verified
    // persisted trajectory's agent_run_id; absent a verified binding it is
    // empty and the response is unavailable.
    run_id: binding.status === "bound" ? binding.agent_run_id ?? "" : "",
    outcome,
    reason,
    findings,
    rejected_sources: rejected,
    evidence_binding: binding,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  const rejected: LearningRejectedSource[] = [];
  const findings: LearningFinding[] = [];

  const invalid = (reason: string): LearningResearchResponse =>
    respond("unavailable", reason, findings, rejected, { status: "unavailable", reason });

  if (
    !request ||
    typeof request.request_id !== "string" ||
    request.request_id.length === 0 ||
    typeof request.agent_run_id !== "string" ||
    request.agent_run_id.trim().length === 0 ||
    typeof request.session_id !== "string" ||
    request.session_id.trim().length === 0 ||
    typeof request.agent_id !== "string" ||
    request.agent_id.trim().length === 0 ||
    typeof request.project_root !== "string" ||
    request.project_root.trim().length === 0 ||
    typeof request.topic !== "string" ||
    request.topic.trim().length === 0
  ) {
    return invalid("invalid research request");
  }

  // Authority gate. Resolve the exact persisted trajectory BEFORE creating a
  // ToolRuntime or executing any tool. Absent/ambiguous/invalid evidence fails
  // closed with no dispatch.
  const resolution = resolveStoredTrajectory(request.agent_run_id, request.session_id);
  if (!resolution.ok) {
    return invalid(resolution.reason);
  }
  const bindingInfo = resolution.binding;
  const binding: LearningEvidenceBinding = {
    status: "bound",
    agent_run_id: bindingInfo.agent_run_id,
    session_id: bindingInfo.session_id,
    tool_sequence_digest: bindingInfo.tool_sequence_digest,
  };

  const subtopic = typeof request.subtopic === "string" ? request.subtopic : "";
  const requestedMax = Number(request.max_sources);
  const maxSources =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), MAX_SOURCES)
      : MAX_SOURCES;

  const runtime = createToolRuntime();
  registerWebBundle(runtime);

  const requestedTimeout = Number(request.timeout_ms);
  const wholeRunTimeout =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_RESEARCH_TIMEOUT_MS)
      : MAX_RESEARCH_TIMEOUT_MS;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort("learning_timeout"), wholeRunTimeout);

  try {
    const seeds = Array.isArray(request.seed_urls)
      ? request.seed_urls.filter((value): value is string => typeof value === "string")
      : [];

    let candidates: string[];
    if (seeds.length > 0) {
      candidates = seeds;
    } else {
      const search = await executeResearchTool(
        runtime,
        cfg,
        controller,
        request.session_id,
        request.project_root,
        "web_search",
        { query: request.topic },
      );
      if (!search.ok) {
        rejected.push({
          url: "",
          reason: `web_search ${search.error_code}: ${search.reason}`,
        });
        candidates = [];
      } else {
        candidates = extractCandidateUrls(search.output);
      }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (findings.length >= maxSources) break;
      if (controller.signal.aborted) break;

      const source = evaluateSourceUrl(candidate);
      if (!source.ok) {
        rejected.push({ url: source.url, reason: source.reason });
        continue;
      }
      if (seen.has(source.canonicalUrl)) continue;
      seen.add(source.canonicalUrl);

      const fetched = await executeResearchTool(
        runtime,
        cfg,
        controller,
        request.session_id,
        request.project_root,
        "web_fetch",
        {
          url: source.canonicalUrl,
          prompt: `${request.topic} ${subtopic}`.trim(),
        },
      );
      if (!fetched.ok) {
        rejected.push({
          url: source.canonicalUrl,
          reason: `web_fetch ${fetched.error_code}: ${fetched.reason}`,
        });
        continue;
      }

      const { canonicalUrl, content } = splitFetchedContent(fetched.output);
      const resolvedUrl = canonicalUrl ?? source.canonicalUrl;
      const resolved = evaluateSourceUrl(resolvedUrl);
      if (!resolved.ok) {
        rejected.push({ url: resolvedUrl, reason: resolved.reason });
        continue;
      }
      if (content.trim().length === 0) {
        rejected.push({ url: resolvedUrl, reason: "retrieved content was empty" });
        continue;
      }

      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      findings.push({
        subtopic,
        source_url: resolved.canonicalUrl,
        source_host: resolved.host,
        retrieved_at: new Date().toISOString(),
        content_digest: `sha256:${digest}`,
        excerpt: content.slice(0, EXCERPT_CHARS),
        reference: `${resolved.canonicalUrl}#sha256=${digest}`,
        tool_name: "web_fetch",
        tool_call_id: fetched.callId,
        run_id: bindingInfo.agent_run_id,
        trajectory_digest: bindingInfo.tool_sequence_digest,
        bun_instance_id: bunInstanceId,
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  if (findings.length === 0) {
    const reason =
      rejected.find((entry) => entry.reason.length > 0)?.reason ??
      "no source-grounded findings were retrieved";
    return respond("unavailable", reason, findings, rejected, binding);
  }
  if (controller.signal.aborted) {
    return respond(
      "partial",
      "research deadline exceeded; only grounded findings retrieved before the deadline are included",
      findings,
      rejected,
      binding,
    );
  }
  if (rejected.length > 0) {
    return respond(
      "partial",
      `${rejected.length} source(s) were rejected or unavailable`,
      findings,
      rejected,
      binding,
    );
  }
  return respond("complete", undefined, findings, rejected, binding);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Route one already-capability-authenticated `/internal/learning/*` request.
 * Returns null for unrelated paths so the caller can fall through.
 */
export async function handleLearningSessionRequest(
  req: Request,
  cfg: JarvisConfig,
  bunInstanceId: string,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path !== "/internal/learning/research") return null;
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json({ code: "invalid_request" }, 400);
  }
  if (raw.length > MAX_BODY_BYTES) return json({ code: "body_too_large" }, 413);

  let request: LearningResearchRequest;
  try {
    request = JSON.parse(raw) as LearningResearchRequest;
  } catch {
    return json({ code: "invalid_request" }, 400);
  }
  if (!request || typeof request.request_id !== "string" || request.request_id.length === 0) {
    return json({ code: "invalid_request" }, 400);
  }

  const response = await executeLearningResearch(request, cfg, bunInstanceId);
  return json(response);
}
