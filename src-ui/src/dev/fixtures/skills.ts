/*
 * Fixtures for the Skills and Memory surfaces (slice S6b).
 *
 * Tauri commands: list_skills, enable_skill, disable_skill,
 *   sync_distilled_skill_candidates, jarvis_get_skills, jarvis_get_tools,
 *   skill_revisions_list, skill_restore_revision,
 *   list_recent_memories, jarvis_get_tier_stats, memory_recall_preview.
 * Bun routes: GET /skills/candidates, POST /skills/candidates/:id/{eval,promote,reject,demote},
 *   GET /skills/candidates/:id/performance.
 *
 * The data is stateful within a page load, so toggles, promotions and
 * restores behave like the real thing.
 */
import { defineCommands, defineHttp, json } from '../registry';

const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000).toISOString();

// ── Skills ─────────────────────────────────────────────────────────────

interface FixtureSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  metadata: string | null;
  body: string;
  version: number;
  last_improved_at?: string | null;
  improvement_score: number;
  created_at: string;
  updated_at: string;
}

const body = (name: string, summary: string, extra = '') => `---
name: ${name}
description: ${summary}
---

# ${name}

${summary}

## When to use

- The request names this kind of task explicitly
- A Session turn is about to do the work by hand
- You need a repeatable checklist instead of improvising

## Steps

1. Read the relevant files before touching anything.
2. Make the smallest change that satisfies the request.
3. Verify with the project's own test command and report what ran.

${extra}`;

const codeBlock = '```bash\ngit diff --stat origin/main...HEAD\nbun test --bail\n```\n';
const table = '| Check | Required |\n| --- | --- |\n| Tests green | yes |\n| Changelog entry | when user-facing |\n';

function meta(o: Record<string, unknown>) {
  return JSON.stringify(o);
}

