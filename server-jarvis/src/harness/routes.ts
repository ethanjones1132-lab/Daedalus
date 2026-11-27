import type { OrchestratorAgent } from "../orchestration/agent-pool";
import { renderHarnessGuides } from "../orchestration/harness-guides";
import { getHarnessCommand } from "./commands";
import { runHarness, type HarnessAdmission, type HarnessControllerInput, type HarnessRunResult } from "./controller";
import { harnessPreCreateRefusal } from "./engine";
import { withHarnessMakerEvents } from "./inkling-maker";
import { validateManifest, type HarnessManifest } from "./manifest";
import { HarnessStore } from "./store";
import { HARNESS_TEMPLATES, instantiateHarnessTemplate } from "./templates";

/** Injected execution boundaries for a run. The loop itself stays in `runHarness`. */
export interface HarnessExecution {
  sensors: HarnessControllerInput["sensors"];
  runMaker: HarnessControllerInput["runMaker"];
  localMakerModel?: HarnessControllerInput["localMakerModel"];
  runChecker: HarnessControllerInput["runChecker"];
  onControl?: HarnessControllerInput["onControl"];
  admission: HarnessAdmission;
  /**
   * The agent pool the run's models actually come from, carried so the
   * controller's maker/checker family check sees the live config rather than
   * the shipped defaults. Absent means the caller has no pool to supply.
   */
  agents?: readonly OrchestratorAgent[];
}

export interface HarnessRouteOptions {
  store?: HarnessStore;
  /** Return an app-known canonical project root, or null for an unknown root. */
  resolveKnownProjectRoot?: (root: string) => string | null;
  /** Required to start a run; absent means this server cannot execute a harness yet. */
  execution?: HarnessExecution;
}

interface ActiveHarnessRun {
  controller: AbortController;
  done: Promise<HarnessRunResult>;
}

/** Ids of started-but-unsettled runs, so cancel can address them while the loop runs. */
const activeRuns = new Map<string, ActiveHarnessRun>();

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

function projectRootFrom(url: URL, body?: Record<string, unknown>): unknown {
  return body?.project_root ?? url.searchParams.get("project_root") ?? body?.root ?? url.searchParams.get("root");
}

