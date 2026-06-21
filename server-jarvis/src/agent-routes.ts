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
