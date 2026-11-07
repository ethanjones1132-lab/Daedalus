# Direct versus Orchestrated Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, isolated, local-only comparison of Direct and Orchestrated Session turns using the same llama.cpp model, frozen tasks, raw SSE evidence, and independent acceptance checks.

**Architecture:** A Python standard-library harness owns an isolated llama.cpp server and two Bun server processes, each with a fresh throwaway home and matching configuration except `orchestrator.enabled`. It captures and parses raw `/chat/stream` SSE, runs a frozen four-task corpus in alternating warm pairs, and writes raw records plus a descriptive report to a caller-selected output directory. The harness only terminates child processes it started.

**Tech Stack:** Python 3.11+ standard library (`subprocess`, `urllib`, `json`, `unittest`), Bun server, llama.cpp `llama-server`, JSON fixtures, Markdown report.

**Spec:** `docs/superpowers/specs/2026-11-07-orchestration-controls-design.md` (approved 2026-11-07 for implementation; this plan covers only Direct versus Orchestrated measurement).

## Global Constraints

- Use dedicated loopback llama.cpp and Bun processes with a new throwaway home; no cloud credentials, cloud helpers off, learning/distillation/proposal effects off, and no production workspace binding.
- Record source SHA, binary path/hash, GGUF identity/hash, serving alias, full inference flags, effective redacted config, and hardware; verify before claiming same-model comparability.
- Freeze prompts and acceptance checks before collection; use identical prompts, generation limits, tools, fixture state, and per-turn wall-clock caps.
- Alternate order across at least three warm pairs per task; record cold startup separately; reset Session and fixture state per trial; retain raw SSE and runner evidence.
- Keep failures and timeouts in the report; token counts without source fields are `unknown`; report acceptance separately from Jarvis terminal status.
- Use a **120,000 ms total wall deadline per turn**, identical in both modes and enforced by a parent watchdog; socket inactivity timeouts alone do not satisfy this bound.
- No app launch, config edit, service adoption/termination, cloud inference, production workspace binding, or source/config mutation outside the comparison output directory.
- Use explicit child-process environment maps; do not mutate the parent process environment or repurpose a shell `HOME` variable.
- Do not change Permission policy to make a task pass. A tool/workspace failure is a failed or blocked trial.

## Review Focus

- The native relay treats `message_stop` as nonterminal and may surface the aggregate `result` as the first visible answer when no `stream_event` was emitted; parser tests must prove both behaviors.
- Prior capture output showed `first text None` and `terminal None`: the old parser searched for `token`/`text`/`delta` and terminal names instead of the actual `stream_event.delta.text`, `message_stop`, and `result` frames.
- An occupied port, stale/foreign endpoint, or process that cannot be tied to a child handle must abort before capture and must never be terminated by name or port.
- Any observed cloud/non-llama.cpp destination, changed model alias, tool escape from the fixture, or changed fixture hash invalidates comparability and stops further trials.
- Missing `orchestration_metrics`, tokens, route summaries, or actual destination evidence remains unknown; never fill it from a configured value and present it as observed.
- The direct Agent Loop currently has no per-turn `route` in its terminal result. This plan depends on settings-plan Task 2 adding direct-path per-attempt destination attribution. Refuse a comparability pass when any turn lacks that observation; do not infer the actual route from `active_backend` alone.

## Files and Responsibilities

- Create `scripts/direct_vs_orchestrated/__init__.py` — package marker for standard-library tests.
- Create `scripts/direct_vs_orchestrated/tasks.json` — immutable four-task prompts, generation limits, and acceptance rubric IDs.
- Create `scripts/direct_vs_orchestrated/fixtures/stock.csv` — read-only fixture used only by the tool task.
- Create `scripts/direct_vs_orchestrated/sse_capture.py` — SSE frame parser, first-visible/terminal timing, route/metrics extraction, and JSONL writer.
- Create `scripts/direct_vs_orchestrated/capture_worker.py` — one supervised total-deadline turn capture; writes partial SSE evidence before exiting.
- Create `scripts/direct_vs_orchestrated/runner.py` — provenance, config/home setup, process ownership, paired schedule, subprocess cleanup, and run manifest.
- Create `scripts/direct_vs_orchestrated/report.py` — pair summaries, independent acceptance results, unknown fields, failure inclusion, and Markdown output.
- Create `scripts/direct_vs_orchestrated/test_sse_capture.py` and `test_runner.py` — offline parser and scheduler/provenance/cleanup tests using fake streams/processes.
- Create `scripts/direct_vs_orchestrated/README.md` — prerequisites, explicit command, isolation boundaries, artifact layout, and interpretation limits.

