# Direct vs Orchestrated comparison

This harness runs a fixed, descriptive comparison of Jarvis direct chat and the built-in orchestrator against one explicitly supplied local `llama-server` and GGUF. It records 2 process-cold arithmetic turns, 2 unreported warm-ups, and 24 warm observations arranged as 3 counterbalanced pairs for each of 4 tasks.

The sample is descriptive only. It does not establish general quality superiority. The harness does not start inference during development or tests.

## Current startup gate

The runner inspects the checked-out Bun server source before creating the output directory or spawning a process. This branch currently resolves Bun's default bind to `0.0.0.0` and has no supported host override, so the runner refuses startup. Do not bypass that guard with an environment hint or an external proxy. A future comparison run requires a source version that binds the dedicated Bun children to loopback, plus a separately authorized run with explicit model and binary paths.

## Invocation

From the repository root in PowerShell, after the loopback-bind gate is supported and the local run is authorized:

```powershell
python -m scripts.direct_vs_orchestrated.runner `
  --llama-server 'C:\tools\llama.cpp\llama-server.exe' `
  --model 'C:\models\comparison-model.gguf' `
  --out-dir 'C:\comparison-runs\direct-vs-orchestrated-2026-11-07' `
  --bun 'C:\tools\bun\bun.exe'
```

`--llama-server` and `--model` must be explicit files; the harness never searches model directories or reads the normal Jarvis home. `--out-dir` must be a new or empty directory. Bun is resolved from `PATH` if `--bun` is omitted; its resolved path and hash are recorded. Repeat `--llama-arg=<single-flag-or-flag=value>` only for non-network serving or hardware tuning options. The harness reserves the model, host, port, alias, and RPC flags so extra arguments cannot replace the isolated target.

## Isolation and stop behavior

- The llama.cpp and Bun listeners use loopback ports selected by the harness. Occupied ports abort before spawn. The Bun source guard verifies that its actual bind is loopback.
- Each Bun mode gets a separate temporary home, config file, port, and the same copied fixture. The two configs differ only in `orchestrator.enabled`.
- Child environments are allowlisted. Cloud credentials and proxy variables are omitted; cloud helpers, session memory, learning, trajectory export, distillation, and Claude CLI are disabled in the comparison config.
- SSE and readiness requests use a proxy-free opener that refuses redirects. The capture worker only accepts loopback HTTP.
- A trial stops the campaign if observed routing leaves the local llama.cpp alias, a web tool is attempted, a tool path escapes the fixture directory, the fixture changes, or cancellation cannot be confirmed and settled. The triggering trial and its safety reason remain in the output.
- `Ctrl+C` unwinds the owned process handles. The harness terminates and waits only for processes it started; it does not find or kill processes by name or port. Wait for the command to finish cleanup before reusing the output directory.
- Every turn has a 120-second monotonic cap beginning immediately before capture-worker spawn. A timeout requests `/chat/cancel` for that trial's unique Session and allows at most 5 seconds for cancellation settlement. Partial SSE JSONL is flushed as it arrives.

The 24 warm-turn caps total 48 minutes, with up to 2 minutes of cancellation grace if every warm turn times out. The two process-cold turns each have a separate 120-second capture cap and up to 5 seconds of settlement, in addition to two model readiness windows of up to 120 seconds each. The two unreported warm-ups each have a separate 120-second capture cap and up to 5 seconds of settlement. These are upper bounds, not expected runtimes.

## Output files

- `manifest.json` records source and artifact hashes, exact redacted arguments, hardware facts, config fingerprints, chosen ports, readiness, process IDs and cleanup status, schedule, and campaign status.
- `captures/<mode>/<task>/<observation>.jsonl` preserves raw SSE lines and receipt timestamps.
- `observations.jsonl` contains normalized outcomes and observed route, timing, stage, tool, attempt, token, and fixture fields. Missing telemetry remains `unknown`.
- `rubric.jsonl` contains mechanical checks and subjective review entries. Unreviewed subjective criteria stay `pending`.
- `blind-review-packets.jsonl` contains answers and criteria without mode or pair order. Give reviewers these packets without `blind-review-key.json`; record the reviewer as `agent` or `human`, their identity, scores, and comments in `rubric.jsonl` after scoring.
- `blind-review-key.json` maps blind labels back to observations and should remain separate until the blind review is finished.
- `logs/` contains stdout/stderr from each owned model and Bun process.
- `report.md` summarizes every observation and the per-pair comparisons. Rebuild it from saved evidence with `python -m scripts.direct_vs_orchestrated.report <out-dir>`.

## Reading the report

Warm latency deltas are reported per pair as Orchestrated minus Direct and only when both members succeeded. Failed and timed-out trials remain listed and are not averaged away. Process-cold model readiness and first visible output are separate measurements; “process-cold” does not mean OS page-cache-cold or whole-machine-cold.

The report uses only observed route attribution and token fields. A configured model alias is not substituted for a missing observed route, and generation limits are not substituted for token usage. Treat every `unknown` as missing evidence. Mechanical arithmetic and fixture checks are scored automatically; explanation and planning criteria remain pending until an independent reviewer scores the blind packets. Raw outputs remain in the captures and rubric artifacts.
