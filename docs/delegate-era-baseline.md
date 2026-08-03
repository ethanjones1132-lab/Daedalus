# Delegate-era baseline (W2.3)

Reference line for conductor / delegate write-path health across the
**good era (≈2026-07-25)** and the **degraded era (≈2026-08-01 → 08-02/03)**
that motivated the Stage 6 durable layer (W1–W3).

This document does **not** replace live SQLite numbers. It freezes the plan
baseline and scoreboard seeds so the dial (W2.1 attribution fix + W2.2 volume
metrics) has something fixed to compare against.

## Plan baseline (2026-08-01 diagnosis)

Source: `docs/superpowers/plans/2026-08-01-conductor-performance-completion-integrity.md`
§ Measured Baseline and Release Targets.

| Metric | Baseline (degraded window) | Release target |
|---|---:|---:|
| Six-run aggregate duration | 23.41 min | ≥30% lower on a comparable fixture |
| Executor share | 73.8% | below 60% |
| Executor no-tool turns | 49.2% | ≤ 10% |
| No-tool executor time | 7.30 min | ≤ 1.5 min per six comparable runs |
| Delegate verified-write rate | 0/6 | ≥ 8/10 live write fixtures |
| Successful write runs with `check_tier=none` | 3 false-success candidates | 0 |
| False-complete multi-item runs | observed | 0 |
| Duplicate semantic write pressure | 5 recent replay violations | 0 |

## Era comparison (qualitative + scoreboard seeds)

| Era | Window | Delegate path character | Write evidence (seeds) |
|---|---|---|---|
| **Good** | ~2026-07-25 | Anthropic-native Go (`minimax-m3`) via Claude CLI proxy; `claude_cli` attributions present; cleanup marker sparse | `minimax-m3`: 123 attempts / 118 verified ≈ **96%** |
| **Degraded** | ~2026-08-01 → 08-02/03 | Proxy down / free-pool thrash; tool-incapable free models; cleanup often present without a same-row write | Free pool (tool-capable lanes): ~33 attempts / ~9% verified |

Scoreboard seeds live in `server-jarvis/src/orchestration/delegate-model-select.ts`
(`DELEGATE_WRITE_SCOREBOARD_SEEDS`). Selector ranking (W1.1–W1.3) and the
W1.4 permanent pins keep `minimax-m3` preferred over the free pool when Go
is available.

### Why the dial was wrong before W2.1

Older metrics only counted delegate runs when `delegate_cleanup` appeared in
`tool_calls_json`. Good-era minimax rows rarely emitted that marker, so the
healthy era looked as empty as the dead-proxy era. W2.1 uses
`model_attributions.provider === "claude_cli"` as the primary signal and only
credits writes on the **delegate stage row** (no same-run native-fallback
credit).

W2.2 adds first-class volume metrics on top of that identity fix:

- `writesLandedPerRun` — average successful write-tool calls per run
- `taskTargetWrites` — successful writes on non-status paths (or matching
  fixture `taskTargets` when provided)

## How to re-run the benchmark

From `server-jarvis/` against the live evidence store
(`~/.openclaw/jarvis/self-tuning.db`):

```powershell
Set-Location C:\Projects\home-base-recovered\.worktrees\alright-buddy-full-force\server-jarvis

# Full recent window (release gate)
bun scripts/benchmark-conductor-completion.ts --limit 500 --json

# Date-sliced windows (era comparison)
bun scripts/benchmark-conductor-completion.ts --since 2026-07-25T00:00:00Z --limit 200 --json
bun scripts/benchmark-conductor-completion.ts --since 2026-08-01T00:00:00Z --limit 200 --json
bun scripts/benchmark-conductor-completion.ts --since 2026-08-02T00:00:00Z --limit 200 --json

# Layer-1 replay invariants (includes W1.4 delegate_benched_model_selected when fixtures supply benchedModels)
bun scripts/replay-conductor.ts --limit 500 --json
```

Human-readable (non-JSON) output also prints `writes landed per run` and
`task-target writes` after the gate axes.

## Related durable pins

| Item | Where |
|---|---|
| W1.4.1 selector pins (minimax vs free; proxy-up Anthropic Go) | `server-jarvis/src/orchestration/delegate-model-select.test.ts` |
| W1.4 replay invariant `delegate_benched_model_selected` | `server-jarvis/src/eval/conductor-replay.ts` |
| W2.1 claude_cli attribution + same-row write credit | `server-jarvis/src/eval/conductor-performance.ts` |
| W2.2 volume metrics | same module + `scripts/benchmark-conductor-completion.ts` |
| W3.3 per-model tool format (`native` / `text_xml` / `dsml` / `unknown`) | `server-jarvis/src/model-tool-format.ts` |

**Out of scope here:** W3.4 routing by no-tool rate (TODO on the capability
record); live-fire re-proof after deploy.
