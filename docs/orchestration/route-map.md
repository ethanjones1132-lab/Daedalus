# Inference route map — Phase 0

**2026-11-07 source checkpoint:** The later [comparison landing](../reports/2026-11-07-direct-orchestrated-landing.md) and [Orchestration Settings source review](../reports/2026-11-07-orchestration-settings.md) add local-routing boundaries, per-attempt disclosure, explicit stage routes, and owned Native route diagnostics. The settings landing ran compilation/build checks only; its live, model, and packaged acceptance remains NOT RUN. The Phase 0 map and revision-specific references below are retained as historical evidence, not a description of the current tree.

**Source:** `f681841dc900425c81df9d2e2159815e2abd5652`, inspected 2026-11-06.
**Status:** source map recorded; Phase 0 runtime evidence **BLOCKED / NOT RUN**.
All references below are repository-relative `file:line` references at that revision. Defaults are source defaults, not observations of an installed configuration.

## 1. Entry paths and configuration authority

| Entry | Configuration → code path | Default / fallback | What the UI receives |
|---|---|---|---|
| Session turn, including an Agent's Session | Native Settings project to Bun config (`src-tauri/src/commands/jarvis_commands.rs:1138`). UI appends the user message, then posts history and native memory references to `/chat/stream`, without a model override (`src-ui/src/features/sessions/useSessionTurn.ts:1832`, `:1958`). `handleChatStreamRequest` → `streamJarvis` (`server-jarvis/src/chat-routes.ts:63`, `server-jarvis/src/index.ts:6739`). | Bun `resolveConfig` uses the server config, or normalizes an optional HTTP `config` against defaults (`server-jarvis/src/index.ts:913`). File load is cached for five seconds; missing/malformed file uses defaults (`server-jarvis/src/config.ts:1128–1160`). | SSE feeds transient route/metrics state; Native surface persists assistant text and terminal-run summary (`src-ui/src/features/sessions/useSessionTurn.ts:1704`, `:1998`). Stage history is not a persisted route plan. |
| Native Session relay | `jarvis_send_message` → `run_jarvis_message` → Bun `/chat/stream` (`src-tauri/src/commands/jarvis_commands.rs:720`, `:925`; `src-tauri/src/jarvis/runner.rs:412`, `:502`). | Same Bun model-selection branches below; this is the fallback transport, not the current UI Chat path. | Native relay events; the current UI posts directly to Bun. |
| Cron, manual or scheduled | Native `run_cron_job` / scheduler → `dispatch_cron_job` (`src-tauri/src/commands/cron.rs:596`; `src-tauri/src/cron_scheduler.rs:1090`, `:2129`). Dispatch validates Agent activation and sends a fresh Session ID, prompt and optional projection snapshot to `/cron/run` (`src-tauri/src/cron_scheduler.rs:1332–1386`). Bun `runCronInference` → shared stream with `surface: "cron"` (`server-jarvis/src/cron-inference.ts:496–549`; `server-jarvis/src/index.ts:6719`). | No model pin is sent. Uses server-wide backend, pool, conductor and delegate settings. Validated projection supplies instructions. The inference-feedback maintenance job is a separate non-inference refresh branch (`server-jarvis/src/cron-inference.ts:454–477`). | Bun drains SSE into output/status/execution evidence. Cron evidence type has no per-stage provider/model trace (`server-jarvis/src/cron-inference.ts:7–21`, `:545–549`). |
| Tool runtime `agent` / background `task_create` | `toolAgent` → `runPromptOnce`; `toolTaskCreate` → `runTask` → same helper (`server-jarvis/src/agent-tools.ts:359–404`, `:500–545`). | **Separate routing authority:** if `claude_cli.enabled`, try CLI first regardless of `active_backend`; error-string result falls through to one HTTP backend request. No coordinator/planner/reviewer pipeline here. HTTP uses llama.cpp when selected, OpenRouter when selected, otherwise Ollama (`server-jarvis/src/agent-tools.ts:640–684`). | Agent tool result or stored task output/status (`server-jarvis/src/agent-tools.ts:379–383`, `:409–427`, `:503–529`), not a stage-route plan. |