## Interfaces

- `sse_capture.capture_turn(base_url: str, *, session_id: str, task: dict, wall_cap_ms: int, out_path: Path) -> dict` posts one request to `/chat/stream`, timestamps every `data:` frame relative to request start, preserves every raw JSON frame in JSONL, and returns one structured observation. It uses the request timeout and cancellation path; EOF without `result`, `error`, or `cancelled` is a transport failure, not success.
- `sse_capture.summarize_events(events: list[dict]) -> dict` recognizes `stream_event.delta.text` as streamed visible output; if none appears, a nonempty `result.result` with `is_error:false` is first visible at the `result` timestamp (the native aggregate-result path, including partial answers). `message_stop` is recorded but never closes the turn. `result`, `error`, and `cancelled` define terminal outcomes.
- The SSE parser consumes the actual Bun wire vocabulary: `stream_event` carries user-visible `delta.text`; `orchestrator_stage`, `stage_route`, `route_attempt`, and `orchestration_metrics` are observations; `message_stop` precedes the authoritative `result` and is not completion. A nonempty partial result with `is_error:false` is also visible at its result timestamp.
- `runner.child_env(home: Path, *, port: int, workspace: Path) -> dict[str, str]` builds an allowlisted environment for one Bun child; cloud credential variables are absent, and all home/app/config/cache paths point inside the task-specific isolated home.
- `runner.run_comparison(args) -> Path` requires explicit `--llama-server`, `--model`, and `--out-dir`; writes `manifest.json`, `captures/<mode>/<task>/<pair>.jsonl`, `observations.jsonl`, and `report.md`. It fails closed on incomplete provenance or unowned/unhealthy processes.
- The manifest records `source_sha`, `source_tree_sha256`, `llama_server_path`, `llama_server_sha256`, `gguf_path`, `gguf_sha256`, `served_alias`, `llama_argv_redacted`, `bun_path`, `bun_sha256`, `bun_argv_redacted`, `hardware`, `generation_defaults`, `mode_config_fingerprints`, `ports`, and `readiness`.
- `report.build_report(manifest: dict, observations: list[dict], rubric_results: list[dict]) -> str` reports per-task paired differences and all failures without a blended quality claim.

## Frozen Corpus

`tasks.json` contains exactly four stable task IDs. Prompts and checks are frozen before any captured run:

1. `arithmetic`: “What is 17 plus 25? Reply with the integer only.” Acceptance: normalized answer is exactly `42`.
2. `code_explanation`: “In at most three sentences, explain a Python list comprehension, mention optional filtering, and give one short example that squares 0 through 4.” Blind rubric: correctly explains mapping an expression over an iterable (0/1), describes optional filtering (0/1), and includes a valid concise example (0/1); score each item 0/1, preserve the text and score separately.
3. `fixture_tool_read`: “Use the file-reading tool to read `stock.csv`. Return the product with the highest in-stock quantity as `name: quantity` only.” Fixture rows are `apple,8`, `beans,14`, `rice,9`; acceptance requires `beans: 14`, at least one successful `read_file` tool result, zero failed tool results, and an unchanged fixture SHA-256.
4. `planning_no_implementation`: “Give exactly four ordered planning steps for a lunch pickup flow. Cover menu choice, payment, kitchen order, and pickup notice. Do not write code or implement anything.” Blind rubric scores each required element 0/1, checks for exactly four ordered steps, and checks the response contains no code block or file/tool writes.

Use the same request body shape, prompt bytes, per-task `max_tokens`, `temperature`, `top_p`, empty history, and tool policy for both modes. Freeze generation values in `tasks.json`; assign unique Session IDs per observation and do not reuse them across pairs. Each mode gets a separate isolated home and server but the same fixture content and `jarvis_path`.

## Tasks

### Task 1: Freeze the comparison corpus and acceptance evidence

