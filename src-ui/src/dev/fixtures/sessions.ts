/*
 * Sessions slice fixtures: Jarvis Sessions, history, run records, grants,
 * the native ledger, and a realistic SSE Session turn on POST /chat/stream.
 *
 * Prompt hooks for demos:
 *   · contains "approve" → the turn pauses on a tool_approval_request until
 *     jarvis_tool_decision is called (approve runs the tool, deny skips it)
 *   · contains "fail"    → the stream ends with a first_token_timeout error
 */
import { defineCommands, defineHttp, json, sleep, sse } from '../registry';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface Session {
  id: string;
  name: string;
  model: string;
  message_count: number;
  created_at: string;
  last_active: string;
  backend: string;
}
interface Message {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  tool_calls: string | null;
  created_at: string;
}
interface Run {
  session_id: string;
  run_id: string;
  outcome: string;
  selected_model?: string | null;
  token_count: number;
  tool_count: number;
  cancelled_reason?: string | null;
  partial_output?: string | null;
}

const MODEL = 'gemma-4-26b-a4b';

const sessions: Session[] = [
  { id: 'ses_8f3a21c4', name: 'Cron scheduler backoff refactor', model: MODEL, message_count: 6, created_at: ago(38), last_active: ago(6), backend: 'llama_cpp' },
  { id: 'ses_71bd09e2', name: 'Why is the Bun server leaking sockets?', model: 'deepseek-v4-flash', message_count: 9, created_at: ago(60 * 5), last_active: ago(60 * 3), backend: 'openrouter' },
  { id: 'ses_2c95f7aa', name: 'soul.md voice for the research Agent', model: MODEL, message_count: 4, created_at: ago(60 * 26), last_active: ago(60 * 25), backend: 'llama_cpp' },
  { id: 'ses_c04e6b18', name: 'Tauri shell rewire plan', model: 'qwen3-coder:30b', message_count: 12, created_at: ago(60 * 49), last_active: ago(60 * 47), backend: 'ollama' },
  { id: 'ses_9e1d3f70', name: 'Eval harness: regression fixtures', model: MODEL, message_count: 7, created_at: ago(60 * 24 * 3), last_active: ago(60 * 24 * 3 - 40), backend: 'llama_cpp' },
  { id: 'ses_5ab8e260', name: 'OpenClaw bridge handshake', model: 'claude-sonnet', message_count: 3, created_at: ago(60 * 24 * 5), last_active: ago(60 * 24 * 5 - 15), backend: 'claude_cli' },
  { id: 'ses_0f7c4d93', name: 'Profile provisioning UI copy', model: MODEL, message_count: 2, created_at: ago(60 * 24 * 9), last_active: ago(60 * 24 * 9 - 5), backend: 'llama_cpp' },
];

const runs: Run[] = [
  { session_id: 'ses_8f3a21c4', run_id: 'run_e41c90', outcome: 'success', selected_model: MODEL, token_count: 4120, tool_count: 3 },
  { session_id: 'ses_8f3a21c4', run_id: 'run_d07a12', outcome: 'partial', selected_model: MODEL, token_count: 2210, tool_count: 1, partial_output: 'The backoff table…' },
  { session_id: 'ses_71bd09e2', run_id: 'run_bb9f31', outcome: 'failed', selected_model: 'deepseek-v4-flash', token_count: 812, tool_count: 2 },
  { session_id: 'ses_71bd09e2', run_id: 'run_a1f004', outcome: 'success', selected_model: 'deepseek-v4-flash', token_count: 6650, tool_count: 5 },
  { session_id: 'ses_2c95f7aa', run_id: 'run_77c2e8', outcome: 'success', selected_model: MODEL, token_count: 1980, tool_count: 0 },
  { session_id: 'ses_c04e6b18', run_id: 'run_5d0e6a', outcome: 'timed_out', selected_model: 'qwen3-coder:30b', token_count: 3302, tool_count: 4 },
  { session_id: 'ses_9e1d3f70', run_id: 'run_19ab77', outcome: 'cancelled', selected_model: MODEL, token_count: 410, tool_count: 1, cancelled_reason: 'user_stop' },
];

