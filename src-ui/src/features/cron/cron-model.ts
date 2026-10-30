import { Brain, Microscope, Zap, type LucideIcon } from 'lucide-react';
import type { CronOperation } from '../../domain/cron-operation-state';
import type { Tone } from '../../design';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionEvidence {
  run_id: string;
  status: string;
  acceptance_result?: string;
  error_code?: string;
  started_at?: string;
  finished_at?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  agent_id: string;
  session_id: string | null;
  prompt: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronJobDraft {
  name: string;
  schedule: string;
  prompt: string;
  agentId: string;
}

export type CronOperationMap = Record<string, CronOperation<CronJob>>;

export type MissedOperationKind = 'trigger' | 'dismiss' | 'dismiss-all';
export type MissedOperationPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed';

export interface MissedOperation {
  kind: MissedOperationKind;
  ids: string[];
  phase: MissedOperationPhase;
  after: number;
  failedIds?: string[];
}

export interface CronSnapshot {
  jobs: CronJob[];
  inFlightIds: string[];
  pendingMissed: CronJob[];
  requestId: number;
}

export interface CronReadResult {
  status: 'success' | 'failure' | 'stale';
  snapshot?: CronSnapshot;
}

export interface CronRun {
  id: string;
  cron_id: string;
  status: string;
  output: string;
  error: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  execution_evidence?: ExecutionEvidence;
}

// ── Job Types ────────────────────────────────────────────────────────────────

export type CronJobType = 'learning' | 'review' | 'custom';

export interface JobTypeConfig {
  id: CronJobType;
  label: string;
  description: string;
  icon: LucideIcon;
  defaultPrompt: string;
  schedulePresets: Array<{ label: string; expr: string }>;
}

export const JOB_TYPES: JobTypeConfig[] = [
  {
    id: 'learning',
    label: 'Learning Session',
    description: 'Research local AI topics, evaluate sources, write findings to memory',
    icon: Microscope,
    defaultPrompt: `You are Jarvis conducting an autonomous Learning Session on local agentic AI architecture.

## Your Task
1. Research today's assigned subtopics using web_search (2-3 queries per subtopic)
2. Fetch the most credible sources using web_fetch
3. Tier 1 sources ONLY: arXiv, ACL Anthology, NeurIPS, ICML, ICLR, Anthropic/DeepMind/HuggingFace engineering blogs, PyTorch blog, vllm.ai, llama.cpp docs
4. For each subtopic, produce ONE structured finding

## Output Format per finding
Write to: ~/.openclaw/jarvis/memory/reference/learnings/YYYY-MM-DD-<short-title>.md

---
type: reference
topic: <subtopic_id>
date: <YYYY-MM-DD>
credibility_gate: passed
---

## Finding: <Concise title>
**Source:** <URL>
**Why credible:** <One sentence>
**Summary:** <3-5 sentences, include specific numbers/metrics>
**Relevance to local agentic AI:** <Concrete application to consumer GPU agents>
**Actionable:** <yes/no>
**Action detail:** <If yes: what could be implemented>

After writing all findings, append index entries to MEMORY.md:
- [<Title>](reference/learnings/<filename>.md) — <One-line hook>`,
    schedulePresets: [
      { label: 'Daily 3am', expr: '0 3 * * *' },
      { label: 'Every 2 days', expr: '0 3 */2 * *' },
      { label: 'Weekly (Mon)', expr: '0 3 * * 1' },
    ],
  },
  {
    id: 'review',
    label: 'Conversation Review',
    description: 'Analyze recent conversations, extract memories and skill updates',
    icon: Brain,
    defaultPrompt: `You are Jarvis performing a self-improvement review of recent conversations.

## Your Task
Analyze the conversation history and extract DURABLE, ACTIONABLE insights.

## Focus Areas
- **Memories:** User preferences, corrections, project facts, project constraints
- **Skill Updates:** Frustration patterns ("stop doing X"), workflow corrections, reusable rules

## Output
Return ONLY valid JSON (no markdown, no explanation):

{
  "memories": [
    {
      "title": "Short descriptive title",
      "content": "Specific, actionable fact or preference",
      "category": "user|feedback|project|reference",
      "importance": "high|medium|low"
    }
  ],
  "skill_updates": [
    {
      "area": "Specific skill area",
      "change": "One-line improvement rule",
      "priority": "critical|high|medium|low"
    }
  ]
}

Be conservative. Only include genuinely durable insights. If nothing warrants saving, return empty arrays.`,
    schedulePresets: [
      { label: 'Every 12 hours', expr: '0 */12 * * *' },
      { label: 'Daily midnight', expr: '0 0 * * *' },
      { label: 'Every 6 hours', expr: '0 */6 * * *' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Fully custom prompt and schedule',
    icon: Zap,
    defaultPrompt: '',
    schedulePresets: [
      { label: 'Every hour', expr: '0 * * * *' },
      { label: 'Every 6 hours', expr: '0 */6 * * *' },
      { label: 'Daily 9am', expr: '0 9 * * *' },
      { label: 'Daily midnight', expr: '0 0 * * *' },
      { label: 'Weekly (Mon 8am)', expr: '0 8 * * 1' },
      { label: 'Weekdays 9am', expr: '0 9 * * 1-5' },
      { label: 'Custom', expr: '' },
    ],
  },
];

// Detect job type from prompt content
export function detectJobType(job: CronJob): CronJobType {
  if (job.prompt.includes('autonomous Learning Session') || job.prompt.includes('credibility_gate')) return 'learning';
  if (job.prompt.includes('self-improvement review') || job.prompt.includes('durable learnable insights')) return 'review';
  return 'custom';
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "never", "in 2h 5m", "3d 4h ago" — future and past relative to `now`. */
export function formatWhen(dateStr: string | null, now: number = Date.now()): string {
  if (!dateStr) return 'never';
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const ms = now - t;
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const body = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m` : `${s}s`;
  return ms < 0 ? `in ${body}` : `${body} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'success':
    case 'passed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'timeout':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Timeline projection (shared by every next-runs surface) ──────────────────

/** The next-runs ruler covers exactly this much future. */
export const CRON_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one timeline state a cron job occupies. Every read of the jobs plus the
 * pending-missed list maps each job to exactly one of these; a pending missed
 * occurrence outranks everything else for its job.
 */
export type CronTimelineState =
  /** Next run inside the ruler window; this is what gets a marker. */
  | 'scheduled'
  /** A past-due occurrence awaits trigger or dismissal; nothing can be scheduled yet. */
  | 'missed-blocked'
  /** Next run exists but lies beyond the ruler window. */
  | 'beyond-window'
  /** Disabled by the operator. */
  | 'paused'
  /** Enabled but no computable next run. */
  | 'unscheduled';

export interface CronTimelineProjection {
  /** Exactly one entry per job, keyed off the jobs list plus the pending set. */
  states: Array<{ job: CronJob; state: CronTimelineState }>;
  /** Jobs that own a place on the ruler, soonest first. */
  scheduled: Array<{ job: CronJob; at: number }>;
  /** Enabled jobs blocked on a pending missed occurrence. */
  missedBlocked: CronJob[];
}

/**
 * Map the read of all cron jobs and the pending-missed list onto the one state
 * per job (see `CronTimelineState`). An enabled job with a past-due `next_run`
 * that the pending-missed registry does not name is still owed a run — the
 * registry read may have lagged the tick — so it too counts as blocked, never
 * as silently invisible.
 */
export function projectCronTimeline(
  jobs: CronJob[],
  pendingMissed: CronJob[],
  now: number,
  windowMs = CRON_WINDOW_MS,
): CronTimelineProjection {
  const projection: CronTimelineProjection = { states: [], scheduled: [], missedBlocked: [] };
  const seen = new Set<string>();

  // The pending-missed list first: it outranks any other signal for its jobs.
  for (const job of pendingMissed) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    projection.missedBlocked.push(job);
    projection.states.push({ job, state: 'missed-blocked' });
  }

  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    if (!job.enabled) {
      projection.states.push({ job, state: 'paused' });
      continue;
    }
    if (!job.next_run) {
      projection.states.push({ job, state: 'unscheduled' });
      continue;
    }
    const at = new Date(job.next_run).getTime();
    if (Number.isNaN(at)) {
      projection.states.push({ job, state: 'unscheduled' });
      continue;
    }
    if (at <= now) {
      projection.missedBlocked.push(job);
      projection.states.push({ job, state: 'missed-blocked' });
      continue;
    }
    if (at <= now + windowMs) {
      projection.states.push({ job, state: 'scheduled' });
      projection.scheduled.push({ job, at });
      continue;
    }
    projection.states.push({ job, state: 'beyond-window' });
  }

  projection.scheduled.sort((a, b) => a.at - b.at);
  return projection;
}

// ── Operation copy (pinned by tests — do not reword) ─────────────────────────

function cronOperationVerb(operation: CronOperation<CronJob>): string {
  if (operation.kind === 'delete') return 'delete';
  if (operation.kind === 'run') return 'run';
  return operation.targetEnabled ? 'enable' : 'disable';
}

export function cronOperationStatusText(operation: CronOperation<CronJob>): string {
  if (operation.phase === 'reconciling') return `Cron job ${cronOperationVerb(operation)} was saved. Confirming the updated job list…`;
  if (operation.phase === 'read-failed') return 'Confirming the updated cron job list…';
  const action = operation.kind === 'delete'
    ? 'Deleting'
    : operation.kind === 'run'
      ? 'Running'
      : operation.targetEnabled ? 'Enabling' : 'Disabling';
  return `${action} cron job…`;
}

export function cronOperationFailureText(operation: CronOperation<CronJob>): string {
  return `Could not ${cronOperationVerb(operation)} cron job. The previous job state was kept.`;
}

export function cronOperationReadFailureText(operation: CronOperation<CronJob>): string {
  return `The cron job ${cronOperationVerb(operation)} was saved, but the confirmed job list could not be reconciled. Showing the previous job; it may be stale.`;
}

export function cronOperationSuccessText(operation: CronOperation<CronJob>): string {
  if (operation.kind === 'delete') return `Cron job "${operation.row.name}" deleted.`;
  if (operation.kind === 'run') return `Run requested for cron job "${operation.row.name}".`;
  return `Cron job "${operation.row.name}" ${operation.targetEnabled ? 'enabled' : 'disabled'}.`;
}

/**
 * What `run_cron_job` / `trigger_missed_cron_job` actually did. `already_claimed`
 * means no new run was recorded — the occurrence was already held — and must
 * not be rendered as a failure. The legacy boolean shapes are accepted so an
 * older native build still decodes: `true` was "a run was recorded", `false`
 * was "nothing new ran".
 */
export type CronRunOutcome = 'ran' | 'already_claimed' | 'cancelled';

export function decodeCronRunOutcome(value: unknown): CronRunOutcome | null {
  if (value === true) return 'ran';
  if (value === false) return 'already_claimed';
  if (value === 'ran' || value === 'already_claimed' || value === 'cancelled') return value;
  return null;
}

export function missedOperationStatusText(operation: MissedOperation): string {
  if (operation.phase === 'reconciling') return 'Missed cron action was saved. Confirming the pending list…';
  if (operation.phase === 'read-failed') return 'Confirming the pending missed cron list…';
  return operation.kind === 'dismiss-all'
    ? 'Dismissing all missed cron jobs…'
    : `${operation.kind === 'trigger' ? 'Triggering' : 'Dismissing'} missed cron job…`;
}

export function missedOperationFailureText(operation: MissedOperation): string {
  if (operation.kind === 'dismiss-all') {
    return operation.failedIds && operation.failedIds.length < operation.ids.length
      ? 'Some missed cron jobs could not be dismissed. The remaining dismissals can be retried.'
      : 'Could not dismiss all missed cron jobs. The pending list was kept.';
  }
  return `Could not ${operation.kind === 'trigger' ? 'trigger' : 'dismiss'} the missed cron job. The pending action was kept.`;
}

export function missedOperationReadFailureText(): string {
  return 'The missed cron action was saved, but the pending list could not be reconciled. Showing the previous pending list; it may be stale.';
}