**Files:** Create `scripts/direct_vs_orchestrated/tasks.json`, `scripts/direct_vs_orchestrated/fixtures/stock.csv`, `scripts/direct_vs_orchestrated/test_runner.py`.

- [ ] **Step 1: Add corpus contract tests.** Add `test_corpus_has_four_fixed_task_ids`, `test_fixture_task_expected_answer_matches_fixture_data`, and `test_all_tasks_define_generation_limits_and_acceptance_ids`. Assert the exact IDs, tool fixture answer, and nonempty explicit acceptance criteria.
- [ ] **Step 2: Run the offline tests.** Run `python -m unittest discover -s scripts/direct_vs_orchestrated -p 'test_*.py' -v`; expected: the new corpus checks fail until both JSON and fixture are present.
- [ ] **Step 3: Write the frozen corpus and fixture.** Put prompts, per-task token limits, deterministic checks, and blind rubric criteria in JSON. Do not change task wording after the first recorded capture.
- [ ] **Step 4: Re-run the corpus tests.** Expected: every task and fixture assertion passes; no model process is started.
- [ ] **Step 5: Commit the frozen-corpus milestone.** Commit only the corpus, fixture, and offline contract tests after they pass.

### Task 2: Parse the real Bun SSE contract correctly

**Files:** Create `scripts/direct_vs_orchestrated/sse_capture.py`, `scripts/direct_vs_orchestrated/capture_worker.py`, `scripts/direct_vs_orchestrated/test_sse_capture.py`.

- [ ] **Step 1: Write frame parser tests.** Name tests `test_stream_event_delta_text_starts_first_visible_clock`, `test_reasoning_and_stage_frames_do_not_count_as_visible`, `test_message_stop_is_nonterminal_until_result`, `test_result_without_stream_deltas_is_visible_at_result_time`, `test_result_only_partial_is_visible_at_result_time`, `test_error_result_text_is_not_answer_text`, `test_partial_and_error_result_are_not_success`, `test_cancelled_is_terminal`, `test_eof_without_terminal_is_transport_failure`, and `test_route_and_metrics_missing_remain_unknown`.
- [ ] **Step 2: Run parser tests red.** Run `python -m unittest scripts.direct_vs_orchestrated.test_sse_capture -v`; expected: parser interface is missing and all named tests fail.
- [ ] **Step 3: Implement `parse_sse_data_line(line: str) -> dict | None` and `summarize_events(events)`.** Parse only `data:` JSON frames; retain each frame and monotonic receipt time. Compute first visible from `stream_event.delta.text`, or from nonempty `result.result` with `is_error:false` (success or partial) only when no visible delta occurred. Never count text attached to an error result or error frame as answer text. Record `message_stop_ms` separately; terminal outcome comes from `result.subtype`/`is_error`, `error`, or `cancelled`. Preserve subtype/code/reason, route attempts, `answered_by`, direct-path route attribution, orchestration metrics, tool-use/result counts, and raw frames. Missing data stays null/unknown.
- [ ] **Step 4: Run parser tests green.** Expected: all named cases pass, including a `message_stop` followed by an error `result` remaining an error.
- [ ] **Step 5: Add capture timing tests.** Assert first-visible time, terminal-result time, last-visible-to-result delay, and total wall time are calculated from frame timestamps rather than the old event-name heuristics.
- [ ] **Step 6: Add the capture worker.** Implement a CLI entrypoint that takes explicit base URL, session ID, task JSON path, output path, and wall cap, invokes `capture_turn`, flushes each frame to JSONL, and exits nonzero for transport failure. It must not spawn app/server/model processes or read configs.
- [ ] **Step 7: Commit the parser milestone.** Commit `sse_capture.py`, `capture_worker.py`, and their tests after all offline parser checks pass.

### Task 3: Build an isolated process harness with ownership and provenance

**Files:** Create `scripts/direct_vs_orchestrated/runner.py`, extend `test_runner.py`.

