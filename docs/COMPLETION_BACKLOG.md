# Jarvis home-base — Completion Backlog

Durable backlog of audited gaps/bugs, worked one item at a time to a "luxury"
standard (root-cause fix + defensive edges + verification). The 4 AM / 7 AM
restoration routine reads this file, picks the next unchecked item, implements it,
verifies it, and checks it off. New gap-mapping happens **only** when every item
below is already checked.

Each item: cite the file:line, fix the root cause (not the symptom), add a guard
or test where cheap, and verify (`cargo check` / `bunx tsc` / targeted test) before
checking off.

## Backlog

- [x] **E — Retire remaining stub views** (Phase 1.7, 2026-06-22). SelfImprovementView and
  PrizePicksPanel were no-op placeholders, **orphaned** (not imported/routed in App.tsx —
  no UI-reachable dead path). Both deleted, and the dangling `'self-improvement'`/
  `'prizepicks'` members trimmed from `JarvisSubView`. Decision: PrizePicks is owned by the
  separate `prizepicks-monster` app (not home-base); **SelfImprovement is deferred to the
  Phase-3 intelligence layer** (MASTER_PLAN §5.2) where it will be built for real rather than
  stubbed. *Verified:* `bunx tsc -b` green; no remaining references.
- [x] **Unify the two config stores.** (Phase 1.1, 2026-06-22) SQLite `settings` is now
  the single source of truth; the file store (`~/.openclaw/jarvis/config.json`) is a
  one-way, deep-merged projection the Bun server reads. One canonical write path
  `commands::persist_jarvis_config`; `jarvis_save_config`/`jarvis_switch_backend` route
  through it; boot hydrates from SQLite with a one-time file→SQLite import. *Verified:*
  `cargo check` green; 3 round-trip/migration unit tests in `settings.rs` pass.
- [x] **Unify session stores.** (Phase 1.2, 2026-06-22) SQLite `sessions`/`messages`
  is the single canonical store. The file store (`~/.openclaw/jarvis/sessions/*.json`)
  and its `create/list/delete_jarvis_session` helpers were removed; the `jarvis_*`
  chat-session commands now route through shared `commands::sessions` `&AppDb` helpers
  (`create_session_row`/`list_session_rows`/`delete_session_row`). The Bun server's
  per-session history remains as a runtime message-context cache (a projection, not a
  competing metadata store). *Verified:* `cargo test --lib` 32 pass; warning-free.
- [x] **Extract + unit-test the SSE frame handler** (Phase 1.8, 2026-06-22). All SSE
  parsing/decisioning moved out of the `runner.rs` thread closure into a pure, stateful
  `SseRelay::handle_line` → `SseFrameOutcome`; the I/O loop only maps outcomes to
  `app.emit`. *Verified:* 10 unit tests cover token/reasoning/stage/error/result-
  suppression/`[DONE]`/malformed frames; `cargo test --lib` 31 pass.

## Needs user action (not a code bug)

- ⚠️ **OpenRouter API key is invalid.** The persisted key returns `401 "User not found"`
  from OpenRouter, so every chat fails in the orchestrator (`planner/executor/reviewer/
  synthesizer` all fail). Replace it with a fresh key from https://openrouter.ai/keys in
  the Control view. Also set a valid model — the saved `poolside/laguna-m.1:free` is not a
  real OpenRouter model (use e.g. `nvidia/llama-3.1-nemotron-ultra-253b-v1:free`).

## Done

