// ── Approval queue read-back decisions ─────────────────────────────────
// `get_approvals` returns a pending-only snapshot of the legacy system
// store's approval vector, and nothing in this repo ever writes a request
// into it: the live approval gate is the Bun server's approval registry,
// which the chat stream surfaces (and auto-denies after its own timeout).
// So one decoded snapshot can only describe one read — it never certifies
// that nothing is waiting, and a resolved decision write stays unconfirmed
// until a later read no longer lists the request.

export interface ApprovalRow {
  id: string;
  request_type: string;
  description: string;
  agent_id: string;
  created_at: string;
  status: string;
  tool_name: string | null;
  tool_args: string | null;
}

export type QueueCoverage = 'pending' | 'unavailable' | 'awaiting_decision' | 'no_requests_listed';

export type DecisionWrite = 'confirmed' | 'declined' | 'malformed';

export type ReadBack = 'absent' | 'still_listed';

export const NO_REQUESTS_LISTED = 'No approval requests in the last read.';

export const LIVE_GATE_CAVEAT =
  'This list is not the live approval gate — a tool call waiting on your decision is shown in the chat stream, not here.';

const REQUIRED_TEXT = ['request_type', 'description', 'agent_id', 'created_at', 'status'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null | undefined {
  return value === undefined || value === null || typeof value === 'string' ? (value ?? null) : undefined;
}

/** A snapshot that cannot be read strictly is unavailable, never an empty queue. */
export function decodeApprovalQueue(value: unknown): ApprovalRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ApprovalRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== 'string' || entry.id === '') return null;
    if (REQUIRED_TEXT.some((field) => typeof entry[field] !== 'string')) return null;
    const toolName = optionalText(entry.tool_name);
    const toolArgs = optionalText(entry.tool_args);
    if (toolName === undefined || toolArgs === undefined) return null;
    rows.push({
      id: entry.id,
      request_type: entry.request_type as string,
      description: entry.description as string,
      agent_id: entry.agent_id as string,
      created_at: entry.created_at as string,
      status: entry.status as string,
      tool_name: toolName,
      tool_args: toolArgs,
    });
  }
  return rows;
}

/** What one read is allowed to claim about the queue. */
export function decideQueueCoverage(input: {
  loading: boolean;
  unavailable: boolean;
  rows: number;
}): QueueCoverage {
  if (input.loading) return 'pending';
  if (input.unavailable) return 'unavailable';
  return input.rows > 0 ? 'awaiting_decision' : 'no_requests_listed';
}

/** Only an explicit `true` from the native write counts as a saved decision. */
export function classifyDecisionWrite(value: unknown): DecisionWrite {
  if (value === true) return 'confirmed';
  if (value === false) return 'declined';
  return 'malformed';
}

/** A saved decision is confirmed by a later read that no longer lists the request. */
export function classifyReadBack(rows: readonly { id: string }[], id: string): ReadBack {
  return rows.some((row) => row.id === id) ? 'still_listed' : 'absent';
}