const grants: Record<string, string[]> = {
  ses_8f3a21c4: ['/Users/ethan/Projects/home-base/src-tauri', '/Users/ethan/Projects/home-base/server-jarvis'],
  ses_c04e6b18: ['/Users/ethan/Projects/home-base'],
};

const CRON_ANSWER = `The current scheduler retries a failed job on a **fixed 30 s interval**, which is why a broken job hammers the Bun server all night. I'd move it to capped exponential backoff with jitter, keyed per job.

### What changes

1. \`next_delay\` becomes a pure function of the attempt count, so it is trivially testable.
2. The jitter is *full jitter* (uniform in \`[0, cap]\`) — it de-synchronises jobs that failed together.
3. A job that keeps failing is parked after \`max_attempts\` and surfaces in **Cron → Missed jobs** instead of retrying forever.

\`\`\`rust
/// Capped exponential backoff with full jitter.
pub fn next_delay(attempt: u32, base: Duration, cap: Duration) -> Duration {
    let exp = base.saturating_mul(1u32 << attempt.min(16));
    let ceiling = exp.min(cap);
    let jitter = rand::thread_rng().gen_range(0..=ceiling.as_millis() as u64);
    Duration::from_millis(jitter)
}
\`\`\`

| Attempt | Ceiling | Typical wait |
| --- | --- | --- |
| 1 | 2 s | ~1 s |
| 3 | 8 s | ~4 s |
| 6 | 64 s | ~32 s |
| 10+ | 5 min (cap) | ~2.5 min |

> The cap matters more than the base: without it, attempt 16 would wait 18 hours.

I ran \`cargo test -p scheduler backoff\` against the new function — all 7 cases pass. Want me to wire it into \`CronRunner::reschedule\` next?`;

const history: Record<string, Array<{ role: string; content: string; at: number }>> = {
  ses_8f3a21c4: [
    { role: 'user', content: 'The cron scheduler keeps retrying failed jobs every 30 seconds. Can you propose a backoff strategy and show me the code?', at: 37 },
    { role: 'assistant', content: CRON_ANSWER, at: 36 },
    { role: 'user', content: 'Yes — wire it into CronRunner::reschedule, and keep the parked-job event on cron://missed-jobs.', at: 8 },
    {
      role: 'assistant',
      content:
        'Done. `CronRunner::reschedule` now calls `next_delay(attempt, 2s, 5m)` and emits `cron://missed-jobs` with `{ job_id, attempts }` when a job is parked.\n\n- `src-tauri/src/cron/runner.rs` — reschedule + park\n- `src-tauri/src/cron/backoff.rs` — new module, 7 unit tests\n- `src-ui` needs no change: the Cron page already listens for the event.\n\nThe regression fixture for a flapping job is in `workspace/evals/cron-flap.json`.',
      at: 6,
    },
  ],
  ses_71bd09e2: [
    { role: 'user', content: 'The Bun server is at 4,000 open sockets after a day. Where are they coming from?', at: 60 * 5 },
    {
      role: 'assistant',
      content:
        'Every `/chat/stream` request opens an SSE response, and the inactivity watchdog only aborts the **client** side. When the UI navigates away mid-turn, the server keeps the upstream fetch to the Inference backend open until the model finishes.\n\nFix: pass the request `AbortSignal` through to the backend fetch and close the `ReadableStream` controller in `cancel()`.',
      at: 60 * 5 - 3,
    },
  ],
  ses_2c95f7aa: [
    { role: 'user', content: 'Draft a soul.md voice section for the research Agent: precise, cites sources, never speculates without saying so.', at: 60 * 26 },
    {
      role: 'assistant',
      content:
        '## Voice\n\nYou are a careful research partner. You:\n\n- **cite** every non-obvious claim with a link or a file path;\n- separate *what the source says* from *what you infer*, and label inference as such;\n- prefer “I could not verify this” over a confident guess.\n\nKeep answers short until asked to go deeper.',
      at: 60 * 26 - 2,
    },
  ],
};