- [x] **Process supervisor for the 3 boot children.** (Phase 1.3, 2026-06-22)
  New `src-tauri/src/supervisor.rs` runs a 20s watchdog that relaunches Ollama
  (only when it's the active backend), the claude_cli_proxy (:19878), and the
  Bun server (:19877) when a required service is down — reusing the existing
  idempotent spawn helpers. Restarts are bounded (`MAX_CONSECUTIVE_RESTARTS=5`,
  reset on recovery) so a broken dependency can't cause a respawn loop; emits a
  `jarvis://supervisor` heartbeat. Applies the Hermes-gateway watchdog lesson.
  *Verified:* `cargo test --lib` 33 pass (incl. backoff-bound test); warning-free.
- [x] **Build provenance + stale-binary guard.** (Phase 1.4, 2026-06-22) `build.rs`
  embeds git SHA / dirty flag / build time; the `get_build_info` command computes
  staleness against the source tree; `BuildBadge.tsx` shows `v<x> · <sha>` everywhere
  with a loud `⚠ stale` marker when the binary lags HEAD. Replaces the hardcoded
  `APP_VERSION` string. *Verified:* `cargo check` + `bunx tsc -b` green.
- [x] **Reconcile recovery contract mismatches.** (Phase 1.5, 2026-06-22)
  `jarvis_save_companion` confirmed correct (writes `companion.json`). `jarvis_recall_cold_memory`
  was a silent "not wired" stub — now wired to `engine::recall_cold_memory`; cold-memory
  recall is honest (returns resident content; explicit deferred-to-Phase-2 error for
  Drive-offloaded entries instead of silent empty). *Verified:* `cargo test --lib` 31 pass.
- [x] **Audit fix — Create Profile was dead.** `create_profile` (models.rs) takes flat
  args (`name, backend, model, temperature, max_tokens, top_p, engine`); ModelProfilesView
  invoked it with a wrapped `{ profile }` (+ `provider` vs `backend`, no `top_p`), so it
  always failed arg-deserialization. Fixed the invoke to send flat args.
  (`src-ui/src/components/jarvis/ModelProfilesView.tsx`) *Verified:* `bunx tsc -b` green.
- [x] **Wired `jarvis_invoke_skill`.** Proxies to the Bun server `POST /skills/invoke`,
  collects the SSE stream, returns `{ session_id, skill, output }` (404 → "Skill not
  found"). (`src-tauri/src/commands/recovery_stubs.rs`)
- [x] **Wired `jarvis_save_companion`.** Persists full companion state to
  `companion.json` (the file `GET /companion` reads); the Bun `POST /companion` is an
  interaction, not a save. Added `save_companion_state`/`get_companion_path`.
  (`src-tauri/src/jarvis/mod.rs`, `recovery_stubs.rs`)
- [x] **Cleared all clippy lints.** `cargo clippy --all-targets` is warning-free (was 28):
  real fixes (struct-update `..Default`, `clamp`, `checked_div`, `strip_prefix`,
  `sort_by_key`, merged identical branches) + targeted `#[allow]` where a refactor wasn't
  worth the risk (too-many-args, type-complexity, should-implement-trait, dead-code).
  *Verified:* clippy exit 0, `cargo test` 18 pass.


- [x] **Warm the *configured* model, not hardcoded `qwen3:8b`.** `warm_model(model)`
  now takes the configured `ollama.model` name; `start_ollama_and_warm(model)`,
  `spawn_claude_cli_proxy(model)`, and `reconcile_backend_services(backend, model)` all
  propagate it. Boot and backend-switch paths pass `cfg.ollama.model`.
  (`src-tauri/src/lib.rs`, `recovery_stubs.rs`, `jarvis_commands.rs`)
  *Verified:* `cargo check` green.

- [x] **Deep-merge config save.** Added `deep_merge_obj` in `jarvis/mod.rs`; `save_jarvis_config`
  now recursively merges nested objects (e.g. `compaction.ollama_url` is preserved
  across saves instead of being replaced wholesale).
  (`src-tauri/src/jarvis/mod.rs`)
  *Verified:* `cargo check` green.

- [x] **Surface orchestrator/reasoning frames in chat.** `runner.rs` now handles
  `orchestrator_stage` (→ `jarvis://stage`) and `reasoning_step`/`reasoning_chunk`
  (→ `jarvis://reasoning`); `JarvisView.tsx` ChatPanel listens for both events and
  shows a pipeline breadcrumb while the orchestrator is running and a collapsible
  "Thinking…" disclosure panel for CoT text.
  (`src-tauri/src/jarvis/runner.rs`, `src-ui/src/components/jarvis/JarvisView.tsx`)
  *Verified:* `cargo check` green; `bunx tsc -b` green.

- [x] **Surface per-backend readiness in the UI.** Extended `JarvisStatus` struct with
  `bun_server_running`, `bun_server_url`, `claude_proxy_running`, `active_backend`,
  `model`, `openrouter_key_set`; updated `check_jarvis_status` to populate all fields.
  `StatusPanel` in `JarvisView.tsx` now shows per-backend service chips (only required
  services are shown as errors; optional ones are dimmed). `HealthBanner.tsx` updated
  to use the new struct shape.
  (`src-tauri/src/jarvis/types.rs`, `runner.rs`, `JarvisView.tsx`, `HealthBanner.tsx`, `types.ts`)
  *Verified:* `cargo check` green; `bunx tsc -b` green.

- [x] **E — Recover dead stub views (SystemHealthView, SettingsView, ModelProfilesView).**
  SystemHealthView: live subsystem health grid + resource bars (disk/memory) + doctor
  checks via `get_system_health` / `get_doctor_report`. SettingsView: editable key-value
  list of all SQLite settings via `get_all_settings` / `set_setting` with per-row save.
  ModelProfilesView: full CRUD for model profiles via `list_model_profiles` /
  `set_active_profile` / `delete_profile` / `create_profile`.
  (`src-ui/src/components/jarvis/SystemHealthView.tsx`, `SettingsView.tsx`, `ModelProfilesView.tsx`)
  *Verified:* `bunx tsc -b` green.

- [x] **C — Actions populate again.** `read_bucket` now tolerates `{actions:[…]}` /
  bare-array / missing files; `registry_root` resolves the repo via configured path →
  `JARVIS_HOME` → upward CWD walk → compile-time repo root, so a Desktop-launched exe
  still finds `workspace/action-registry`. (`src-tauri/src/commands/action_registry.rs`)
  *Verified:* 3 new parse tests pass (`cargo test commands::action_registry::tests`).
- [x] **B — Memory page loads.** `list_recent_memories` returns the canonical
  `MemoryEntry` shape via `engine::list_memories` (was dropping `confidence`/`tags`, which
  crashed `m.confidence.toFixed(2)`); MemoryView render hardened with `safeTags`/
  `fmtConfidence`/`fmtDate`. (`src-tauri/src/commands/memory.rs`, `MemoryView.tsx`)
  *Verified:* `cargo check` + `bunx tsc -b` green.
- [x] **A1 — Backend-aware boot.** Boot now hydrates the in-memory config from the file
  store (also fixes the Control view reverting to Ollama on restart) and starts Ollama +
  warm **only** when Ollama is the active backend; OpenRouter/Claude-CLI skip it and warn
  on a missing key. (`src-tauri/src/lib.rs`) *Verified:* `cargo check` green.
- [x] **A2/A3 — Backend switch (re)starts servers.** `jarvis_save_config` and the now-real
  `jarvis_switch_backend` call idempotent `reconcile_backend_services` to bring up what the
  selected backend needs. (`jarvis_commands.rs`, `recovery_stubs.rs`)
- [x] **A4 — Real `jarvis_restart_ollama`.** Kills the tracked child, respawns + warms,
  reports readiness. (`recovery_stubs.rs`)
- [x] **D — Chat UI quality restored.** Main Jarvis `ChatMessage` now renders assistant
  replies through `MarkdownRenderer` (code blocks/lists/bold) at readable prose size;
  user/tool stay literal monospace. (`JarvisView.tsx`)
- [x] **Toast spam feedback loop** (prior session): memoized `ToastProvider` callbacks.
  *Verified:* `toast-stability.test.tsx`.
- [x] **Chat overhaul — route through the native Bun server.** `run_jarvis_message` no
  longer shells out to the dead `wsl.exe bun run main.tsx`; it POSTs to the Bun server's
  `/chat/stream` and relays SSE (`stream_event`→token, `result`→answer/error, `error`,
  `[DONE]`/EOF→done), including the orchestrator's aggregate `result` text so turns are
  never blank. (`src-tauri/src/jarvis/runner.rs`, `jarvis_commands.rs`)
  *Verified:* live `/chat/stream` POST returns frames; pipeline runs end-to-end (failing
  only on the invalid user key — see "Needs user action").
- [x] **Config path unified + key persistence.** Tauri config now lives at the native
  `<home>/.openclaw/jarvis/config.json` (was a WSL path the natively-run Bun server never
  read), so the OpenRouter key reaches inference and survives restart. `load_jarvis_config`
  is non-destructive (never overwrites an unparseable existing file) and `save_jarvis_config`
  merges to preserve Bun-only fields. (`src-tauri/src/jarvis/mod.rs`)
  *Verified:* server `GET /config` reports `key_set=True`, `active_backend=openrouter`.
