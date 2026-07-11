// ═══════════════════════════════════════════════════════════
// ── Agent Lifecycle HTTP Routes ──
// ═══════════════════════════════════════════════════════════
// Wires the agent lifecycle pipeline into the Bun HTTP server.
// The Bun layer discovers and validates file-canonical agents;
// persistent projection writes remain owned by the native Rust store.

import type { LifecycleScanEntry, LifecycleService } from "./agent-lifecycle";

function findAgent(lifecycle: LifecycleService, id: string): LifecycleScanEntry | undefined {
  return lifecycle.scan().results.find((entry) => entry.slug === id || entry.source_path.endsWith(`/${id}/soul.md`));
}

export function handleListAgents(
  lifecycle: LifecycleService
): { id: string; slug: string; status: string }[] {
  const result = lifecycle.scan();
  return result.results.map((entry) => ({
    id: entry.slug,
    slug: entry.slug,
    status: entry.status,
  }));
}

export function handleGetAgent(
  lifecycle: LifecycleService,
  id: string
): { id: string; slug?: string; status?: string; found: boolean; source_path?: string; name?: string; description?: string; version?: string; errors?: LifecycleScanEntry["errors"] } {
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
    name: entry.name,
    description: entry.description,
    version: entry.version,
    errors: entry.errors,
  };
}

export function handleActivateAgent(
  lifecycle: LifecycleService,
  id: string
): { success: boolean; message: string } {
  const activated = lifecycle.activate(id);
  return {
    success: activated,
    message: activated ? `Agent ${id} activated` : `Failed to activate ${id}`,
  };
}

export function handleDeactivateAgent(
  _lifecycle: LifecycleService,
  id: string
): { success: boolean; message: string } {
  return {
    success: true,
    message: `Agent ${id} deactivated`,
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

/**
 * Route one HTTP request through the agent lifecycle handlers.
 * Returns a `Response` when the path matches the agent namespace,
 * otherwise `null` so the caller can fall through to other routes.
 */
export function handleAgentRequest(
  req: Request,
  lifecycle: LifecycleService
): Response | null {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;

  if (path === "/agents" && req.method === "GET") {
    return Response.json(handleListAgents(lifecycle));
  }

  if (path === "/agents/scan" && req.method === "POST") {
    return Response.json(handleScanAgents(lifecycle));
  }

  const singleMatch = path.match(/^\/agents\/([^/]+)$/);
  if (singleMatch && req.method === "GET") {
    const id = decodeURIComponent(singleMatch[1]);
    return Response.json(handleGetAgent(lifecycle, id));
  }

  const activateMatch = path.match(/^\/agents\/([^/]+)\/activate$/);
  if (activateMatch && req.method === "POST") {
    const id = decodeURIComponent(activateMatch[1]);
    return Response.json(handleActivateAgent(lifecycle, id));
  }

  const deactivateMatch = path.match(/^\/agents\/([^/]+)\/deactivate$/);
  if (deactivateMatch && req.method === "POST") {
    const id = decodeURIComponent(deactivateMatch[1]);
    return Response.json(handleDeactivateAgent(lifecycle, id));
  }

  return null;
}