An **Agent** is the identity and its Runtime projection; an **orchestrator pool agent** is a separate model-routing record. The Agent card's `model` is stored metadata, not a routing override. Current UI explicitly labels that distinction (`src-ui/src/domain/agent-routing-scope.ts:32–38`). Agent enablement still gates unattended activation (`src-tauri/src/cron_scheduler.rs:1332–1347`); it must not be described as having no execution effect.

## 2. Backend defaults and branch selection

`server-jarvis/src/config.ts:665–714` defines:

- `active_backend`: `llama_cpp`.
- `llama_cpp.model`: `Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf`; machine-specific executable/model paths are blank.
- `ollama.model`: `qwen3.5-9b:latest`.
- `openrouter.model`: `cohere/north-mini-code:free`; fallback enabled, paid configured fallback tail disabled, retries three.
- `orchestrator.enabled`: **true** (`server-jarvis/src/config.ts:807`).
- `claude_cli.enabled`: **true**, proxy authentication, delegate enabled, `delegate_first`, model `auto` (`server-jarvis/src/config.ts:735–760`).

The Session stream resolves and emits a configured `init` model before the later stage pool selection (`server-jarvis/src/index.ts:2185–2201`). This is not proof of who answers.

| Branch | Model choice and fallback |
|---|---|
| Claude CLI | Selected before orchestration (`server-jarvis/src/index.ts:2210`). Proxy mode uses `ollama.model`; subscription mode uses `claude_cli.model` or CLI default (`server-jarvis/src/index.ts:2280–2309`; `server-jarvis/src/claude-cli.ts:291`). Proxy dispatch can target Go, OpenRouter or Ollama (`scripts/claude_cli_proxy.py:451–504`). CLI transport does not prove local inference. |
| Orchestrated | `orchestrator.enabled` enters coordinator/pipeline (`server-jarvis/src/index.ts:2450`). A trivial route can skip coordinator inference but still run the synthesizer through the pool; this is not the separate Direct branch. |
| Direct llama.cpp | Configured `llama_cpp.base_url` and `llama_cpp.model`, without pool-first HTTP fallback (`server-jarvis/src/index.ts:2185–2198`, `:5137–5179`, `:5333`, `:5413–5420`). |
| Direct Ollama | Requested model → active profile → other profiles → shipped aliases → first installed non-embedding model; desired stage override also falls back through this selection (`server-jarvis/src/ollama.ts:39–75`). Endpoint candidates and tool support are resolved separately (`server-jarvis/src/index.ts:1112–1212`). |
| Direct OpenRouter | Requested model → free router → configured fallbacks are catalog-resolved (`server-jarvis/src/index.ts:1215–1238`); when fallbacks are enabled the `agent_loop` label activates the cross-provider cascade, even though orchestration is disabled (`server-jarvis/src/index.ts:5390–5411`). |

History compaction is another inference call, independent of the worker stage list: llama.cpp configured model; Ollama compaction override/resolved model; OpenRouter resolved model (`server-jarvis/src/index.ts:1270–1317`; defaults `server-jarvis/src/config.ts:940–946`). A future route authority must include this auxiliary call.

## 3. Coordinator and stage map

Route-entry order is deterministic short circuit → active TaskPlan continuation → deterministic advisory route → model coordinator (`server-jarvis/src/orchestration/coordinator-route-entry.ts:230–252`). Route normalization, execution requirements and available budget further constrain the pipeline (`server-jarvis/src/orchestration/route-normalization.ts:255–329`; `server-jarvis/src/index.ts:4092–4113`).

In the table, **pool/cascade** means the complete selection and fallback algorithm in section 4, not a guaranteed stage pin. The same stages apply to Session turns and ordinary cron streams.