/** Harness HTTP routes. All filesystem authority is supplied by app-known roots. */
export async function handleHarnessRequest(req: Request, options: HarnessRouteOptions = {}): Promise<Response | null> {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;
  const store = options.store ?? new HarnessStore();
  const resolveRoot = options.resolveKnownProjectRoot ?? (() => null);
  if (!path.startsWith("/harness/")) return null;

  if (path === "/harness/templates" && req.method === "GET") {
    return Response.json({ templates: HARNESS_TEMPLATES });
  }

  if (path === "/harness/projects/resolve" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.root !== "string") return jsonError("root must be a string", 400);
    const canonical = resolveRoot(body.root);
    return canonical ? Response.json({ project_root: canonical }) : jsonError("unknown_project_root", 404);
  }

  if (path === "/harness/manifests" && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    return root ? Response.json({ manifests: store.listManifests(root) }) : jsonError("unknown_project_root", 404);
  }

  if (path === "/harness/manifests" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const candidate = body?.manifest;
    const checked = validateManifest(candidate);
    if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
    const root = resolveRoot(checked.manifest.project_root);
    if (!root) return jsonError("unknown_project_root", 404);
    if (root !== checked.manifest.project_root) return jsonError("project_root must be canonical", 400);
    const revision = body?.expected_revision;
    if (revision !== 0) return jsonError("expected_revision must be 0 for create", 400);
    try { return Response.json(store.saveManifest(checked.manifest, 0), { status: 201 }); }
    catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
  }

  const manifestMatch = path.match(/^\/harness\/manifests\/([^/]+)$/);
  if (manifestMatch) {
    let id: string;
    try { id = decodeURIComponent(manifestMatch[1]); } catch { return jsonError("invalid manifest id", 400); }
    if (req.method === "GET") {
      const inputRoot = url.searchParams.get("project_root");
      if (!inputRoot) return jsonError("project_root is required", 400);
      const root = resolveRoot(inputRoot);
      if (!root) return jsonError("unknown_project_root", 404);
      const saved = store.getManifest(root, id);
      return saved ? Response.json(saved) : jsonError("manifest_not_found", 404);
    }
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const checked = validateManifest(body?.manifest);
      if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
      if (checked.manifest.id !== id) return jsonError("manifest id cannot change", 400);
      const root = resolveRoot(checked.manifest.project_root);
      if (!root) return jsonError("unknown_project_root", 404);
      if (root !== checked.manifest.project_root) return jsonError("project_root must be canonical", 400);
      const revision = body?.expected_revision;
      if (!Number.isInteger(revision) || (revision as number) < 1) return jsonError("expected_revision must be a positive integer", 400);
      try { return Response.json(store.saveManifest(checked.manifest, revision as number)); }
      catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
    }
  }

  if (path === "/harness/manifests/from-template" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.template_id !== "string" || typeof body.project_root !== "string") return jsonError("template_id and project_root are required", 400);
    const root = resolveRoot(body.project_root);
    if (!root) return jsonError("unknown_project_root", 404);
    const manifest = instantiateHarnessTemplate(body.template_id, root);
    if (!manifest) return jsonError("template_not_found", 404);
    const revision = body.expected_revision;
    if (revision !== 0) return jsonError("expected_revision must be 0 for create", 400);
    try { return Response.json(store.saveManifest(manifest, 0), { status: 201 }); }
    catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
  }

  // The only writer of an approval row. The client names the manifest it saw;
  // the hash it sends must equal the stored manifest's hash, so an approval can
  // never be bound to a hash the server did not compute itself.
  if (path === "/harness/approvals" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.project_root !== "string" || typeof body.manifest_id !== "string" ||
        typeof body.manifest_hash !== "string" || typeof body.command_id !== "string") {
      return jsonError("project_root, manifest_id, manifest_hash, and command_id are required", 400);
    }
    const root = resolveRoot(body.project_root);
    if (!root) return jsonError("unknown_project_root", 404);
    const saved = store.getManifest(root, body.manifest_id);
    if (!saved) return jsonError("manifest_not_found", 404);
    if (!getHarnessCommand(body.command_id)) return jsonError("unknown_command", 400);
    if (saved.manifest_hash !== body.manifest_hash) return jsonError("manifest_hash_mismatch", 400);
    const decision = body.decision;
    if (decision !== "approved" && decision !== "denied") return jsonError("decision must be approved or denied", 400);
    const approval = store.recordApproval({ command_id: body.command_id, project_root: root,
      manifest_hash: saved.manifest_hash, decision });
    return Response.json({ approval: { id: approval.id, command_id: approval.command_id, project_root: approval.project_root,
      manifest_hash: approval.manifest_hash, decision: approval.decision, decided_at: approval.decided_at } }, { status: 201 });
  }

  if (path === "/harness/guides/preview" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const rootValue = projectRootFrom(url, body ?? undefined);
    if (typeof rootValue !== "string") return jsonError("project_root is required", 400);
    const root = resolveRoot(rootValue);
    if (!root) return jsonError("unknown_project_root", 404);
    let manifest: HarnessManifest | undefined;
    if (typeof body?.manifest_id === "string") manifest = store.getManifest(root, body.manifest_id)?.manifest;
    else {
      const checked = validateManifest(body?.manifest);
      if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
      if (checked.manifest.project_root !== root) return jsonError("project_root mismatch", 400);
      manifest = checked.manifest;
    }
    if (!manifest) return jsonError("manifest_not_found", 404);
    const values = body?.brief_values;
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string"))) return jsonError("brief_values must be a string map", 400);
    try {
      const rendered = renderHarnessGuides({ rules: manifest.guides.rules.join("\n"), briefTemplate: manifest.guides.brief_template,
        briefValues: (values ?? {}) as Record<string, string>, skills: manifest.guides.skills, references: manifest.guides.references,
        bannedDefaults: manifest.guides.banned_defaults, role: body?.role === "checker" ? "checker" : "maker",
        rubric: manifest.checker.rubric });
      return Response.json({ guides_rendered: true, ...rendered });
    } catch (error) { return jsonError(String(error), 400); }
  }

  if (path === "/harness/runs" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const rootValue = projectRootFrom(url, body ?? undefined);
    if (typeof rootValue !== "string") return jsonError("project_root is required", 400);
    const root = resolveRoot(rootValue);
    if (!root) return jsonError("unknown_project_root", 404);
    let candidate: HarnessManifest | undefined;
    if (typeof body?.manifest_id === "string") {
      candidate = store.getManifest(root, body.manifest_id)?.manifest;
    } else if (body?.manifest !== undefined) {
      const checked = validateManifest(body.manifest);
      if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
      if (checked.manifest.project_root !== root) return jsonError("project_root mismatch", 400);
      candidate = checked.manifest;
    } else return jsonError("manifest_id or manifest is required", 400);
    if (!candidate) return jsonError("manifest_not_found", 404);
    const values = body?.brief_values;
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string"))) return jsonError("brief_values must be a string map", 400);
    const briefValues = (values ?? {}) as Record<string, string>;
    const deadline = body?.deadline_ms;
    if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)) {
      return jsonError("deadline_ms must be a positive finite number", 400);
    }
    const execution = options.execution;
    if (!execution) return jsonError("harness_execution_unavailable", 503);
    // A run whose brief cannot be filled must not be admitted. Render the brief
    // before the run record exists so the refusal can name the missing
    // placeholder and no 202 is sent for a run that cannot render its brief.
    try {
      renderHarnessGuides({ rules: candidate.guides.rules.join("\n"), briefTemplate: candidate.guides.brief_template,
        briefValues, skills: candidate.guides.skills, references: candidate.guides.references,
        bannedDefaults: candidate.guides.banned_defaults, role: "maker", rubric: candidate.checker.rubric });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 400);
    }
    const controller = new AbortController();
    // The engine refuses some starts before it creates a run record (invalid
    // manifest, dependent maker/checker). Ask it here so those refusals answer
    // 400 with their reason instead of a 202 naming a run that never exists.
    try {
      const refusal = harnessPreCreateRefusal({
        manifest: candidate,
        ...(execution.agents ? { agents: execution.agents } : {}),
        ...(execution.localMakerModel ? { localMakerModel: execution.localMakerModel } : {}),
        signal: controller.signal,
      });
      if (refusal) return jsonError(refusal, 400);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 400);
    }
    const runId = crypto.randomUUID();
    // runHarness creates the run before its first await, so the id is durable by
    // the time this response is written and the existing GET routes can read it.
    const controllerInput: HarnessControllerInput = {
      manifest: candidate, store, run_id: runId, signal: controller.signal, briefValues,
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    };
    if (execution.agents) controllerInput.agents = execution.agents;
    if (execution.localMakerModel) controllerInput.localMakerModel = execution.localMakerModel;
    if (execution.onControl) controllerInput.onControl = execution.onControl;
    if (typeof deadline === "number") controllerInput.deadline_ms = deadline;
    const done = withHarnessMakerEvents(store, runId, () => runHarness(controllerInput))
      .finally(() => { activeRuns.delete(runId); });
    activeRuns.set(runId, { controller, done });
    // A round-body failure settles the run as `run_failed` and writes its own
    // stop event inside the controller. Only failures before that evidence can
    // exist (invalid manifest, unreadable store) still reject here; log them so
    // they are visible rather than surfacing as an unhandled rejection.
    done.catch((error) => { console.error(`[Harness] run ${runId} could not settle:`, error); });
    return Response.json({ run_id: runId }, { status: 202 });
  }

  const cancelMatch = path.match(/^\/harness\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const rootValue = projectRootFrom(url, body ?? undefined);
    if (typeof rootValue !== "string") return jsonError("project_root is required", 400);
    const root = resolveRoot(rootValue);
    if (!root) return jsonError("unknown_project_root", 404);
    let id: string;
    try { id = decodeURIComponent(cancelMatch[1]); } catch { return jsonError("invalid run id", 400); }
    const run = store.getRun(id);
    if (!run || run.project_root !== root) return jsonError("run_not_found", 404);
    const active = activeRuns.get(id);
    if (!active) return jsonError("run_not_running", 409);
    // Drop the entry before awaiting so a second cancel is refused, not queued.
    activeRuns.delete(id);
    active.controller.abort();
    const settled = await active.done.catch(() => undefined);
    if (!settled) return jsonError("run_settlement_failed", 500, { run_id: id });
    return Response.json({ run_id: id, stop_reason: settled.stop_reason, ...(settled.abandoned ? { abandoned: true } : {}) });
  }

  if (path === "/harness/runs" && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    return root ? Response.json({ runs: store.listRuns(root) }) : jsonError("unknown_project_root", 404);
  }
  const runMatch = path.match(/^\/harness\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    if (!root) return jsonError("unknown_project_root", 404);
    let id: string;
    try { id = decodeURIComponent(runMatch[1]); } catch { return jsonError("invalid run id", 400); }
    const run = store.getRun(id);
    return run?.project_root === root ? Response.json({ run }) : jsonError("run_not_found", 404);
  }
  return jsonError("not_found", 404);
}
