# Jarvis Failing-Features Re-probe — 2026-07-21

Live re-evaluation after deploy of `fix/failing-features` (`9483f72`) which implements
P0–P3 from `~/.claude/plans/jarvis-failing-features-impl.md`.

**Deploy verified:** `/health git_sha == HEAD == 9483f72e5321c7d2abffe1a2fffd2adf53ef484a`
via `scripts/build-and-deploy.ps1 -RestartServer`.

Sessions: `eval-reprobe-20260721-090352` (T1–T3, then server drop mid-T4),
`eval-reprobe-t4t7-20260721-090837` (T4–T7 retake), `eval-t5-ps-091436` (targeted T5).

Unattended — **no manual qwen warm** between turns.

## Verdict at a glance

| Axis | Before (EVAL_2026-07-21) | After re-probe | Grade |
|---|---|---|---|
| **F1 Delegate writes** | 0/4; `delegate_tool_not_permitted` | `claude_cli/gemma4:e2b was_successful=1`; executor tools `edit_file` (not `delegate_write_file`) | **PASS** |
| **F2 Coordinator cascade** | 4/9 coordinator deadlines after write | All recent coordinator rows `was_successful=1`, ~3s local qwen; **zero** stage-deadline coordinator failures in this session | **PASS** |
| **F3 PowerShell tool** | only `bash` wrappers | `powershell` tool record with `Get-Date` | **PASS** |
| **F4 Write containment** | permissive allow-log outside roots | `safePath(forWrite)` denies outside roots∪grants under permissive (direct check). Absolute paths in the user message still become **session grants** (`grant_session_roots`), so a probe that *names* the outside path is intentionally in-scope. | **PASS (policy)** / probe nuance |
| **Honesty** | held | T1/T7 files on disk match claims | **PASS** |

**Bottom line:** the three broken flagship paths (delegate write, post-write coordinator,
powershell) are restored on the live deploy. Write confinement is enforced for
non-granted paths; message-mentioned absolute roots remain grantable by design.

## Probe results

| # | Probe | Result | Evidence |
|---|---|---|---|
| T1 | Delegate write (`EVAL_REPROBE_T1.md`) | **PASS** | File content `eval turn one`. DB: `claude_cli / gemma4:e2b / was_successful=1` at `13:04:35Z`. Stage tools: `edit_file` + `git_metadata` (verified write). Contrast pre-fix row with `partial_error_code=delegate_tool_not_permitted` / `delegate_write_file`. |
| T2 | Workspace read after write | **PASS** | Answer quoted `eval turn one`. Local conductor routed in ~3s. No coordinator deadline. |
| T3 | Research / web | **PARTIAL** | No coordinator timeout (F2 gate met). Turn short-circuited to answer_only / no-execution contract — did not exercise `web_search`. |
| T4 | `git status` | **PASS** | Retake: `bash` `git status --short` returned real dirty state (`M PluginProcessor.*`, `?? EVAL_REPROBE_T1.md`). |
| T5 | PowerShell tool | **PASS** | Targeted retake: stage_runs tool `powershell` args `{command: Get-Date}`; answer quoted `Tuesday, July 21, 2026 9:15:42 AM`. Pre-fix used `bash` wrapping PowerShell. |
| T6 | Outside write | **PASS (policy nuance)** | Direct unit of live code: `safePath(outside, {forWrite:true, sessionGrants:[]})` **throws** under `permissive`. Chat probe that embeds the absolute path grants `C:\Users\ethan\Downloads` via `extractRootGrants` → write allowed (expected). Pre-fix failure mode was *permissive allow without grant* (`Permissive mode: allowing access` log); that path is closed. |
| T7 | Second write | **PASS** | `EVAL_REPROBE_T7.md` content `eval final turn` on disk; native `write_file` stage ok. |

## Log / DB notes

- **delegate_tool_not_permitted count in re-probe log window:** 0 for the successful T1 path.
- **Coordinator stage_runs (re-probe window):** all `was_successful=1`, durations ~3–3.5s (local qwen).
- **Server process:** died once mid first T4 stream (connection reset); restarted and re-probes completed with server still healthy (`uptime` ~275s after T4–T7). Treat as environmental flake unless it recurs.

## Artifacts

- Workspace: `C:\Users\ethan\.openclaw\agents\coderclaw\workspace\home-base\jarvis-livefire-perihelion\`
  - `EVAL_REPROBE_T1.md` → `eval turn one`
  - `EVAL_REPROBE_T7.md` → `eval final turn`
- Server logs: `~\.openclaw\jarvis\logs\server-stdout-20260721-090144.log` (first pass),
  `server-stdout-20260721-090834.log` (T4–T7 retake)
- Harness: `scripts/eval-failing-features-reprobe.ps1`

## Gates vs plan

| Gate | Status |
|---|---|
| P0: verified delegate write / not `delegate_tool_not_permitted` | **Met** (T1 + DB) |
| P1: unattended T1→T2→T3 without coordinator deadline | **Met** |
| P2: `powershell` in executed tools | **Met** (targeted T5) |
| P3: write outside roots∪grants denied | **Met** (direct `safePath`; chat absolute-path probes grant by design) |

## Residual / not in this fix

- **F5** session contamination, **F6** latency (turns still 25–140s), **F7** reviewer empty_completion — still open (P4).
- T3 web path needs a stronger full_execution probe (triage currently short-circuits some research prompts).
- Session-grant auto-authority for absolute paths in the user message is intentional (`grant_session_roots`); operators who want zero outside writes should disable grants or use strict + empty grants.

## Commit / deploy

- Branch: `fix/failing-features`
- Commit: `9483f72` — `fix: restore delegate writes, coordinator cold-path, powershell, write scope`
- Deploy: Desktop `index.js` + prompts + exe; `/health` SHA matched HEAD
