# Orchestration controls and a local comparison

Status: approved by Ethan on 2026-11-07, with explicit authorization to
implement both remaining tasks. Source inspected at `ba6dab5` on
`astra/daedalus-routing`; approval does not claim implementation.

## Intent and inherited scope

Resume Claude's handoff: keep the routing fixes in `2f611db` and `ba6dab5`,
finish the Orchestration settings, and measure Direct versus Orchestrated
Session turns on the same PC. Make configuration match execution and expose
whether orchestration earns its extra latency. Preserve the Rust/Tauri Native
surface, Bun server, React UI, Tool runtime, and Permission policy.

This supports the current roadmap's reliability interruption. Priority #3
remains active; no memory, learning, workflow, or packaged acceptance gate is
closed by this work. Landing, pushing, replacing an installed build, and
enabling cloud helpers in Ethan's configuration are separate from this scope.

## Existing evidence

- The worktree is clean at `ba6dab5`; its three commits over `master` also
  include the Phase 0 route map (`9e35b89`).
- On 2026-11-07, 62 focused Bun regression tests passed: provider availability,
  route-plan attribution, completion policy, terminal outcomes, and tool-call
  wire format. A fresh full UI run passed 1,961 tests in 194 files. The full
  server run had 3,863 pass, one skip, and one failure in the live background
  command timeout test (`task ... not found`); that entire file subsequently
  passed 10/10 alone. This is not a green full server suite.
- `ConfigPanels.tsx` currently exposes only `orchestrator.enabled`.
- Native `OrchestratorConfig.extra` and the UI's fetched-object draft preserve
  unknown fields. SQLite remains the canonical configuration authority.
- `AgentPool.pickFor` treats `default_for` as a preference, after local-lane,
  tier, trial, and reliability decisions. Exposing it as a guaranteed model
  selection would mislead the user.
- Stage dispatch in `index.ts`, HTTP fallback in `openrouter.ts`, and resident
  routing in `coordinator.ts` currently have separate selection paths.
- `jarvis_save_config` persists/projects configuration and updates Native
  state. It does not positively acknowledge Bun's loaded configuration.
- Claude's capture files survive under `C:/astra-wt/dd-measure/captures`.
  A fresh isolated model/server must be established before new measurements.

## Recommended design

### Settings

Expand the existing Settings -> Orchestration section, using its existing
visual components, draft, Save, and Discard behavior. No new dashboard or
parallel settings authority.

1. **Mode:** Direct or Orchestrated, mapped to `orchestrator.enabled`. Keep the
   current default and affect newly started Session turns only. Direct keeps
   the current Tool runtime; it is not defined as a tool-free raw model call.
2. **Allow cloud helpers:** explicit toggle, false when absent. Explain its
   effect with a local Inference backend. Selecting a cloud Inference backend
   remains an explicit cloud choice. Toggling this draft never enables it
   before Save.
3. **Models by stage:** coordinator, planner, executor, reviewer, rewriter,
   synthesizer. Each row offers Automatic (existing policy) or an explicit
   supported provider/model target. A configured llama.cpp target uses the
   already configured endpoint/model; this does not add multi-model serving
   or reload GGUFs. Unsupported stage transports cannot be offered.
4. **Fallback chain for each stage:** Automatic (existing policy), or a custom
   ordered list of provider/model targets after that stage's primary. An
   explicitly empty custom list disables fallback for that stage.
   Stage primary runs first, then only the eligible configured fallbacks.
   No catalog-discovered or paid tail may silently extend a custom chain.
5. **Test route:** choose a stage and run one bounded, fixed inference probe
   with that draft's route, with tools, learning, delegates, and Session memory
   capture disabled. Return attempted provider/model, outcome, latency,
   fallback reason, and destination classification. Clearly identify a draft
   test; it never saves settings or claims the configuration is deployed.
   Cancellation must propagate to inference; errors must not reveal secrets.

### Routing contract

Add optional typed `orchestrator.stage_models` and
`orchestrator.fallback_chains` fields (both maps keyed by stage). A missing
stage primary uses Automatic; a missing stage fallback list preserves the
automatic fallback policy after the selected primary. Represent targets as
structured provider/model values,
not strings split on colons (model IDs can contain colons and slashes).