const messages: Record<string, Message[]> = {};
for (const [sid, rows] of Object.entries(history)) {
  messages[sid] = rows.map((row) => ({
    id: nextId('msg'),
    session_id: sid,
    role: row.role,
    content: row.content,
    tokens: Math.ceil(row.content.length / 4),
    tool_calls: null,
    created_at: ago(row.at),
  }));
}

const ledger = [
  { id: 'ses_8f3a21c4', agent_id: 'jarvis', title: 'Cron scheduler backoff refactor', backend: 'llama_cpp', model: MODEL, context_tokens: 32768, total_tokens: 14210, created_at: ago(38), updated_at: ago(6), archived: false, message_count: 6 },
  { id: 'chn_tg_4410', agent_id: 'telegram-relay', title: 'Telegram · morning brief', backend: 'openrouter', model: 'deepseek-v4-flash', context_tokens: 65536, total_tokens: 58210, created_at: ago(60 * 9), updated_at: ago(22), archived: false, message_count: 41 },
  { id: 'agt_research_77', agent_id: 'research', title: 'Literature scan: speculative decoding', backend: 'llama_cpp', model: MODEL, context_tokens: 32768, total_tokens: 9020, created_at: ago(60 * 30), updated_at: ago(60 * 2), archived: false, message_count: 14 },
  { id: 'cron_selfimp_12', agent_id: 'self-improvement', title: '', backend: 'ollama', model: 'qwen3-coder:30b', context_tokens: 16384, total_tokens: 4100, created_at: ago(60 * 24 * 2), updated_at: ago(60 * 24 * 2 - 10), archived: true, message_count: 6 },
];

const ledgerHistory: Record<string, Message[]> = {
  'chn_tg_4410': [
    { id: 'tg-1', session_id: 'chn_tg_4410', role: 'user', content: 'Morning brief please — calendar, cron health, anything that failed overnight.', tokens: 20, tool_calls: null, created_at: ago(30) },
    { id: 'tg-2', session_id: 'chn_tg_4410', role: 'tool', content: '[tool: list_cron_jobs] 14 jobs · 1 parked (eval-nightly, 6 attempts)', tokens: 18, tool_calls: null, created_at: ago(29) },
    { id: 'tg-3', session_id: 'chn_tg_4410', role: 'assistant', content: 'Good morning. Three things:\n\n1. **eval-nightly** was parked after 6 failed attempts — the llama.cpp server was restarting.\n2. Two meetings today, the first at 10:30.\n3. Build provenance is clean: the running binary matches `main`.', tokens: 60, tool_calls: null, created_at: ago(28) },
  ],
};