| Stage | Config key → calling code | Source default / fallback | Current visible attribution |
|---|---|---|---|
| Coordinator (resident conductor) | `orchestrator.conductor.{enabled,kv_backend,base_url,model,fallback_model,fallback_to_api}` → `server-jarvis/src/orchestration/coordinator.ts:359–428` → `persistent-conductor.ts:1050–1123`. | Enabled llama.cpp conductor with the same default Qwen alias; empty fallback model; API fallback true (`server-jarvis/src/config.ts:828–855`). llama.cpp requires that exact model to be served. Ollama conductor probes installed primary/fallback candidates. Expected cold/abort misses take a deterministic route. Other exceptions consult `fallback_to_api`; unavailability can fall through without consulting it. | Local routing source/model is logged by Coordinator (`coordinator.ts:374–378`), outside ordinary HTTP stage-route telemetry. Unavailability callback is progress, not a complete attempt record. |
| Coordinator (API-style) | `orchestrator.agents` → `Coordinator.callModel`, `stageLabel: coordinator` (`server-jarvis/src/orchestration/coordinator.ts:442–469`). | Pool pin Go `deepseek-v4-flash`; pool/cascade can supersede it. Unparseable routing output becomes a deterministic route (`coordinator.ts:473–478`). “API” here names the call path, not a guarantee of cloud inference. | Shared observed-response SSE below, when published by `callModel`. |
| Planner | `orchestrator.agents` → `server-jarvis/src/orchestration/pipeline.ts:1875`. | Go `deepseek-v4-pro` pin. Availability/budget-gated **Ollama** preference runs first, even with llama.cpp selected. Then pool/cascade. | Shared observed-response SSE. |
| Executor | `orchestrator.agents`, plus separate `claude_cli.delegate` → `server-jarvis/src/orchestration/pipeline.ts:3144`, `:3509`. | Go `deepseek-v4-pro` pin; eligible write work can delegate before native loop. Otherwise pool/cascade. Delegate details in section 5. | Shared SSE for native HTTP loop; delegate uses separate attribution and activity records. |
| Reviewer | `orchestrator.agents` → `server-jarvis/src/orchestration/pipeline.ts:4796`. | OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` pin; Ollama preference then pool/cascade. | Shared observed-response SSE. |
| Rewriter | `orchestrator.agents` → `server-jarvis/src/orchestration/pipeline.ts:4476`. | Go `deepseek-v4-pro` pin; pool/cascade. Review repair defaults to one round (`server-jarvis/src/config.ts:818`). | Shared observed-response SSE. |
| Synthesizer | `orchestrator.agents` → `server-jarvis/src/orchestration/pipeline.ts:5021–5038`. | Both Go Flash and Pro have pins; pool order, speed preference and cheap cascade for simple/scoped routes can supersede them. | Shared observed-response SSE; aggregate metrics report only the last published provider/model. |
| Recursive critique | Same stage selector, `stageLabel: recursion_critique` (`server-jarvis/src/orchestration/pipeline.ts:6791`). | No dedicated source stage pin; pool/cascade. Recursion cap two (`server-jarvis/src/config.ts:815`). | Shared observed-response SSE; not an independently configurable canonical stage today. |
| Replan / supervision | Replanning calls Coordinator again (`server-jarvis/src/orchestration/replan-loop.ts:227`); supervision uses resident conductor (`server-jarvis/src/index.ts:4259–4277`). | Replan cap two/turn, six/Session (`server-jarvis/src/config.ts:816–817`); conductor uses its independent target settings. | Supervision attribution hardcodes `ollama` (`server-jarvis/src/index.ts:4264–4268`) despite the llama.cpp conductor path. Do not mistake that field for verified backend truth. |

Pool pin definitions: `server-jarvis/src/orchestration/agent-pool.ts:178–235`.

## 4. Pool selection and cross-provider fallback

1. Configured agents are merged with catalog discoveries. Live catalogs remove retired models; catalog failure preserves configured candidates. Free candidates can be re-enabled, and newly eligible catalog models are added (`server-jarvis/src/orchestration/live-model-catalog.ts:303–355`). Disabling a pool row is therefore not a local-only guarantee.
2. Provider credentials and optional vLLM health constrain eligibility (`server-jarvis/src/orchestration/routable-agent-pool.ts:15–38`; `server-jarvis/src/provider-availability.ts:12–38`, `:53–97`). The live credential state was not read. Config normalization can fill blank cloud keys from environment (`server-jarvis/src/config.ts:1087–1098`).
3. Stage health, failure-memory exclusions and model scorecard exclusions are unioned. The pool receives trial counts/reliability stats (`server-jarvis/src/index.ts:2635–2678`). Scorecard defaults: twenty observations, unfit at at least six samples with at least half errors (`server-jarvis/src/orchestration/model-scorecard.ts:9–98`). Startup seeds recent history (`server-jarvis/src/index.ts:409–415`).
4. `AgentPool.pickFor`: exclusions/learned capabilities → eligible local preference for planner/reviewer → executor no-tool demotion → free/local capacity tier before Go before paid → latency filter → trial → stage pin → scored ranking. High-complexity planner/executor bypass stage pins (`server-jarvis/src/orchestration/agent-pool.ts:478–582`). Trial eligibility is separate from a user setting (`server-jarvis/src/orchestration/model-trial-policy.ts:42–84`).
5. A pool-selected provider **overrides** `active_backend`. Only absence of a pool provider allows the configured llama.cpp target (`server-jarvis/src/index.ts:2691–2726`). Thus current source permits cloud selection under a local Inference backend; no live cloud call was made to prove an actual destination in this mission.
6. The HTTP fallback helper constructs another pool and reselects the first candidate. It does not receive the outer selector's trial/reliability injection. It appends an OpenRouter tail: requested model, preferred free IDs, catalog free IDs, permitted configured fallbacks; catalog failure uses requested/free/configured-free tail (`server-jarvis/src/openrouter.ts:659–737`). `enable_paid_fallbacks=false` filters that configured tail, not the pool's paid candidates.
7. Each candidate supplies its own endpoint/provider (`server-jarvis/src/providers.ts:95–153`). Rate-limit/transient retries are capped per model; advancing models is separate from same-model retry count (`server-jarvis/src/openrouter.ts:1011–1092`). Empty/recoverable-stage retry branches additionally check configured backend (`server-jarvis/src/index.ts:3820–3888`).

The experimental rollout-local filter is not a substitute for enforcement: it explicitly falls back to ordinary selection when no local candidate survives (`server-jarvis/src/orchestration/agent-pool.ts:531–542`). No rollout was run.

## 5. Executor delegate and Agent tool differences

Executor delegate eligibility requires CLI and delegate enablement, proxy authentication, full/write-required work, health and allowed roots; it does not check the selected local backend (`server-jarvis/src/orchestration/claude-delegate.ts:330–364`). Subscription mode is refused by this automated delegate.

`claude_cli.delegate.model` feeds `selectDelegateModel`. Selection considers installed models, proxy/Go availability, verified-write evidence, benches and Session thrash. Repeated thrash promotes through evidence-ranked Go candidates; ordinary auto selection favors Go unless an earned free model has better evidence. Pins are subject to the earlier availability/thrash branches. An empty ordered list returns `minimax-m3`, rather than proving an allowed target exists (`server-jarvis/src/orchestration/delegate-model-select.ts:564–701`). Availability probing enumerates candidates (`:710`); the pipeline records delegate results separately (`server-jarvis/src/orchestration/pipeline.ts:2858–2945`). Defaults include thrash threshold two and thirty-minute expiry (`server-jarvis/src/config.ts:752–759`).

The `agent` tool is not this executor delegate: its CLI-first helper uses general CLI args/authentication, then a single configured-backend HTTP call (`server-jarvis/src/agent-tools.ts:534–574`, `:662–684`). A local-only gate limited to `AgentPool` would miss this path, conductor fallback, compaction and executor delegation.

## 6. What the surfaces currently show

- **Session configured label:** shared `backendLabels` formats the configured engine/model (`src-ui/src/lib/backend-identity.ts:47–63`). Composer warns explicitly that a local backend can route to cloud and fallback attempts may be missing (`src-ui/src/features/sessions/outcome.ts:35–46`; `Composer.tsx:92` in that directory).
- **Session live route:** `stage_route` is built after an HTTP response, including non-OK responses. It has stage/provider/model but no attempt cause, outcome, duration or tokens (`server-jarvis/src/orchestration/inference-route-telemetry.ts:31–49`). Connection failures do not produce this observation. The UI preserves non-consecutive route changes and shows “Observed provider responses”; metrics fallback is explicitly “last-stage route only” (`src-ui/src/features/sessions/useSessionTurn.ts:2210–2243`, `:3053–3061`). A response observation is not proof that that model answered successfully.
- **Session persistence:** assistant append stores text; `record_terminal_run` accepts selected model and aggregate counters/outcome, not a per-stage plan (`src-ui/src/features/sessions/useSessionTurn.ts:1704–1715`; `src-tauri/src/commands/sessions.rs:643–663`). It cannot reconstruct the required fallback history after reload.
- **Inference page:** reads native config separately from saved profiles (`src-ui/src/features/models/ModelsPage.tsx:103–128`). `projectRoutingIdentity` uses configured backend labels and detects profile/config disagreement; it does not consume the turn's observed route (`src-ui/src/features/models/profile-routing.ts:34–47`).
- **Status bar:** reads inference health and displays service/readiness/error-rate/conductor telemetry, not the assistant's answering-model identity (`src-ui/src/features/system/SystemStatusBar.tsx:270–278`, `:430–448`).
- **Agent card:** explicitly says its model field does not select the routing model (`src-ui/src/domain/agent-routing-scope.ts:32–38`). No new card behavior was implemented in Phase 0.
- **Cron:** stored output/status/evidence are not a visible per-stage route trace (section 1).

## 7. Terminal-tail source evidence and measurement safety

The timing object starts **after pipeline return** (`server-jarvis/src/index.ts:4568–4574`). Before terminal delivery the server computes completion/reward, finalizes the run (`:4783`), conditionally awaits learning optimization (`:4849`), conditionally distills a skill (`:4864`), unconditionally proposes tuning for a claimed terminal run (`:4906–4909`), then writes metrics and marks `tail_before_terminal` (`:4912–4954`). Terminal send follows (`:4974`, and subsequent outcome branches).

This is a candidate explanation for a delayed terminal event, not a measured cause of the old 2+2 incident. `tail_before_terminal` is pipeline-return to pre-terminal work, **not** last visible token to terminal. Moving only part of this block without preserving `decideCompletion`/TaskPlan verification would weaken the completion contract.

Learning-off and trajectory-export-off suppress learning effects and trajectory snapshots (`server-jarvis/src/self-tuning/conductor-learning.ts:125–225`), but finalization still stores outcome/reward and evaluates pending tuning outcomes (`server-jarvis/src/self-tuning/run-finalizer.ts:184–213`). The proposal helper has no learning-enabled guard and can persist proposals (`server-jarvis/src/self-tuning/proposer.ts:18–42`). A throwaway home alone isolates data ownership; it does not establish compliance with a no-self-tuning/no-training measurement rule. The unchanged orchestrated entry point was therefore not launched.

Additional isolation requirements: config paths are derived from process home (`server-jarvis/src/config.ts:635–654`); conductor/SessionMemory are process-level (`server-jarvis/src/index.ts:732–751`); startup creates workspace state and can warm the conductor (`:6944–6992`). A request-only override is insufficient. No native launch, cron execution, campaign, self-tuning job or training export was performed.

## 8. Runtime checkpoint and resume gate

- Source-default llama.cpp health probe: **could not connect**.
- Authorized worktree search: no model GGUF or llama-server executable found by the repository glob search.
- Trivial, coding/tool and multi-stage current-source Session turns: **NOT RUN**.
- Actual cloud destination, `tail_before_terminal`, 2+2 terminal outcome, Direct/Orchestrated accepted outcomes/time/tokens: **UNMEASURED**.
- Packaged behavior: **NOT RUN**.

Resume needs an authorized isolated llama.cpp runtime/model and a decision permitting a measurement-only isolation change before the baseline, or an explicitly approved recording boundary. No live configuration or credentials were inspected to discover another target. The route map does not satisfy the real-turn acceptance gate and does not change any routing default.