const skills: FixtureSkill[] = [
  {
    id: 'skill_code_review',
    name: 'code-review',
    description: 'Review a diff for correctness, regressions, and missing tests before it ships. Produces a ranked findings list.',
    path: '',
    enabled: true,
    metadata: meta({ category: 'development', source: 'bundled', emoji: '🔎', eligible: true, requires: { bins: ['git'] }, missing: {} }),
    body: body('code-review', 'Review code changes with a correctness-first lens.', `## Preflight\n\n${codeBlock}\n${table}`),
    version: 4,
    improvement_score: 0.31,
    created_at: ago(90),
    updated_at: ago(2),
  },
  {
    id: 'skill_test_writer',
    name: 'test-writer',
    description: 'Write focused unit tests for new or changed code, covering every branch and the failure paths.',
    path: '',
    enabled: true,
    metadata: meta({ category: 'development', source: 'bundled', emoji: '🧪', eligible: true }),
    body: body('test-writer', 'Cover every branch; prefer behaviour over implementation.'),
    version: 2,
    improvement_score: 0,
    created_at: ago(90),
    updated_at: ago(11),
  },
  {
    id: 'skill_git_commit',
    name: 'git-commit-helper',
    description: 'Stage coherent hunks and write conventional commit messages that explain why, not just what.',
    path: '',
    enabled: true,
    metadata: meta({ category: 'development', source: 'bundled', emoji: '🌿', eligible: true, requires: { bins: ['git'] }, missing: {} }),
    body: body('git-commit-helper', 'Small commits, honest messages.', codeBlock),
    version: 3,
    improvement_score: 0.12,
    created_at: ago(80),
    updated_at: ago(6),
  },
  {
    id: 'skill_web_research',
    name: 'web-research',
    description: 'Search the web, read Tier-1 sources, and write findings with citations into the memory reference folder.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'research',
      source: 'bundled',
      emoji: '🌐',
      requires: { env: ['BRAVE_API_KEY'], bins: ['curl'] },
      missing: { env: ['BRAVE_API_KEY'] },
    }),
    body: body('web-research', 'Find, read, and cite — never summarise from a search snippet alone.'),
    version: 1,
    improvement_score: 0,
    created_at: ago(60),
    updated_at: ago(25),
  },
  {
    id: 'skill_docker_ops',
    name: 'docker-compose-ops',
    description: 'Bring stacks up and down, tail logs, and diagnose unhealthy containers without leaving the Session.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'operations',
      source: 'bundled',
      emoji: '🐳',
      requires: { bins: ['docker', 'docker-compose'] },
      missing: { bins: ['docker', 'docker-compose'] },
    }),
    body: body('docker-compose-ops', 'Containers are somebody else’s computer; treat logs as evidence.'),
    version: 1,
    improvement_score: 0,
    created_at: ago(60),
    updated_at: ago(30),
  },
  {
    id: 'skill_pdf_extract',
    name: 'pdf-extract',
    description: 'Extract text and tables from PDFs into clean markdown, flagging pages that need OCR.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'documents',
      source: 'community',
      emoji: '📄',
      requires: { bins: ['pdftotext'] },
      missing: { bins: ['pdftotext'] },
    }),
    body: body('pdf-extract', 'Text first, OCR only when the page is an image.'),
    version: 2,
    improvement_score: 0,
    created_at: ago(45),
    updated_at: ago(14),
  },
  {
    id: 'skill_apple_notes',
    name: 'apple-notes',
    description: 'Read and append to Apple Notes through AppleScript. macOS only.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'productivity',
      source: 'community',
      emoji: '🗒️',
      requires: { os: ['darwin'], bins: ['osascript'] },
      missing: { os: ['darwin'], bins: ['osascript'] },
    }),
    body: body('apple-notes', 'Notes are the user’s — append, never rewrite.'),
    version: 1,
    improvement_score: 0,
    created_at: ago(45),
    updated_at: ago(45),
  },
  {
    id: 'skill_changelog',
    name: 'changelog-writer',
    description: 'Turn a range of merged pull requests into a user-facing changelog entry grouped by impact.',
    path: '',
    enabled: true,
    metadata: meta({ category: 'writing', source: 'bundled', emoji: '📝', eligible: true }),
    body: body('changelog-writer', 'Write for the person upgrading, not the person who built it.'),
    version: 2,
    improvement_score: 0.08,
    created_at: ago(70),
    updated_at: ago(4),
  },
  {
    id: 'skill_sql_explain',
    name: 'sql-explainer',
    description: 'Read a query plan, name the slow step in plain words, and propose one index or rewrite.',
    path: '',
    enabled: true,
    metadata: meta({
      category: 'data',
      source: 'bundled',
      emoji: '🗃️',
      requires: { config: ['database.url'] },
      missing: { config: ['database.url'] },
    }),
    body: body('sql-explainer', 'One bottleneck at a time.'),
    version: 1,
    improvement_score: 0,
    created_at: ago(33),
    updated_at: ago(9),
  },
  {
    id: 'skill_distilled_debug',
    name: 'distilled-debug-trace-a1b2',
    description: 'Distilled orchestration pattern for debugging: reproduce, bisect with logs, then fix the narrowest cause.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'distilled',
      source: 'trajectory_distillation',
      status: 'candidate',
      confidence: 0.72,
      candidate_id: 'skill_debug_a1b2c3d4',
    }),
    body: '# Distilled: debug\n\nReproduce first. Add one log line per hypothesis. Remove them before the fix lands.\n',
    version: 1,
    improvement_score: 0,
    created_at: ago(1, 4),
    updated_at: ago(0, 3),
  },
  {
    id: 'skill_distilled_refactor',
    name: 'distilled-refactor-split-c3d4',
    description: 'Distilled pattern for splitting an oversized module: extract pure helpers first, then move state.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'distilled',
      source: 'trajectory_distillation',
      status: 'promoted',
      confidence: 0.88,
      candidate_id: 'skill_refactor_c3d4e5f6',
    }),
    body: '# Distilled: refactor\n\nExtract pure helpers → add characterisation tests → move state → delete the old path.\n',
    version: 2,
    improvement_score: 0.42,
    created_at: ago(9),
    updated_at: ago(5),
  },
  {
    id: 'skill_distilled_docs',
    name: 'distilled-docs-sweep-e5f6',
    description: 'Distilled pattern for a documentation sweep: grep for drift, then fix docs rather than code.',
    path: '',
    enabled: false,
    metadata: meta({
      category: 'distilled',
      source: 'trajectory_distillation',
      status: 'rejected',
      confidence: 0.55,
      candidate_id: 'skill_docs_e5f6a7b8',
    }),
    body: '# Distilled: docs sweep\n\nGrep for stale terms; prefer the verified side when docs and code diverge.\n',
    version: 1,
    improvement_score: 0,
    created_at: ago(12),
    updated_at: ago(8),
  },
];

// ── Candidates (Bun server) ────────────────────────────────────────────

interface FixtureCandidate {
  id: string;
  name: string;
  description: string;
  trigger: { task_types: string[]; requirements: string[]; signals: string[] };
  body: string;
  source_run_ids: string[];
  source_session_id?: string;
  confidence: number;
  status: 'candidate' | 'promoted' | 'rejected';
  lifecycle_version: number;
  eval_score?: number;
  eval_missed?: string[];
  rejection_reason?: string;
  rejection_detail?: string;
  promoted_at?: string;
  created_at: string;
  updated_at: string;
}

