# Jarvis latency and event-loop report — 2026-07-10

## Verdict

Turn latency is dominated by inference/network waits and stage fan-out, not by synchronous SSE sanitization on Bun's event loop.

The strongest end-to-end proof was a live workspace-read turn after coordinator telemetry was added:

- HTTP wall time: 22,036 ms
- canonical run time: 21,604 ms
- coordinator: 13,366 ms (parse fallback)
- executor: 3,743 ms + 2,195 ms
- synthesizer: 2,150 ms
- recorded stage time: 21,454 ms, or 99.3% of the canonical run
- result: `# Jarvis (home-base)` from a real `CONTEXT.md` read

The same turn therefore spent about 21.5 seconds inside model-backed stages and only about 0.4 seconds outside the canonical run. This is incompatible with the theory that regex or per-chunk JavaScript work is the primary cause of 30–300 second tails.

## Evidence gathered

### Live seven-day telemetry

Source: `C:\Users\ethan\.openclaw\jarvis\self-tuning.db`, exported at `2026-07-10T09:28:23.439Z` to `C:\Users\ethan\.openclaw\jarvis\reports\inference\inference_metrics_20260710_092823.json`.

| Stage | Samples | p50 | p95 | p99 | Max | Success |
|---|---:|---:|---:|---:|---:|---:|
| executor | 106 | 3,472 ms | 21,862 ms | 58,920 ms | 319,483 ms | 91.51% |
| planner | 16 | 31,215 ms | 63,157 ms | 67,155 ms | 68,154 ms | 81.25% |
| reviewer | 33 | 16,626 ms | 24,822 ms | 40,056 ms | 46,794 ms | 96.97% |
| rewriter | 13 | 7,995 ms | 13,599 ms | 15,708 ms | 16,235 ms | 84.62% |
| synthesizer | 58 | 22,440 ms | 132,911 ms | 354,914 ms | 568,400 ms | 81.03% |

Across 58 completed runs in the window, run latency was p50 54,576 ms, p95 273,210 ms, p99 440,283 ms, max 597,568 ms. The synthesizer is the largest tail contributor, followed by planner. The old telemetry omitted coordinator time; this pass makes coordinator a first-class stage and starts the parent run clock before routing so child-stage totals remain coherent.

Model telemetry independently shows the same pattern. `opencode_zen:nemotron-3-ultra-free` had 50 samples with p95 completion time 110,365 ms and p99 152,722 ms. `opencode_zen:north-mini-code-free` had 35 samples with p95 21,468 ms. These are network/model-scale waits, not local regex-scale work.

### Event-loop instrumentation

`perf_hooks.monitorEventLoopDelay` is now available behind `JARVIS_PERF_MONITOR=1`, emits structured interval snapshots, and is readable at `GET /performance/runtime`. During unloaded and serial live turns, five-second windows were typically:

- p50: about 6 ms
- p95: about 6 ms
- p99: 6–21 ms
- max: 21–22 ms

During a workspace-read turn, observed p95/p99 remained in the 6–22 ms range with a 52 ms maximum. A five-request concurrent burst produced 1.691–2.985 second completed turns while one peak window reached p99 225 ms and max 458 ms. That spike is worth watching, but it did not create the historical 30–300 second tail and did not stop the five requests from completing quickly.

Bun's `eventLoopUtilization()` returned zero on this Windows build, so the delay histogram, CPU deltas, request wall time, and persisted stage timings are the authoritative signals.

### CPU profile

A 39.18-second Bun CPU profile was captured and visualized with 0x:

- profile: `C:\Users\ethan\AppData\Local\Temp\jarvis-perf-20260710-051142\jarvis-live.cpuprofile.cpuprofile`
- readable profile: `C:\Users\ethan\AppData\Local\Temp\jarvis-perf-20260710-051142\jarvis-live.cpuprofile.md`
- 0x HTML: `C:\Users\ethan\AppData\Local\Temp\jarvis-perf-20260710-051142\jarvis-live.html`

The Bun profiler incorrectly charged 35 seconds to eight native `Date` samples reached from the monitor snapshot; that attribution contradicts the delay histogram and sampling count and is treated as a profiler artifact, not a code hotspot. The useful synchronous work in the profile was much smaller:

- `readFileSync` through skill discovery: 313 ms self / 626 ms total across 56 reads
- Bun SQLite `run`: 267.8 ms
- OpenRouter free-model classification/normalization: about 200 ms
- `insertStageRun`: 232.9 ms total

The visible-answer sanitizers and regex tool-call cleanup did not appear as meaningful hot functions. Skill discovery and per-row SQLite work are secondary optimization candidates, but neither explains the observed tail.

An abrupt client/profiler run ended with repeated `error: undefined`, but two controlled disconnect tests left the server alive and healthy, including an immediate response disposal during a workspace turn. No disconnect patch was made without a reproducible server defect.

## Changes made

### Simple-turn short circuit

`turn-requirements.ts` now narrowly bypasses the model-backed Coordinator for:

- conversational turns; and
- short direct `answer_only` turns without continuation state, tool-call exemplars, workspace authority, or complex-reasoning markers.

The normal route shape and `PipelineExecutor` contract remain intact: the runtime creates a canonical `synthesizer`-only linear route with `route_source=trivial_short_circuit`. A measured simple turn completed in 3,264 ms with a 2,814 ms synthesizer stage and 2,505 ms first-token latency.

### Closed-loop inference feedback

`automate_inference_metrics.py` now reads the actual self-tuning schema and emits versioned, expiring, atomically replaced policy JSON. It derives:

- routing score and speed/reliability capability deltas from completion duration and success;
- first-token watchdog values only from actual `first_token_ms` observations; and
- p50/p95/p99 stage, model, and run reports.

The Bun runtime validates and clamps the policy, loads it on startup, and reloads it after the stable native cron job `jarvis-system-inference-feedback` runs at `17 */6 * * *`. The native seed uses `INSERT OR IGNORE`, so an operator-disabled job stays disabled. The script is included in Tauri resources, Desktop deployment, and the deployment manifest/hash check.

The live loop exposed an important safety edge: a p95-derived watchdog from only ten observations tightened one model to 12 seconds and produced a live coordinator timeout. The policy now requires at least 20 real first-token observations and uses p99 × 1.25 with the existing bounded 5–55 second range. The regenerated live policy has 11 first-token samples for `opencode_go:deepseek-v4-pro`, so it adjusts routing but does not prematurely tighten that model's watchdog. A subsequent workspace-read turn succeeded in 22.0 seconds.

## Remaining performance work

1. Cache or asynchronously refresh skill candidate discovery instead of performing 56 synchronous reads on a turn.
2. Batch self-tuning writes/analysis off the request completion path.
3. Keep the performance monitor opt-in in normal production, but enable it during incident windows and alert on sustained p99 delay rather than single maxima.
4. Evaluate provider/model routing using the new coordinator-inclusive telemetry before changing any more timeout behavior.