- [ ] **Step 1: Write fake-process/environment tests.** Name tests `test_child_env_has_only_isolated_paths_and_no_cloud_credentials`, `test_unavailable_or_occupied_loopback_ports_abort_before_spawn`, `test_runner_starts_only_owned_children_and_terminates_only_their_handles`, `test_mode_configs_differ_only_by_orchestrator_enabled`, `test_source_fingerprint_covers_dirty_and_untracked_inputs`, and `test_missing_model_or_binary_hash_refuses_comparability`.
- [ ] **Step 2: Run runner tests red.** Run the focused unittest module; expected: each new runner interface is missing.
- [ ] **Step 3: Implement provenance and child setup.** Record git source SHA plus a deterministic hash of all tracked diff content and every non-ignored untracked file (or refuse the run if that source inventory is incomplete); hash the llama-server executable and GGUF. Record executable paths, exact redacted argv/flags, alias, hardware facts available from standard OS queries, config fingerprint, chosen loopback ports, process IDs, and readiness observations. Require explicit paths; never scan user model directories or load real-home config.
- [ ] **Step 4: Implement isolated configs and process lifecycle.** Create unique homes under a new empty `--out-dir`; write minimal Bun config overlays with `active_backend=llama_cpp`, the exact isolated server URL/alias, `claude_cli.enabled=false`, `orchestrator.allow_cloud_helpers=false`, empty cloud credentials, `orchestrator.session_memory.enabled=false`, `orchestrator.conductor_learning.enabled=false`, `orchestrator.conductor_learning.trajectory_export=false`, `orchestrator.skill_distillation.enabled=false`, and the fixture as `jarvis_path`. Proposals are suppressed through the existing proposer learning-enabled guard; do not invent a separate unsupported config flag. Keep the same tools/policy in both modes; disable web tools with the existing Tool runtime policy, and record any attempted web-search/fetch call as a task failure. Direct and Orchestrated configs must compare equal after removing only `orchestrator.enabled`. Build environment dicts from an allowlist and set profile/app/cache/temp paths to that mode's isolated home. Bind llama.cpp and Bun to loopback only; refuse to use an occupied port. Verify each owned Bun `/health` and `/config` reports the intended mode/backend without logging the config or secrets; verify llama.cpp's served alias before capture. Keep `Popen` handles and terminate/wait only those handles on success, failure, timeout, or Ctrl+C.
- [ ] **Step 5: Verify offline harness tests.** Expected: all ownership, environment, provenance, and config-difference assertions pass without spawning llama.cpp or Bun.
- [ ] **Step 6: Commit the isolation milestone.** Commit only the process/config/provenance harness and its tests after offline checks pass.

### Task 4: Capture paired turns and independent acceptance

**Files:** Extend `runner.py`, `sse_capture.py`, `capture_worker.py`, `test_runner.py`.

- [ ] **Step 1: Write schedule and failure-inclusion tests.** Name tests `test_warm_schedule_has_three_pairs_per_task_and_counterbalances_order`, `test_cold_start_observations_are_separate_from_warm_pairs`, `test_cold_means_llama_process_and_kv_cold_not_os_cache_cold`, `test_failed_timeout_and_blocked_trials_are_retained`, `test_direct_and_orchestrated_attempts_have_observed_local_route_attribution`, `test_observed_alias_matches_for_every_attempt`, `test_fixture_hash_is_checked_before_and_after_each_tool_trial`, and `test_no_session_or_fixture_state_is_reused_between_observations`.
- [ ] **Step 2: Implement the exact schedule.** Record two separately labeled process/KV-cold arithmetic turns, restarting only the harness-owned llama.cpp process between modes so each first inference starts with an unloaded model/KV state. Label these “process-cold”; do not call them OS/page-cache or whole-machine cold. Record model process-ready and first-output times separately. Then run 3 warm Direct/Orchestrated pairs for each of the 4 tasks in order Direct→Orchestrated, Orchestrated→Direct, Direct→Orchestrated. Run one unreported warm-up per mode before those pairs. Reset Session IDs, raw history, and fixture baseline for every turn.
- [ ] **Step 3: Implement the exact total-turn cap.** Set a fixed 120,000 ms monotonic deadline from immediately before capture-worker spawn through the authoritative terminal frame. At deadline, mark the trial `timeout`, send `/chat/cancel` to that isolated server for the trial's unique Session, and allow at most 5,000 ms for cancellation settlement. Do not start another paired trial unless cancellation is confirmed; if not confirmed, stop the campaign, terminate only owned children, and mark the report incomplete. Preserve partial JSONL. Do not treat per-read/socket inactivity timeout as the task deadline. Warm-turn inference upper bound is 48 minutes; disclose cancellation grace plus separate cold and warm-up bounds.
- [ ] **Step 4: Implement capture safeguards.** Apply identical request body and generation settings. Save raw SSE and all frame timestamps before summarizing. Stop further captures if route attribution shows cloud or a non-llama.cpp provider, unexpected alias, web tool use, escaped tool path, or mutated fixture; keep the triggering trial and reason in evidence.
- [ ] **Step 5: Run schedule tests.** Expected: schedule is 24 warm observations, two process-cold observations, and two warm-ups; every failure record remains present and no test calls a live service.
- [ ] **Step 6: Implement independent acceptance.** Apply exact arithmetic and fixture checks mechanically. A reviewer independent of the answering Jarvis Session scores explanation/planning outputs with mode and pair order hidden; this can be a separate reviewing agent or a human and does not require Ethan to perform routine scoring. Record reviewer identity/type, criteria, observation IDs, and blind labels; distinguish agent assessment from human assessment. Do not ask the answering model to grade itself or invent missing scores: report unscored rubric entries as `pending`. Preserve comments and raw output. Assert the fixture task used `read_file` successfully, tool call/result counts agree where trace data exists, and fixture hashes match.
- [ ] **Step 7: Commit the paired-capture milestone.** Commit the collection schedule, acceptance recorder, and offline tests after schedule checks pass.