A shared stage-route resolver produces the primary and eligible ordered
fallbacks. Explicit selections precede learned ranking, trials, cost-tier
preferences, and cheap/strong cascade choices. Provider availability, cloud
boundary, request cancellation, and finite stage budgets remain enforceable.
Reject malformed targets. If an explicit primary is unavailable or blocked,
report that preflight rejection and advance only through its selected fallback
policy. Recheck availability and the cloud boundary for every candidate. A
custom chain may never re-enter the automatic pool or generic provider tail;
exhaustion is an honest failure. An unavailable primary with an explicitly
empty fallback list fails immediately. Keep preflight rejections separate from
dispatched inference attempts, so blocking a cloud candidate never becomes a
false claim that data left the machine. Automatic mode retains existing
ranking behavior.

Integrate this contract at the stage-dispatch and HTTP-fallback boundaries.
An explicit coordinator selection must also govern the resident-conductor
path, or bypass that path through the same stage dispatch. An explicit
executor must not be replaced by the optional Claude delegate. Existing
per-attempt telemetry and terminal route summaries must describe probes and
normal turns consistently, including failed and cancelled attempts.

Extract/adapt the existing attempt transport behind a narrow config, stage,
abort, and deadline interface shared with the bounded diagnostic endpoint;
do not invoke a full Session pipeline for a probe or implement a second
inference transport. Test route must use this production resolver and dispatch
contract. A health
check or route preview alone must never be presented as a successful model
test. Preserve unrelated and future configuration fields through every save.

After Save, re-read Native configuration and positively check the relevant
Bun runtime routing state: request a reload/readback that returns a non-secret
routing fingerprint, then compare the expected routing fields. This handshake
must not introduce a second configuration write authority. Distinguish
persisted configuration from runtime
acknowledgement and from a successful inference probe. Do not expose keys or
copy the complete secret-bearing config into a diagnostic response.

## Alternatives and tradeoffs

- **Recommended: explicit stage targets plus custom fallback order.** More
  integration work, but each control has a reliable execution meaning.
- **Expose existing pool preferences.** Smaller change, but selections must
  be labelled preferences and can still be overridden. Does not deliver a
  guaranteed model per stage.
- **Only mode and cloud toggle.** Useful interim UI, but leaves stage models,
  fallback control, and route testing unfinished.

## Direct versus Orchestrated measurement

Use dedicated loopback llama.cpp and Bun processes with a new throwaway home,
no cloud credentials, cloud helpers off, learning/distillation/proposal
effects off, and no production workspace binding. Record source SHA, binary
path/hash, GGUF identity/hash, serving alias, full inference flags, effective
redacted config, and hardware. Verify these facts before claiming same-model
comparability. Do not adopt or stop unrelated processes.

Freeze task prompts and acceptance checks before collection: arithmetic,
short code explanation, a tool-using fixture task, and planning without an
implementation request. Give both modes identical prompts, generation limits,
tools, workspace fixture state, and per-turn wall-clock caps. Alternate order
across at least three warm pairs; record cold startup separately. Reset
Session and fixture state per trial and retain raw SSE plus runner evidence.

Report acceptance separately from Jarvis terminal status. Capture time to
first visible answer, terminal latency, last-visible-text-to-terminal delay,
attempt/stage/tool counts, errors, provider/model destinations, and token
counts when available. Missing tokens or missing traces remain unknown.
Keep timed-out and failed trials in the report. Small repeated samples are
descriptive evidence; do not claim broad quality superiority or tune policy
on these tasks. A tool or workspace-binding failure is a failed/blocked
measurement, not grounds to weaken Permission policy.

## Acceptance and limits

- Tests prove explicit models/order are honored, blocked cloud targets cannot
  run, excluded/failed models advance in order, cancellation terminates probes,
  malformed settings fail clearly, and absent settings preserve defaults.
- UI tests exercise draft edits, Save/Discard, failed load/save/readback,
  unrelated-field preservation, model choices, and route-test outcomes.
- Run server/UI typechecks, relevant suites, production builds, and Native
  checks for changed Rust code. Verify rendered settings and a real local
  route probe before calling the feature working.
- Produce a reproducible comparison script, fixtures, raw evidence, and a
  report that includes failures and bounded-stop conditions.
- Source, automated checks, isolated live behavior, and packaged behavior are
  reported separately. Packaged validation stays open unless actually run.

## Builder decisions

Use the existing Settings section rather than a new navigation destination;
retain current orchestration default; include the rewriter stage; keep
Automatic for backward compatibility; custom fallbacks are closed lists;
test one selected stage per click to bound compute. Ethan approved this
recommended design on 2026-11-07.

## Builder check

A read-only Luna review confirmed the main seams and found two ambiguous
contracts: unavailable primaries and fallback scope. This draft resolves them
above: candidate-by-candidate rejection/advance and separate fallback lists
for each stage. The bounded attempt extraction and routing-fingerprint
handshake are implementation choices within the proposed design.