const candidates: FixtureCandidate[] = [
  {
    id: 'skill_debug_a1b2c3d4',
    name: 'distilled-debug-trace-a1b2',
    description: skills[9].description,
    trigger: { task_types: ['debug', 'incident'], requirements: ['workspace_read'], signals: ['path:file_ext', 'mutation_verb'] },
    body: skills[9].body,
    source_run_ids: ['run_7f31', 'run_7f42'],
    source_session_id: 'sess_20c8e1',
    confidence: 0.72,
    status: 'candidate',
    lifecycle_version: 1,
    eval_score: 0.82,
    created_at: ago(1, 4),
    updated_at: ago(0, 3),
  },
  {
    id: 'skill_refactor_c3d4e5f6',
    name: 'distilled-refactor-split-c3d4',
    description: skills[10].description,
    trigger: { task_types: ['refactor'], requirements: ['workspace_write'], signals: ['line_count'] },
    body: skills[10].body,
    source_run_ids: ['run_6a10'],
    source_session_id: 'sess_19b772',
    confidence: 0.88,
    status: 'promoted',
    lifecycle_version: 3,
    eval_score: 0.91,
    promoted_at: ago(6),
    created_at: ago(9),
    updated_at: ago(5),
  },
  {
    id: 'skill_docs_e5f6a7b8',
    name: 'distilled-docs-sweep-e5f6',
    description: skills[11].description,
    trigger: { task_types: ['docs'], requirements: [], signals: ['grep_term'] },
    body: skills[11].body,
    source_run_ids: ['run_5c02'],
    source_session_id: 'sess_17a044',
    confidence: 0.55,
    status: 'rejected',
    lifecycle_version: 2,
    eval_score: 0.41,
    eval_missed: ['Did not check generated docs', 'Edited code to match stale docs'],
    rejection_reason: 'eval_failed',
    rejection_detail: 'Judge scored 0.41 against the 0.75 gate.',
    created_at: ago(12),
    updated_at: ago(8),
  },
];

const performance: Record<string, { before: [number, number]; after: [number, number] }> = {
  skill_refactor_c3d4e5f6: { before: [2, 3], after: [5, 5] },
};

function syncSkillStatus(candidate: FixtureCandidate) {
  const skill = skills.find((s) => s.metadata?.includes(candidate.id));
  if (!skill || !skill.metadata) return;
  const md = JSON.parse(skill.metadata) as Record<string, unknown>;
  md.status = candidate.status;
  skill.metadata = JSON.stringify(md);
  skill.updated_at = new Date().toISOString();
}

// ── Revisions ──────────────────────────────────────────────────────────

const reasons = [
  'Initial bundled version',
  'Tightened the preflight checklist after two missed regressions',
  'Added failure-path guidance learned from the review Session',
  'Reworded steps so they read as imperatives',
];

function revisionsFor(skillId: string) {
  const skill = skills.find((s) => s.id === skillId);
  if (!skill || skill.metadata?.includes('trajectory_distillation')) return [];
  return Array.from({ length: Math.min(skill.version, 4) }, (_, i) => {
    const version = skill.version - 1 - i;
    return version < 1
      ? null
      : {
          id: `rev_${skillId}_${version}`,
          skill_id: skillId,
          version,
          body_before: '',
          body_after: skill.body,
          change_reason: reasons[Math.min(version - 1, reasons.length - 1)],
          source_session_id: version > 1 ? 'sess_review_01' : null,
          created_at: ago(8 * (i + 1) + 3),
        };
  }).filter(Boolean);
}

defineCommands({
  list_skills: () => skills.map((s) => ({ ...s })),
  sync_distilled_skill_candidates: () => candidates.length,
  enable_skill: ({ name }) => {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`unknown skill ${String(name)}`);
    skill.enabled = true;
    return null;
  },
  disable_skill: ({ name }) => {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`unknown skill ${String(name)}`);
    skill.enabled = false;
    return null;
  },
  jarvis_get_skills: () =>
    skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, source: 'workspace' })),
  jarvis_get_tools: () =>
    ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_recall', 'cron_add'].map((name) => ({
      name,
    })),
  skill_revisions_list: ({ skillId }) => revisionsFor(String(skillId)),
  skill_restore_revision: ({ revisionId }) => {
    const match = /^rev_(.+)_(\d+)$/.exec(String(revisionId));
    const skill = match && skills.find((s) => s.id === match[1]);
    if (!skill) throw new Error('revision not found');
    skill.version += 1;
    skill.updated_at = new Date().toISOString();
    return true;
  },
});