defineCommands({
  jarvis_list_sessions: () => [...sessions].sort((a, b) => Date.parse(b.last_active) - Date.parse(a.last_active)),
  get_session_history: ({ sessionId }) => {
    const id = String(sessionId);
    if (ledgerHistory[id]) return ledgerHistory[id];
    return messages[id] ?? [];
  },
  jarvis_new_session: ({ name }) => {
    const session: Session = {
      id: nextId('ses'),
      name: String(name || 'New Session'),
      model: MODEL,
      message_count: 0,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      backend: 'llama_cpp',
    };
    sessions.unshift(session);
    messages[session.id] = [];
    return session;
  },
  append_message: ({ sessionId, role, content }) => {
    const sid = String(sessionId);
    const message: Message = {
      id: nextId('msg'),
      session_id: sid,
      role: String(role),
      content: String(content),
      tokens: Math.ceil(String(content).length / 4),
      tool_calls: null,
      created_at: new Date().toISOString(),
    };
    (messages[sid] ??= []).push(message);
    const session = sessions.find((s) => s.id === sid);
    if (session) {
      session.message_count += 1;
      session.last_active = message.created_at;
    }
    return message.id;
  },
  jarvis_delete_session: ({ sessionId }) => {
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index >= 0) sessions.splice(index, 1);
    return null;
  },
  get_all_session_runs: () => runs.map((run) => ({ ...run })),
  get_session_runs: ({ sessionId }) => runs.filter((run) => run.session_id === sessionId).map((run) => ({ ...run })),
  record_terminal_run: (args) => {
    const run: Run = {
      session_id: String(args.sessionId),
      run_id: String(args.runId),
      outcome: String(args.outcome),
      selected_model: (args.selectedModel as string | null) ?? null,
      token_count: Number(args.tokenCount ?? 0),
      tool_count: Number(args.toolCount ?? 0),
      cancelled_reason: (args.cancelledReason as string | null) ?? null,
      partial_output: (args.partialOutput as string | null) ?? null,
    };
    const existing = runs.findIndex((r) => r.run_id === run.run_id);
    if (existing >= 0) runs.splice(existing, 1);
    runs.unshift(run);
    return run;
  },
  jarvis_get_session_grants: ({ sessionId }) => ({ session_id: sessionId, grants: grants[String(sessionId)] ?? [] }),
  jarvis_revoke_session_grant: ({ sessionId, root }) => {
    const sid = String(sessionId);
    grants[sid] = (grants[sid] ?? []).filter((r) => r !== root);
    return { session_id: sid, grants: grants[sid] };
  },
  cancel_chat_stream: ({ sessionId }) => {
    cancelled.add(String(sessionId));
    return true;
  },
  jarvis_tool_decision: ({ toolCallId, decision }) => {
    const waiter = approvals.get(String(toolCallId));
    approvals.delete(String(toolCallId));
    waiter?.(decision === 'approve');
    return null;
  },
  list_sessions: () => ledger,
  jarvis_get_config: () => ({
    version: '2',
    active_backend: 'llama_cpp',
    ollama: { base_url: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b', auto_pull: false, health_check_interval_ms: 30000, options: { num_ctx: 16384, num_gpu: 1, num_thread: 8 } },
    openrouter: { base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'deepseek-v4-flash', site_url: '', site_name: '', fallbacks: [], enable_fallbacks: true, enable_paid_fallbacks: false, max_retries: 2, timeout_ms: 60000 },
    llama_cpp: { base_url: 'http://127.0.0.1:8080', model: MODEL, server_path: '', model_path: '', mtp_path: '', port: 8080, context_window: 32768, reasoning_budget: 1536 },
    claude_cli: { enabled: false, path: 'claude', args: [], timeout_ms: 120000, cwd: '', auth_mode: 'proxy', delegate: { enabled: false, policy: 'escalation', permission_mode: 'default', allowed_tools: [], model: '', timeout_ms: 0 } },
    tools: { enabled: true, require_approval: ['filesystem.write', 'shell.exec'], sandbox_mode: 'strict', allowlist: [], denylist: [], allowed_roots: [], grant_session_roots: true, bash_path: '', shell_timeout_max_ms: 60000 },
    reasoning: { enabled: true, show_trace_by_default: false, max_tokens: 1536 },
  }),
});

/* ── The simulated Session turn ─────────────────────────────────────────── */

const cancelled = new Set<string>();
const approvals = new Map<string, (approved: boolean) => void>();

const STREAMED_ANSWER = `Here is what I found in \`server-jarvis/src/stream.ts\`.

The SSE writer never observes the request's \`AbortSignal\`, so when the UI stops a Session turn the upstream fetch to the Inference backend keeps running until the model finishes.

\`\`\`ts
const upstream = await fetch(backendUrl, { body, signal: req.signal });
req.signal.addEventListener('abort', () => controller.close(), { once: true });
\`\`\`

With that change a Stop releases the socket immediately. I also added a regression case to the eval harness so this cannot quietly come back.`;

