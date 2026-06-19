// ═══════════════════════════════════════════════════════════════
// ── Agent Lifecycle HTTP Routes ──
// ═══════════════════════════════════════════════════════════════
// Wires the agent lifecycle pipeline into the Bun HTTP server.
//   GET    /agents              → list discovered agents
//   GET    /agents/:id          → get agent details
//   POST   /agents/:id/activate → validate + activate, creating a runtime projection
//   POST   /agents/:id/deactivate → deactivate an agent
//
// All routes require a `store` (ProjectionStore) and `agentsRoot` at construction time.

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createProjectionStore } from "./projection-store";
import type { ProjectionStore } from "./projection-store";
import { createLifecycleService } from "./agent-lifecycle";
import type { LifecycleService } from "./agent-lifecycle";

// ── Module-level state ────────────────────────────────────────────────────────

let _store: ProjectionStore | null = null;
let _lifecycle: LifecycleService | null = null;

function getStore(dbPath: string): ProjectionStore {
  if (_store) return _store;
  const db = new Database(dbPath, { create: true });
  _store = createProjectionStore(db);
  return _store;
}

function getLifecycle(dbPath: string, agentsRoot: string): LifecycleService {
  if (_lifecycle) return _lifecycle;
  const store = getStore(dbPath);
  _lifecycle = createLifecycleService(agentsRoot, store);
  return _lifecycle;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRequestId(req: Request): string | null {
  const url = new URL(req.url);
  // Expect /agents/<id>/...
  const parts = url.pathname.split("/").filter(Boolean);
  // parts: ["agents", "<id>"] or ["agents", "<id>", "activate"| "deactivate"]
  if (parts.length < 2 || parts[0] !== "agents") return null;
  return decodeURIComponent(parts[1]);
}

function jsonBody(req: Request): Promise<any> {
  return req.json().catch(() => ({}));
}

// ── Route Handlers ────────────────────────────────────────────────────────────

/**
 * GET /agents — list discovered agents.
 *
 * Query params:
 *   ?status=valid|invalid|pending  — optional filter