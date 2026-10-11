/*
 * Fixtures for the Cron and Hooks pages and the app-level signals
 * (action-registry alerts, cron://missed-jobs). Stateful: toggling, running,
 * deleting and creating jobs, and registering hooks, all persist for the
 * lifetime of the page so the surfaces behave like a live system.
 */
import { defineCommands, emitEvent, sleep } from '../registry';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.now();
const at = (ms: number) => new Date(t0 + ms).toISOString();

interface Job {
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

interface Run {
  id: string;
  cron_id: string;
  status: string;
  output: string;
  error: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  execution_evidence?: { run_id: string; status: string; acceptance_result?: string; error_code?: string };
}

const LEARNING_PROMPT =
  'You are Jarvis conducting an autonomous Learning Session on local agentic AI architecture. Research the assigned subtopics, keep Tier 1 sources only, and write one structured finding per subtopic to memory.';
const REVIEW_PROMPT =
  'You are Jarvis performing a self-improvement review of recent conversations. Extract durable memories and skill updates as JSON; be conservative.';

function job(over: Partial<Job> & Pick<Job, 'id' | 'name' | 'schedule' | 'prompt'>): Job {
  return {
    agent_id: 'jarvis',
    session_id: null,
    enabled: true,
    last_run: null,
    next_run: null,
    run_count: 0,
    metadata: null,
    created_at: at(-30 * DAY),
    updated_at: at(-2 * DAY),
    ...over,
  };
}

const jobs: Job[] = [
  job({
    id: 'cron-learning', name: 'Morning Learning Session', schedule: '0 3 * * *', prompt: LEARNING_PROMPT,
    last_run: at(-9 * HOUR - 12 * MIN), next_run: at(15 * HOUR + 48 * MIN), run_count: 41,
  }),
  job({
    id: 'cron-review', name: 'Conversation Review', schedule: '0 */12 * * *', prompt: REVIEW_PROMPT,
    last_run: at(-8 * HOUR - 52 * MIN), next_run: at(3 * HOUR + 8 * MIN), run_count: 88,
  }),
  job({
    id: 'cron-eval', name: 'Eval regression harness', schedule: '0 */6 * * *', agent_id: 'qa-lead',
    prompt: 'Run the eval harness against the active Inference backend and file a diff against the last green baseline.',
    last_run: at(-4 * HOUR - 20 * MIN), next_run: at(1 * HOUR + 40 * MIN), run_count: 212,
  }),
  job({
    id: 'cron-provenance', name: 'Build provenance check', schedule: '*/30 * * * *', agent_id: 'release-engineer',
    prompt: 'Compare the running binary SHA with the checked-out source SHA and raise a stale-binary alert if they differ.',
    last_run: at(-18 * MIN), next_run: at(12 * MIN), run_count: 640,
  }),
  job({
    id: 'cron-sweep', name: 'Skill performance sweep', schedule: '15 * * * *',
    prompt: 'Score promoted skills against their last 20 invocations and flag regressions.',
    last_run: at(-47 * MIN), next_run: at(13 * MIN + 30_000), run_count: 156,
  }),
  job({
    id: 'cron-compact', name: 'Memory compaction', schedule: '30 2 * * *', agent_id: 'archivist',
    prompt: 'Merge duplicate memory entries, expire stale project facts, and rebuild the recall index.',
    last_run: at(-10 * HOUR - 30 * MIN), next_run: at(14 * HOUR + 30 * MIN), run_count: 34,
  }),
  job({
    id: 'cron-triage', name: 'Inbox triage', schedule: '0 9 * * 1-5', agent_id: 'chief-of-staff',
    prompt: 'Summarise overnight messages across connected Channels and draft replies for anything urgent.',
    last_run: at(-1 * DAY - 3 * HOUR), next_run: at(6 * HOUR + 45 * MIN), run_count: 120,
  }),
  job({
    id: 'cron-calendar', name: 'Calendar digest sync', schedule: '0 7 * * *', agent_id: 'chief-of-staff',
    prompt: 'Pull tomorrow\'s calendar, reconcile conflicts, and post the digest to the team Channel.',
    last_run: at(-4 * HOUR - 9 * MIN), next_run: at(19 * HOUR + 51 * MIN), run_count: 310,
  }),
  job({
    id: 'cron-release', name: 'Release notes draft', schedule: '0 6 * * *', agent_id: 'release-engineer',
    prompt: 'Draft release notes from merged pull requests since the last tag.',
    last_run: at(-1 * DAY - 5 * HOUR), next_run: at(-5 * HOUR - 4 * MIN), run_count: 19,
  }),
  job({
    id: 'cron-audit', name: 'Weekly dependency audit', schedule: '0 8 * * 1',
    prompt: 'Audit Cargo and Bun lockfiles for advisories and open an issue per critical finding.',
    last_run: at(-4 * DAY), next_run: at(3 * DAY + 2 * HOUR), run_count: 12,
  }),
  job({
    id: 'cron-backup', name: 'Workspace snapshot backup', schedule: '0 1 * * 0', agent_id: 'archivist', enabled: false,
    prompt: 'Snapshot the workspace and Agent directory to the configured backup target.',
    last_run: at(-12 * DAY), next_run: at(2 * DAY + 11 * HOUR), run_count: 9,
  }),
];

/** Jobs whose scheduled run passed while the app was closed. */
const missedIds = new Set<string>(['cron-release', 'cron-triage']);
// Make Inbox triage look genuinely missed too.
jobs.find((j) => j.id === 'cron-triage')!.next_run = at(-2 * HOUR - 15 * MIN);

const inFlight = new Map<string, number>();
inFlight.set('cron-sweep', Date.now() + 12_000);

function makeRuns(): Record<string, Run[]> {
  const out: Record<string, Run[]> = {};
  const outputs = [
    'Wrote 3 findings to memory/reference/learnings and updated MEMORY.md.',
    'Reviewed 14 Sessions; saved 2 memories and 1 skill update.',
    'No drift detected. Baseline unchanged.',
    'Merged 6 duplicate entries; recall index rebuilt in 2.1s.',
    '9 of 9 tasks passed against qwen3-coder on llama.cpp.',
  ];
  for (const j of jobs) {
    const runs: Run[] = [];
    const count = Math.min(j.run_count, 9);
    const period = j.id === 'cron-provenance' ? 30 * MIN : j.id === 'cron-sweep' ? HOUR : j.id === 'cron-review' ? 12 * HOUR : DAY;
    const base = j.last_run ? new Date(j.last_run).getTime() - t0 : -period;
    for (let i = 0; i < count; i++) {
      const started = base - i * period;
      let status = 'success';
      let error = '';
      let evidence: Run['execution_evidence'];
      if (j.id === 'cron-calendar') {
        status = i === 1 || i === 4 ? 'success' : 'failed';
        error = status === 'failed' ? (i === 0 ? 'Calendar connector returned 401: token expired' : 'Timed out waiting for calendar connector') : '';
        if (status === 'failed') evidence = { run_id: `${j.id}-run-${i}`, status: 'failed', error_code: i === 0 ? 'AUTH_EXPIRED' : 'CONNECTOR_TIMEOUT' };
      } else if (j.id === 'cron-eval' && i === 3) {
        status = 'timeout';
        error = 'Run exceeded the 20 minute limit';
      } else if (i === 6 && j.run_count > 20) {
        status = 'failed';
        error = 'Inference backend unavailable';
      }
      if (status === 'success' && i % 2 === 0) {
        evidence = { run_id: `${j.id}-run-${i}`, status: 'passed', acceptance_result: 'Acceptance criteria verified: output written and index updated.' };
      }
      const duration = status === 'timeout' ? 1_200_000 : status === 'failed' ? 800 + i * 410 : 2_400 + ((i * 7_919) % 61_000);
      runs.push({
        id: `${j.id}-run-${i}`,
        cron_id: j.id,
        status,
        output: status === 'success' ? outputs[(i + j.name.length) % outputs.length] : '',
        error,
        duration_ms: duration,
        started_at: at(started),
        finished_at: at(started + duration),
        execution_evidence: evidence,
      });
    }
    out[j.id] = runs;
  }
  return out;
}
const runsByJob = makeRuns();

function settleInFlight() {
  const now = Date.now();
  for (const [id, until] of inFlight) {
    if (now < until) continue;
    inFlight.delete(id);
    const j = jobs.find((row) => row.id === id);
    if (!j) continue;
    j.run_count += 1;
    j.last_run = new Date().toISOString();
    const run: Run = {
      id: `${id}-run-${j.run_count}`, cron_id: id, status: 'success', output: 'Completed on demand.', error: '',
      duration_ms: 11_800, started_at: new Date(now - 11_800).toISOString(), finished_at: new Date(now).toISOString(),
    };
    runsByJob[id] = [run, ...(runsByJob[id] ?? [])];
  }
}

const missedList = () => jobs.filter((j) => missedIds.has(j.id));

// ── Hooks ────────────────────────────────────────────────────────────────────

interface Hook {
  id: string;
  name: string;
  event: string;
  script: string;
  enabled: boolean;
  created_at: string;
}

const hooks: Hook[] = [
  { id: 'hook-audit', name: 'Audit every tool call', event: 'tool.before', script: 'bun run scripts/audit-tool-call.ts', enabled: true, created_at: at(-21 * DAY) },
  { id: 'hook-after', name: 'Record tool outcomes', event: 'tool.after', script: 'bun run scripts/record-outcome.ts --append ledger.jsonl', enabled: true, created_at: at(-21 * DAY) },
  { id: 'hook-start', name: 'Warm the recall index', event: 'session.start', script: 'curl -s -X POST http://127.0.0.1:19877/memory/warm', enabled: true, created_at: at(-9 * DAY) },
  { id: 'hook-cron', name: 'Notify on cron failure', event: 'cron.run', script: 'osascript -e \'display notification "Cron run finished"\'', enabled: true, created_at: at(-6 * DAY) },
  { id: 'hook-agent', name: 'Log Agent activations', event: 'agent.activated', script: '', enabled: true, created_at: at(-3 * DAY) },
  { id: 'hook-sent', name: 'Mirror outbound messages', event: 'message.sent', script: './hooks/mirror.sh', enabled: false, created_at: at(-14 * DAY) },
];

// ── Commands ─────────────────────────────────────────────────────────────────

defineCommands({
  list_cron_jobs: () => {
    settleInFlight();
    return structuredClone(jobs);
  },
  get_in_flight_cron_jobs: () => {
    settleInFlight();
    return [...inFlight.keys()];
  },
  list_pending_missed_jobs: () => structuredClone(missedList()),
  get_cron_runs: ({ cronId }) => structuredClone(runsByJob[String(cronId)] ?? []),
  add_cron_job: async ({ name, schedule, prompt, agentId }) => {
    await sleep(350);
    const created = job({
      id: `cron-${Math.random().toString(36).slice(2, 8)}`,
      name: String(name),
      schedule: String(schedule),
      prompt: String(prompt),
      agent_id: String(agentId ?? 'jarvis'),
      created_at: new Date().toISOString(),
      next_run: at(HOUR),
    });
    jobs.unshift(created);
    return structuredClone(created);
  },
  edit_cron_job: async ({ id, patch }) => {
    await sleep(250);
    const j = jobs.find((row) => row.id === id);
    if (!j) throw new Error('not found');
    const p = patch as Record<string, string>;
    Object.assign(j, { name: p.name, schedule: p.schedule, prompt: p.prompt, agent_id: p.agent_id, updated_at: new Date().toISOString() });
    return structuredClone(j);
  },
  enable_cron_job: ({ id }) => {
    const j = jobs.find((row) => row.id === id);
    if (j) j.enabled = true;
    return Boolean(j);
  },
  disable_cron_job: ({ id }) => {
    const j = jobs.find((row) => row.id === id);
    if (j) j.enabled = false;
    return Boolean(j);
  },
  delete_cron_job: ({ id }) => {
    const i = jobs.findIndex((row) => row.id === id);
    if (i >= 0) jobs.splice(i, 1);
    missedIds.delete(String(id));
    return i >= 0;
  },
  run_cron_job: ({ id }) => {
    inFlight.set(String(id), Date.now() + 6_000);
    return true;
  },
  dismiss_missed_cron_job: ({ id }) => {
    const j = jobs.find((row) => row.id === id);
    if (j) j.next_run = at(18 * HOUR);
    return missedIds.delete(String(id));
  },
  trigger_missed_cron_job: ({ id }) => {
    const j = jobs.find((row) => row.id === id);
    if (j) j.next_run = at(18 * HOUR);
    if (missedIds.delete(String(id))) inFlight.set(String(id), Date.now() + 6_000);
    return true;
  },

  get_hooks: () => structuredClone(hooks),
  register_hook: async ({ name, event, script }) => {
    await sleep(300);
    const created: Hook = {
      id: `hook-${Math.random().toString(36).slice(2, 8)}`,
      name: String(name),
      event: String(event),
      script: script ? String(script) : '',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    hooks.unshift(created);
    return created;
  },
  unregister_hook: async ({ id }) => {
    await sleep(300);
    const i = hooks.findIndex((row) => row.id === id);
    if (i >= 0) hooks.splice(i, 1);
    return i >= 0;
  },

  get_action_registry_alerts: () => [
    {
      id: 'alert-drift-1',
      kind: 'drift',
      severity: 'high',
      title: 'Action Registry drift',
      message: '2 registered actions no longer match their declared tool contracts.',
      action_id: 'act-sync-calendar',
      count: 2,
      created_at: at(-6 * MIN),
    },
  ],
});

// Mimic the scheduler announcing jobs that were missed while the app was closed.
setTimeout(() => emitEvent('cron://missed-jobs', structuredClone(missedList())), 4_000);