function chunk(text: string, parts: number): string[] {
  const out: string[] = [];
  const size = Math.ceil(text.length / parts);
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

defineHttp({
  'POST /chat/cancel': ({ body }) => {
    const sid = (body as { session_id?: string } | undefined)?.session_id;
    if (sid) cancelled.add(sid);
    return json({ ok: true });
  },
  'POST /chat/stream': ({ body, signal }) => {
    const { session_id: sid = '', message = '' } = (body ?? {}) as { session_id?: string; message?: string };
    cancelled.delete(sid);
    const wantsApproval = /approve/i.test(message);
    const fails = /\bfail/i.test(message);
    const runId = nextId('run');
    const started = Date.now();
    const stop = () => cancelled.has(sid);

    return sse(async function* () {
      yield { type: 'init' };
      yield { type: 'agent_run_id', agent_run_id: runId };
      yield { type: 'scope_notice', allowed_paths: ['server-jarvis/src'], allow_root_listing: true, shell: 'denied', network: 'denied' };
      yield { type: 'orchestrator_stage', stage: 'planner', status: 'running' };
      await sleep(500);
      for (const piece of ['Locate the SSE writer. ', 'Check abort propagation to the backend fetch. ', 'Propose a minimal fix.']) {
        yield { type: 'reasoning_chunk', content: piece };
        await sleep(160);
      }
      yield { type: 'orchestrator_stage', stage: 'planner', status: 'completed', elapsed_ms: Date.now() - started };
      if (stop()) {
        yield { type: 'cancelled', reason: 'user_stop' };
        return;
      }
      if (fails) {
        await sleep(600);
        yield { type: 'error', code: 'first_token_timeout', error: 'The model produced no first token within 45s.' };
        return;
      }
      yield { type: 'orchestrator_stage', stage: 'executor', status: 'running' };
      yield {
        type: 'conductor_directive',
        session_id: sid,
        stage: 'executor',
        directive: { type: 'inject_context', forStage: 'executor', note: 'server-jarvis/src/stream.ts', reason: 'attach the stream module before editing' },
      };
      await sleep(300);
      yield { type: 'tool_use', id: 'call_read_1', name: 'read_file', arguments: { path: 'server-jarvis/src/stream.ts' } };
      await sleep(700);
      yield {
        type: 'tool_result',
        call_id: 'call_read_1',
        name: 'read_file',
        output: 'export async function streamChat(req: Request) {\n  const upstream = await fetch(backendUrl, { body });\n  …',
        is_error: false,
      };

      if (wantsApproval) {
        const callId = 'call_write_2';
        yield {
          type: 'tool_approval_request',
          session_id: sid,
          call_id: callId,
          name: 'filesystem.write',
          arguments: {
            path: 'server-jarvis/src/stream.ts',
            edits: [{ find: 'fetch(backendUrl, { body })', replace: 'fetch(backendUrl, { body, signal: req.signal })' }],
          },
          policy_source: 'tool_requires_approval',
        };
        const approved = await new Promise<boolean>((resolve) => {
          approvals.set(callId, resolve);
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
        if (stop()) {
          yield { type: 'cancelled', reason: 'user_stop' };
          return;
        }
        if (approved) {
          yield { type: 'tool_use', id: callId, name: 'filesystem.write', arguments: { path: 'server-jarvis/src/stream.ts' } };
          await sleep(400);
          yield { type: 'tool_result', call_id: callId, name: 'filesystem.write', output: '1 edit applied (+2 −1)', is_error: false };
        } else {
          yield { type: 'agent_activity', stage: 'executor', text: '[Tool Substituted: filesystem.write]' };
        }
      }

      yield { type: 'orchestrator_stage', stage: 'executor', status: 'completed', elapsed_ms: Date.now() - started };
      yield { type: 'reasoning_complete' };
      yield { type: 'orchestrator_stage', stage: 'synthesizer', status: 'running' };
      await sleep(350);
      for (const piece of chunk(STREAMED_ANSWER, 42)) {
        if (stop()) {
          yield { type: 'cancelled', reason: 'user_stop' };
          return;
        }
        yield { type: 'stream_event', delta: { text: piece } };
        await sleep(70);
      }
      yield { type: 'orchestrator_stage', stage: 'synthesizer', status: 'completed', elapsed_ms: Date.now() - started };
      yield { type: 'cost_info', model: MODEL, total_tokens: 3184, cost_usd: 0 };
      yield {
        type: 'orchestration_metrics',
        duration_ms: Date.now() - started,
        tokens_total: 3184,
        tool_calls: wantsApproval ? 2 : 1,
        fallback_retries: 0,
        scope_compliant: true,
        actual_provider: 'llama_cpp',
        actual_model: MODEL,
        first_visible_token_ms: 2410,
      };
      yield { type: 'result', subtype: 'success', result: STREAMED_ANSWER };
    }, signal);
  },
});