defineHttp({
  'GET /skills/candidates': () => json({ candidates }),
});

for (const candidate of candidates) {
  defineHttp({
    [`GET /skills/candidates/${candidate.id}/performance`]: () => {
      const live = candidates.find((c) => c.id === candidate.id)!;
      const p = performance[candidate.id];
      if (live.status !== 'promoted' || !p) return json({ error: 'wrong_status' }, 409);
      const rate = (s: number, r: number) => (r === 0 ? null : s / r);
      const before = { runs: p.before[1], successes: p.before[0], success_rate: rate(...p.before) };
      const after = { runs: p.after[1], successes: p.after[0], success_rate: rate(...p.after) };
      return json({
        id: live.id,
        promoted_at: live.promoted_at,
        task_types: live.trigger.task_types,
        before,
        after,
        delta: before.success_rate !== null && after.success_rate !== null ? after.success_rate - before.success_rate : null,
      });
    },
  });
  for (const action of ['eval', 'promote', 'reject', 'demote'] as const) {
    defineHttp({
      [`POST /skills/candidates/${candidate.id}/${action}`]: ({ body }) => {
        const live = candidates.find((c) => c.id === candidate.id)!;
        const expected = (body as { expected_version?: number } | undefined)?.expected_version;
        if (expected !== live.lifecycle_version) return json({ error: 'version_conflict', id: live.id }, 409);
        if (action === 'eval') live.eval_score = Math.min(0.97, Math.max(0.5, (live.eval_score ?? 0.6) + 0.07));
        if (action === 'promote') {
          live.status = 'promoted';
          live.promoted_at = new Date().toISOString();
          performance[live.id] ??= { before: [1, 2], after: [0, 0] };
        }
        if (action === 'reject') {
          live.status = 'rejected';
          live.rejection_reason = 'manual';
        }
        if (action === 'demote') {
          live.status = 'candidate';
          live.promoted_at = undefined;
        }
        live.lifecycle_version += 1;
        live.updated_at = new Date().toISOString();
        syncSkillStatus(live);
        return json(live);
      },
    });
  }
}

// ── Memory ─────────────────────────────────────────────────────────────

type Tier = 'hot' | 'warm' | 'cold';

function memory(
  id: string,
  title: string,
  content: string,
  category: string,
  tags: string[],
  daysAgo: number,
  tier: Tier,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    title,
    content,
    tags: JSON.stringify(tags),
    category,
    created_at: ago(daysAgo + 3),
    updated_at: ago(daysAgo),
    relevance_score: 0.5,
    agent_id: 'jarvis',
    source: 'session',
    source_session_id: `sess_${id.slice(-4)}`,
    source_message_ids: JSON.stringify([`msg_${id.slice(-3)}a`, `msg_${id.slice(-3)}b`]),
    confidence: 0.6 + ((daysAgo * 7) % 4) / 10,
    last_used_at: ago(Math.max(0, daysAgo - 1)),
    usage_count: 1 + ((daysAgo * 3) % 9),
    expires_at: null,
    review_after: null,
    status: 'active',
    supersedes_id: null,
    metadata: null,
    tier,
    drive_file_id: null,
    summary: '',
    archived_at: null,
    updated_at_ms: Date.now() - daysAgo * DAY,
    ...extra,
  };
}