### Task 5: Produce descriptive report and operator instructions

**Files:** Create `scripts/direct_vs_orchestrated/report.py`, `scripts/direct_vs_orchestrated/README.md`; extend tests.

- [ ] **Step 1: Write report tests.** Name tests `test_report_includes_every_failed_and_timed_out_trial`, `test_report_shows_pairwise_latency_and_acceptance_separately`, `test_unknown_token_and_route_fields_are_not_imputed`, `test_report_includes_provenance_and_redacts_credentials`, and `test_small_sample_is_labeled_descriptive_only`.
- [ ] **Step 2: Implement report output.** Emit `manifest.json`, raw SSE under `captures/`, normalized observations JSONL, rubric JSONL, and `report.md`. For every task show paired Direct/Orchestrated wall time, first visible time, last-visible-to-terminal delay, terminal outcome/code/reason, stage/tool/attempt counts, observed route, and token fields only when present. Include cold timings separately, failures/timeouts, acceptance scores, sample size, and descriptive-only limitation. Never average failures away or claim general quality superiority.
- [ ] **Step 3: Document invocation and cleanup.** README must show explicit `--llama-server`, `--model`, a new empty `--out-dir`, and any required serving flags; explain output artifacts, local-only gates, safe stop/cleanup, and interpreting `unknown`. Refuse startup if no current binary/model is explicitly supplied or provenance cannot be hashed.
- [ ] **Step 4: Run all offline checks.** Run `python -m unittest discover -s scripts/direct_vs_orchestrated -p 'test_*.py' -v`; expected: all tests pass with no network/model calls. Then run `python -m compileall -q scripts/direct_vs_orchestrated`; expected: clean.
- [ ] **Step 5: Commit report milestone.** Commit report generation, README, and tests after checks pass.

## Completion Gate

- [ ] The harness and parser tests pass without inference.
- [ ] A separate authorized local run produces complete provenance, isolated server/home paths, owned-process cleanup evidence, raw SSE, all 24 warm observations, cold observations, and an outcome record for every task/mode/pair.
- [ ] Parser reports the real `stream_event.delta.text` timing and treats `message_stop` as nonterminal; result-only aggregate answers are timed at `result`.
- [ ] Every turn is verified local and on the same serving alias; any mismatch stops the campaign and is reported as a failed comparability gate.
- [ ] Independent acceptance and runtime terminal status remain distinct. Missing token, route, or trace values remain `unknown`.
- [ ] The report states this is a small descriptive comparison and does not close any roadmap priority or packaged acceptance gate.

## Execution Boundary

Ethan approved implementation of both the settings controls and this comparison on 2026-11-07. This plan-writing turn did not launch a process or perform inference. During execution, reverify explicit binary/model paths and isolation before each run; stop without touching unrelated processes if any prerequisite fails. Commits are limited to the independently verified plan milestones above; pushing, merging, installing, or changing Ethan's live configuration remain outside scope.
