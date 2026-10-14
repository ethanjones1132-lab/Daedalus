/**
 * Decode the `goal_get` readback into the selector/identity fields Project
 * Steward handoff validation needs. A malformed or absent result is never
 * treated as a match.
 */
interface GoalIdentity {
  id: string;
  objective: string;
  status: string;
  agent_id: string;
  project_root: string | null;
}

export function decodeGoalIdentity(value: unknown): GoalIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const goalRaw = record.goal;
  if (typeof goalRaw !== 'object' || goalRaw === null || Array.isArray(goalRaw)) return null;
  const goal = goalRaw as Record<string, unknown>;
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string') return null;
  if (typeof goal.agent_id !== 'string') return null;
  if (goal.project_root !== null && typeof goal.project_root !== 'string') return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: typeof goal.status === 'string' ? goal.status : 'pending',
    agent_id: goal.agent_id,
    project_root: goal.project_root ?? null,
  };
}

/** Best-effort workspace-root normalization for the handoff identity match only;
 *  native revalidates the canonical root at send time. */
export function normalizeHandoffRoot(root: string | null | undefined): string | null {
  if (typeof root !== 'string') return null;
  let value = root.trim();
  if (value.length === 0) return null;
  while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Minimal canonical Session readback for handoff identity validation. The chat
 * projection omits `archived`, so this reads the canonical `list_sessions`
 * shape (which includes `archived` and the validated `project_root`).
 */
interface CanonicalSessionRow {
  id: string;
  agent_id: string;
  archived: boolean;
  project_root: string | null;
}

/**
 * Result of decoding a native collection. `ok: false` means the collection was
 * unreadable — not that it was empty — so a malformed element cannot make a
 * requested Session look like it no longer exists.
 */
type CollectionRead<T> = { ok: true; rows: T[] } | { ok: false };

export function decodeCanonicalSessionRows(value: unknown): CollectionRead<CanonicalSessionRow> {
  if (!Array.isArray(value)) return { ok: false };
  const rows: CanonicalSessionRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.agent_id !== 'string') return { ok: false };
    // Strict decode: a row without a real boolean `archived` is unreadable
    // rather than coerced to `false`, so a malformed/archived Session can never
    // be accepted as a live handoff target by default. Any malformed element
    // makes the whole read unavailable; a genuinely valid empty array stays
    // empty.
    if (typeof record.archived !== 'boolean') return { ok: false };
    let projectRoot: string | null;
    if (record.project_root === null) projectRoot = null;
    else if (typeof record.project_root === 'string') projectRoot = record.project_root;
    else return { ok: false };
    rows.push({
      id: record.id,
      agent_id: record.agent_id,
      archived: record.archived,
      project_root: projectRoot,
    });
  }
  return { ok: true, rows };
}