const memories = [
  memory('mem_0001', 'Prefers Bun over npm', 'Ethan runs everything through Bun: bun install, bun test, bun run. Never suggest npm or yarn commands in this repo.', 'preference', ['tooling', 'bun'], 0, 'hot', { source: 'operator', confidence: 0.97 }),
  memory('mem_0002', 'Cron missed-job policy', 'Missed cron jobs are never replayed silently. They surface in the Cron page as pending and need an explicit Run or Dismiss.', 'decision', ['cron', 'safety'], 0, 'hot', { confidence: 0.93 }),
  memory('mem_0003', 'soul.md lives in the Agent directory', 'Each Agent has its own directory with a soul.md. Edits to soul.md take effect on the next activation, not mid-Session.', 'reference', ['agents', 'soul.md'], 1, 'hot'),
  memory('mem_0004', 'Inference backend: llama.cpp on the workstation', 'The workstation serves a Qwen coder model through llama.cpp on port 8080. Ollama is kept as a fallback and is not the default.', 'project', ['inference', 'llama.cpp'], 1, 'hot', { confidence: 0.88 }),
  memory('mem_0005', 'Do not edit src-tauri during UI work', 'UI rebuild tasks stay inside src-ui. Rust changes go through a separate task so the build provenance stays attributable.', 'decision', ['ui', 'rust'], 2, 'hot'),
  memory('mem_0006', 'Discord channel bound to the Ops agent', 'The #ops Discord channel is bound to the ops agent. Receipts for outbound messages are readable from the Bun server.', 'project', ['channels', 'discord'], 3, 'warm', { agent_id: 'ops' }),
  memory('mem_0007', 'Standing review checklist', 'Before declaring a change done: build, run the focused tests, run the full suite once, and report totals. Say which side you verified when docs and code diverge.', 'preference', ['review', 'process'], 4, 'warm', { source: 'operator', confidence: 0.95 }),
  memory('mem_0008', 'Brass accent means live or chosen', 'In the Daedalus design system brass is reserved for the active route, focus, the running turn, and the primary action.', 'reference', ['design', 'ui'], 5, 'warm'),
  memory('mem_0009', 'Weekly learning session findings', 'Last learning session: Tauri 2 capability files must list every invoked command; missing entries fail silently in release builds only.', 'reference', ['tauri', 'learning'], 6, 'warm', { source: 'cron', agent_id: 'learning' }),
  memory('mem_0010', 'Mira owns the billing integration', 'Mira Okafor owns the billing integration and prefers async updates in the project channel rather than direct messages.', 'person', ['people', 'billing'], 8, 'warm'),
  memory('mem_0011', 'Hermes bridge is legacy', 'The Hermes bridge is not the chat path. Session turns go through the Bun server. Treat Hermes pages as legacy diagnostics.', 'decision', ['hermes', 'architecture'], 11, 'warm', { confidence: 0.9 }),
  memory('mem_0012', 'Build provenance badge', 'The titlebar shows a build badge from useBuildProvenance. A stale binary shows as a warning so a rebuilt UI is never confused with an old Tauri shell.', 'project', ['build', 'provenance'], 13, 'warm'),
  memory('mem_0013', 'Quarterly goals Q3', 'Q3 priorities: eval and regression harness, bridge reliability, profile provisioning UI, Tauri shell rewire.', 'project', ['planning'], 19, 'cold', { review_after: ago(-5) }),
  memory('mem_0014', 'Old Mythos palette notes', 'The Mythos OLED violet and cyan palette was retired with the Daedalus rebuild. Do not reintroduce hard-coded hex colours in features.', 'reference', ['design', 'history'], 24, 'cold', { status: 'superseded', supersedes_id: null }),
  memory('mem_0015', 'Ollama keep-alive quirk', 'Ollama unloads the model after five idle minutes by default; the first Session turn after that pays the full load cost.', 'reference', ['ollama', 'latency'], 27, 'cold'),
  memory('mem_0016', 'Conference travel dates', 'Ethan is travelling the second week of November; cron digests should be held and delivered on return.', 'person', ['calendar'], 33, 'cold', { expires_at: ago(-12) }),
  memory('mem_0017', 'Deploy window', 'Deploys to the workstation happen after 18:00 local. Never restart the Bun server during a running cron job.', 'decision', ['deploy', 'cron'], 38, 'cold', { confidence: 0.84 }),
  memory('mem_0018', 'Skill candidates need a passing eval', 'A distilled skill candidate cannot be promoted until the independent judge scores it at or above 0.75. Rejected candidates stay on record with the reason.', 'decision', ['skills', 'eval'], 2, 'hot', { confidence: 0.92 }),
];

defineCommands({
  list_recent_memories: () => [...memories].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
  jarvis_get_tier_stats: () => ({
    hot: memories.filter((m) => m.tier === 'hot').length,
    warm: memories.filter((m) => m.tier === 'warm').length,
    cold: memories.filter((m) => m.tier === 'cold').length,
  }),
  memory_recall_preview: ({ query }) => {
    const terms = String(query)
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => t.length > 1);
    return memories
      .map((m) => {
        const hay = `${m.title} ${m.content} ${m.tags} ${m.category}`.toLowerCase();
        const matched = terms.filter((t) => hay.includes(t));
        const score = terms.length === 0 ? 0 : (matched.length / terms.length) * (0.55 + m.confidence * 0.45);
        return { memory: { ...m, relevance_score: score }, score: Math.min(0.99, score), matched_terms: matched };
      })
      .filter((r) => r.matched_terms.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  },
});
