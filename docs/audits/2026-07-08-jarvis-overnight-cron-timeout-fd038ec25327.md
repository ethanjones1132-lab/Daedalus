# Jarvis overnight cron timeout — fd038ec25327

**Date:** 2026-07-08  
**Job:** `fd038ec25327` — Jarvis overnight maintenance (3am)  
**Kanban:** `t_8b6efebe`

## Summary

The failure is **not** a `server-jarvis` stream or `JARVIS_*` timeout. Hermes cron killed the agent run for **inactivity** after **746s** with no activity heartbeats, against the default **600s** limit (`HERMES_CRON_TIMEOUT`).

**Status (2026-07-08):** `jobs.json` shows `last_status: ok` for the 2026-07-08 03:09Z run; the incident under study is the **2026-07-07** run (`cron_fd038ec25327_20260707_030133`), which failed at ~04:22Z.

## Failure mode (confirmed)

```
TimeoutError: Cron job 'Jarvis — overnight maintenance pass (3am)' idle for 746s (limit 600s)
— last activity: terminal command running (289s elapsed)
```

Source: `%LOCALAPPDATA%/hermes/logs/errors.log` (2026-07-07 04:21:23Z) and cron artifact  
`%LOCALAPPDATA%/hermes/cron/output/fd038ec25327/2026-07-07_04-23-58.md`.

Scheduler log line:

```
iteration=26/80 | tool=terminal
```

Not crash, OOM, or OpenRouter hard error — explicit **inactivity timeout** from Hermes cron scheduler.

## What was running (~746s idle window)

Session `cron_fd038ec25327_20260707_030133` (started 03:01:33Z):

1. **OpenRouter** `nvidia/nemotron-3-ultra-550b-a55b:free` — repeated `ResourceExhausted` / worker limit errors (retries through ~03:51Z).
2. **Health-check `terminal` chain** — multiple invocations hit per-command caps (60s, 180s, 360s, 300s). Longest: **539.71s** wall time, exit 124, `[Command timed out after 300s]` at **04:11:53Z**.
3. **~10 minutes** after that terminal return, scheduler reported **746s** since last activity touch; last description still **terminal command running (289s elapsed)** — activity tracker did not refresh during the latter part of the long terminal wait (likely thread-local activity callback gap in `tools/environments/base.py` `_wait_for_process`, which touches at 10s intervals when callback is set).

The overnight prompt’s health block (`cargo test`, `bun test`, chained `cd` + `tsc`) plus Nemotron rate limits produced a **>80 minute** run with sparse activity updates, exceeding the **600s inactivity** budget.

## Where the 600s limit is defined

| Layer | Location | Knob |
|-------|----------|------|
| **Hermes cron (this incident)** | `hermes-agent/cron/scheduler.py` ~2863–2948 | Env **`HERMES_CRON_TIMEOUT`** (seconds, default **600**). `0` = unlimited. |
| Jarvis Bun chat (unrelated) | `server-jarvis/src/index.ts` | `MODEL_*_TIMEOUT_MS`, `JARVIS_VISIBLE_PROGRESS_TIMEOUT_MS`, `JARVIS_TOTAL_TURN_TIMEOUT_MS` |
| Shadow branch `cron-runtime.ts` | `server-jarvis/src/cron-runtime.ts` | **Not on this path** — Hermes maintenance crons use the Hermes agent + tools, not `runCronRequest()`. |

There is **no** `JARVIS_CRON_TIMEOUT_MS` in this repo. Per-job cron timeout flags are not exposed on `hermes cron edit`.

## Recommended fixes (bounded)

### A. Operator — raise cron inactivity cap (preferred, low risk)

Set on the **gateway / desktop process** that runs the cron scheduler (restart required):

```bash
HERMES_CRON_TIMEOUT=900
```

Rationale: overnight maintenance legitimately runs `cargo test` + `bun test` + implementation; **900s (15 min)** idle budget absorbs OpenRouter retry storms and long terminals without unbounded hangs. Do **not** set `0` unless you accept unlimited stuck jobs.

### B. Operator — align overnight model with day passes

Day Jarvis crons (`876144930517`, etc.) use **`opencode-go` / `minimax/minimax-m3`**. Overnight uses **`openrouter` / `nvidia/nemotron-3-ultra-550b-a55b:free`**, which showed sustained rate-limit errors in logs. Switching overnight to the same provider/model as the 8am pass reduces retry idle gaps (config change on job `fd038ec25327` only).

### C. Upstream — hermes-agent (optional code)

- Ensure **activity callback** stays wired for long `terminal` waits on cron worker threads (see `touch_activity_if_due` in `tools/environments/base.py`).
- Consider reading `cron.inactivity_timeout_seconds` from `config.yaml` if added (today only env is documented in `website/docs/reference/environment-variables.md`).

**Do not merge** shadow `JARVIS_CRON_TOOL_TIMEOUT_MS` on `cron-runtime.ts` for this ticket — wrong runtime.

## Validation after changing `HERMES_CRON_TIMEOUT`

1. Set `HERMES_CRON_TIMEOUT=900` in the environment used to start Hermes gateway/desktop; restart gateway.
2. Confirm: `python -c "import os; print(os.getenv('HERMES_CRON_TIMEOUT'))"` from the same service context shows `900`.
3. Dry run: `hermes cron run fd038ec25327` during a low-traffic window (or wait for 03:00 schedule).
4. Pass criteria: cron output under `%LOCALAPPDATA%/hermes/cron/output/fd038ec25327/` ends **ok**; `errors.log` has no `idle for … (limit 600s)` for that session id.
5. Regression guard: Icarus `fleet-snapshot.json` / `error_jobs` stays 0 for this job id.

## Risks

| Risk | Mitigation |
|------|------------|
| Transient OpenRouter / Nvidia quota spikes | Retries already happen; higher idle cap avoids false kills; monitor `ResourceExhausted` in `errors.log`. |
| Real stuck agent (infinite hang) | Keep cap finite (**900–1200s**), not `0`. |
| Mis-tuning Jarvis SSE timeouts | This incident does not require changing `server-jarvis/src/index.ts` inference knobs. |

## Evidence paths

- Failed run artifact: `%LOCALAPPDATA%/hermes/cron/output/fd038ec25327/2026-07-07_04-23-58.md`
- Successful recovery: `%LOCALAPPDATA%/hermes/cron/output/fd038ec25327/2026-07-08_03-09-54.md`
- Scheduler: `%LOCALAPPDATA%/hermes/hermes-agent/cron/scheduler.py`
- Prior shadow analysis: `%LOCALAPPDATA%/hermes/cron/output/480224b580dd/2026-07-07_13-23-39.md`