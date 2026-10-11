/*
 * Fixtures for the Actions, Commitments and Approvals pages (slice S5b).
 * State is held in memory so approve / waive / sync / complete / delete / decide
 * behave like the real store for the lifetime of the page.
 */
import { defineCommands } from '../registry';

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const ahead = (ms: number) => new Date(now + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Action registry ──────────────────────────────────────────────────────────

interface FxAction {
  id: string;
  project: string;
  source_system: string;
  source_area: string;
  priority: string;
  risk_level: string;
  category: string;
  action_type: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  approval_required: boolean;
  approval_status?: string;
  next_due?: string;
  escalated?: boolean;
  escalation_note?: string;
  updated_at: string;
}

const registry: FxAction[] = [
  {
    id: 'act-001', project: 'home-base', source_system: 'github', source_area: 'ci/main',
    priority: 'P0', risk_level: 'high', category: 'build', action_type: 'fix',
    title: 'Restore green build on main',
    description: 'The Tauri bundle step has failed for three consecutive pushes after the llama.cpp backend merge. Bisect the lockfile change and restore the pinned toolchain.',
    status: 'in_progress', owner: 'forge', approval_required: false,
    next_due: '2026-10-12', escalated: true,
    escalation_note: 'Escalated after 3 failed runs; release branch is frozen until this clears.',
    updated_at: ago(38 * MIN),
  },
  {
    id: 'act-002', project: 'home-base', source_system: 'github', source_area: 'pull-requests',
    priority: 'P1', risk_level: 'medium', category: 'review', action_type: 'review',
    title: 'Review profile provisioning UI PR',
    description: 'Provisioning flow for new Agent profiles adds a Tauri command and a React form. Needs a pass on the activation boundary before merge.',
    status: 'open', owner: 'jarvis', approval_required: false,
    next_due: '2026-10-14', updated_at: ago(5 * HOUR),
  },
  {
    id: 'act-003', project: 'atlas', source_system: 'calendar', source_area: 'planning',
    priority: 'P1', risk_level: 'low', category: 'planning', action_type: 'schedule',
    title: 'Book design review for the Actions board',
    description: 'Find a 45 minute slot this week with the two reviewers and attach the design spec.',
    status: 'open', owner: 'jarvis', approval_required: true, approval_status: 'pending',
    next_due: '2026-10-13', updated_at: ago(2 * DAY + 3 * HOUR),
  },
  {
    id: 'act-004', project: 'atlas', source_system: 'email', source_area: 'inbox',
    priority: 'P2', risk_level: 'medium', category: 'comms', action_type: 'send',
    title: 'Send vendor the revised data-processing addendum',
    description: 'Outbound email with an attachment to an external party. Held until the addendum text has been approved.',
    status: 'open', owner: 'courier', approval_required: true, approval_status: 'pending',
    updated_at: ago(26 * HOUR),
  },
  {
    id: 'act-005', project: 'home-base', source_system: 'cron', source_area: 'nightly',
    priority: 'P2', risk_level: 'low', category: 'ops', action_type: 'rotate',
    title: 'Rotate session transcripts older than 30 days',
    description: 'Archive transcripts past retention into the cold store and prune the Session index.',
    status: 'open', owner: 'archivist', approval_required: true, approval_status: 'approved',
    updated_at: ago(3 * DAY),
  },
  {
    id: 'act-006', project: 'foundry', source_system: 'linear', source_area: 'FND-212',
    priority: 'P2', risk_level: 'low', category: 'docs', action_type: 'write',
    title: 'Draft ADR for the Tool runtime permission model',
    description: 'Capture the decision to scope grants per Session and keep denials auditable.',
    status: 'in_progress', owner: 'scribe', approval_required: true, approval_status: 'waived',
    next_due: '2026-10-18', updated_at: ago(9 * HOUR),
  },
  {
    id: 'act-007', project: 'foundry', source_system: 'github', source_area: 'security',
    priority: 'P1', risk_level: 'critical', category: 'security', action_type: 'patch',
    title: 'Upgrade transitive dependency flagged by advisory',
    description: 'A transitive crate used by the Bun server bridge has a published advisory. Patch version is available.',
    status: 'blocked', owner: 'forge', approval_required: false, escalated: true,
    escalation_note: 'Blocked on upstream release notes; waiting for maintainers to confirm the fix.',
    updated_at: ago(4 * DAY),
  },
  {
    id: 'act-008', project: 'atlas', source_system: 'drive', source_area: 'shared/finance',
    priority: 'P2', risk_level: 'high', category: 'access', action_type: 'share',
    title: 'Share Q3 board pack with the audit contact',
    description: 'External sharing of a restricted folder. Blocked until the data owner confirms scope.',
    status: 'blocked', owner: 'courier', approval_required: true, approval_status: 'pending',
    updated_at: ago(6 * DAY),
  },
  {
    id: 'act-009', project: 'home-base', source_system: 'cron', source_area: 'weekly',
    priority: 'P2', risk_level: 'low', category: 'ops', action_type: 'report',
    title: 'Compile the weekly Agent activity digest',
    description: 'Blocked while the memory tier stats endpoint is unreachable.',
    status: 'blocked', owner: 'scribe', approval_required: false,
    updated_at: ago(30 * HOUR),
  },
];

let alerts = [
  {
    id: 'escalated-act-001', kind: 'escalation', severity: 'high',
    title: 'Escalated action: Restore green build on main',
    message: 'P0 action has been in progress for more than 24 hours and was escalated.',
    action_id: 'act-001', count: null, created_at: ago(2 * HOUR),
  },
  {
    id: 'escalated-act-007', kind: 'escalation', severity: 'high',
    title: 'Escalated action: Upgrade transitive dependency flagged by advisory',
    message: 'Critical-risk action is blocked and has not changed for 4 days.',
    action_id: 'act-007', count: null, created_at: ago(DAY),
  },
  {
    id: 'approval-summary-now', kind: 'approval_summary', severity: 'medium',
    title: 'Actions awaiting approval',
    message: 'Actions require approval before they can be dispatched.',
    action_id: null, count: 3, created_at: ago(20 * MIN),
  },
  {
    id: 'stale-adapter-linear', kind: 'adapter_stale', severity: 'low',
    title: 'Linear adapter has not synced recently',
    message: 'The last successful sync from Linear was over 12 hours ago.',
    action_id: null, count: null, created_at: ago(13 * HOUR),
  },
];

const isPending = (a: FxAction) =>
  a.approval_required && a.approval_status !== 'approved' && a.approval_status !== 'waived';

const bucketOf = (bucket: string) =>
  registry.filter((a) => (bucket === 'blocked' ? a.status === 'blocked' : a.status !== 'blocked' && a.status !== 'done'));

const DONE_COUNT = 27;

// ── Commitments ──────────────────────────────────────────────────────────────

interface FxCommitment {
  id: string;
  text: string;
  status: string;
  due: string | null;
  created_at: string;
  completed_at: string | null;
  agent_id: string | null;
}

let commitmentSeq = 100;
const commitments: FxCommitment[] = [
  { id: 'c-01', text: 'Send Priya the Q4 roadmap draft before the Thursday sync', status: 'open', due: ahead(2 * DAY), created_at: ago(3 * DAY), completed_at: null, agent_id: 'jarvis' },
  { id: 'c-02', text: 'Follow up with the landlord about the lease renewal terms', status: 'open', due: ago(DAY), created_at: ago(8 * DAY), completed_at: null, agent_id: 'jarvis' },
  { id: 'c-03', text: 'Review and merge the profile provisioning PR', status: 'open', due: ahead(4 * DAY), created_at: ago(DAY), completed_at: null, agent_id: 'forge' },
  { id: 'c-04', text: 'Draft the migration plan for the Bun server worker pool', status: 'open', due: null, created_at: ago(5 * DAY), completed_at: null, agent_id: 'scribe' },
  { id: 'c-05', text: 'Book flights for the November offsite once dates are confirmed', status: 'open', due: ahead(9 * DAY), created_at: ago(2 * DAY), completed_at: null, agent_id: 'courier' },
  { id: 'c-06', text: 'Back up the Agent directory before upgrading soul.md templates', status: 'completed', due: ago(4 * DAY), created_at: ago(9 * DAY), completed_at: ago(5 * DAY), agent_id: 'archivist' },
  { id: 'c-07', text: 'Reply to the conference organisers about the speaking slot', status: 'completed', due: ago(2 * DAY), created_at: ago(6 * DAY), completed_at: ago(3 * DAY), agent_id: 'jarvis' },
];

// ── Approvals (legacy store) ─────────────────────────────────────────────────

interface FxApproval {
  id: string;
  request_type: string;
  description: string;
  agent_id: string;
  created_at: string;
  status: string;
  tool_name: string | null;
  tool_args: string | null;
}

const approvals: FxApproval[] = [
  {
    id: 'ap-01', request_type: 'tool', agent_id: 'forge', status: 'pending', created_at: ago(14 * MIN),
    description: 'Run a shell command that deletes the build cache outside the workspace grant.',
    tool_name: 'shell.exec', tool_args: JSON.stringify({ command: 'rm -rf ~/.cache/home-base/target', cwd: '/home/user' }, null, 2),
  },
  {
    id: 'ap-02', request_type: 'network', agent_id: 'courier', status: 'pending', created_at: ago(2 * HOUR),
    description: 'Send an HTTP POST with the weekly digest to an external webhook not on the allow-list.',
    tool_name: 'http.request', tool_args: JSON.stringify({ method: 'POST', url: 'https://hooks.example.net/digest', bytes: 18422 }, null, 2),
  },
  {
    id: 'ap-03', request_type: 'file', agent_id: 'archivist', status: 'pending', created_at: ago(DAY + 2 * HOUR),
    description: 'Write the rotated transcript archive into a directory outside the current Session scope.',
    tool_name: 'fs.write', tool_args: null,
  },
];

// ── Commands ─────────────────────────────────────────────────────────────────

defineCommands({
  get_action_registry_summary: () => ({
    active: bucketOf('active').length,
    blocked: bucketOf('blocked').length,
    done: DONE_COUNT,
    pending_approvals: registry.filter(isPending).length,
    escalated: registry.filter((a) => a.escalated).length,
    alerts: alerts.length,
  }),
  get_action_registry_bucket: ({ bucket }) => ({ bucket, actions: bucketOf(String(bucket)) }),
  get_action_registry_alerts: () => alerts,
  sync_action_registry: () => {
    const touched = registry.filter((a) => a.source_system === 'github');
    touched.forEach((a) => { a.updated_at = new Date().toISOString(); });
    alerts = alerts.filter((a) => a.kind !== 'adapter_stale');
    return { synced: true, adapters: ['github', 'calendar', 'email', 'cron', 'linear', 'drive'], updated: touched.length };
  },
  update_action_approval: ({ actionId, status }) => {
    const action = registry.find((a) => a.id === actionId);
    if (!action) return false;
    action.approval_status = String(status);
    action.updated_at = new Date().toISOString();
    return true;
  },
  // The real command reports "unavailable" until a verification manifest is configured.
  dispatch_action: () => ({ status: 'unavailable', code: 'verification_manifest_missing' }),

  get_commitments: () => commitments.map((c) => ({ ...c })),
  add_commitment: ({ text, due }) => {
    const created: FxCommitment = {
      id: `c-${++commitmentSeq}`,
      text: String(text),
      status: 'open',
      due: (due as string | null) ?? null,
      created_at: new Date().toISOString(),
      completed_at: null,
      agent_id: 'jarvis',
    };
    commitments.unshift(created);
    return created;
  },
  complete_commitment: ({ id }) => {
    const row = commitments.find((c) => c.id === id);
    if (!row) return false;
    row.status = 'completed';
    row.completed_at = new Date().toISOString();
    return true;
  },
  delete_commitment: ({ id }) => {
    const index = commitments.findIndex((c) => c.id === id);
    if (index < 0) return false;
    commitments.splice(index, 1);
    return true;
  },

  get_approvals: () => approvals.filter((a) => a.status === 'pending').map((a) => ({ ...a })),
  approve_request: ({ id }) => {
    const row = approvals.find((a) => a.id === id);
    if (!row) return false;
    row.status = 'approved';
    return true;
  },
  reject_request: ({ id }) => {
    const row = approvals.find((a) => a.id === id);
    if (!row) return false;
    row.status = 'rejected';
    return true;
  },
});
