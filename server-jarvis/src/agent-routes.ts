import type { LifecycleScanEntry, LifecycleService } from "./agent-lifecycle";

function findAgent(lifecycle: LifecycleService, id: string): LifecycleScanEntry | undefined {
  return lifecycle.scan().results.find((entry) => entry.slug === id || entry.source_path.endsWith(`/${id}/soul.md`));
}

function publicEntry(entry: LifecycleScanEntry) {
  return {
    id: entry.slug,
    slug: entry.slug,
    status: entry.status,
    source_path: entry.source_path,
    source_hash: entry.source_hash,
    source_size_bytes: entry.source_size_bytes,
    active: entry.active === true,
    projection_version: entry.projection_version,
    activated_at: entry.activated_at,
    deactivated_at: entry.deactivated_at,
  };
}

export function handleListAgents(
  lifecycle: LifecycleService
): Array<ReturnType<typeof publicEntry>> {
  return lifecycle.scan().results.map(publicEntry);
}

export function handleGetAgent(
  lifecycle: LifecycleService,
  id: string
): {
  id: string;
  slug?: string;
  status?: string;
  found: boolean;
  source_path?: string;
  source_hash?: string;
  source_size_bytes?: number;
  active?: boolean;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
  name?: string;
  description?: string;
  version?: string;
  errors?: LifecycleScanEntry["errors"];
} {
  const entry = findAgent(lifecycle, id);
  if (!entry) {
    return { id, found: false };
  }

  return {
    id: entry.slug,
    slug: entry.slug,
    status: entry.status,
    found: true,
    source_path: entry.source_path,
    source_hash: entry.source_hash,
    source_size_bytes: entry.source_size_bytes,
    active: entry.active === true,
    projection_version: entry.projection_version,
    activated_at: entry.activated_at,
    deactivated_at: entry.deactivated_at,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    errors: entry.errors,
  };
}

export function handleActivateAgent(
  lifecycle: LifecycleService,
  id: string,
  expectedSourceHash?: string,
) {
  const result = lifecycle.activateDetailed(id, expectedSourceHash);
  return {
    success: result.ok,
    code: result.code,
    message: result.message,
    projection: result.projection,
  };
}

export function handleDeactivateAgent(
  lifecycle: LifecycleService,
  id: string,
) {
  const result = lifecycle.deactivateDetailed(id);
  return {
    success: result.ok,
    code: result.code,
    message: result.message,
    projection: result.projection,
  };
}

export function handleScanAgents(
  lifecycle: LifecycleService
): { scanned: number; valid: number; invalid: number } {
  const result = lifecycle.scan();
  return {
    scanned: result.scanned,
    valid: result.valid,
    invalid: result.invalid,
  };
}

function responseForActivation(result: ReturnType<typeof handleActivateAgent>): Response {
  const status = result.code === "agent_not_found"
    ? 404
    : ["agent_invalid", "agent_collision", "source_changed"].includes(result.code)
      ? 409
      : result.code === "store_unavailable"
        ? 503
        : result.code === "store_failed"
          ? 500
          : result.success
            ? 200
            : 409;
  return Response.json(result, { status });
}

export async function handleAgentRequest(
  req: Request,
  lifecycle: LifecycleService
): Promise<Response | null> {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;

  if (path === "/agents" && req.method === "GET") {
    return Response.json(handleListAgents(lifecycle));
  }

  if (path === "/agents/scan" && req.method === "POST") {
    return Response.json(handleScanAgents(lifecycle));
  }

  if (path === "/agents/pool") {
    return null;
  }

  const singleMatch = path.match(/^\/agents\/([^/]+)$/);
  if (singleMatch && req.method === "GET") {
    const id = decodeURIComponent(singleMatch[1]);
    return Response.json(handleGetAgent(lifecycle, id));
  }

  const activateMatch = path.match(/^\/agents\/([^/]+)\/activate$/);
  if (activateMatch && req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ success: false, code: "invalid_request", message: "activation body is required" }, { status: 400 });
    }
    const expectedSourceHash = typeof body === "object" && body !== null && "expected_source_hash" in body
      ? String((body as { expected_source_hash?: unknown }).expected_source_hash ?? "")
      : "";
    if (!/^[a-f0-9]{64}$/i.test(expectedSourceHash)) {
      return Response.json({ success: false, code: "invalid_request", message: "a current source hash is required" }, { status: 400 });
    }
    const id = decodeURIComponent(activateMatch[1]);
    return responseForActivation(handleActivateAgent(lifecycle, id, expectedSourceHash));
  }

  const deactivateMatch = path.match(/^\/agents\/([^/]+)\/deactivate$/);
  if (deactivateMatch && req.method === "POST") {
    const id = decodeURIComponent(deactivateMatch[1]);
    const result = handleDeactivateAgent(lifecycle, id);
    const status = result.code === "store_unavailable" ? 503 : result.code === "store_failed" ? 500 : result.success ? 200 : 409;
    return Response.json(result, { status });
  }

  return null;
}
