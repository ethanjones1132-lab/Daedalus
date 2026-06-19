# Action Registry — 4-job overnight rollout

**Date:** 2026-06-17  
**Window:** 03:36 – 10:00 EDT  
**Executor:** Cursor agent (manual scheduled passes)

## Job 1 — Adapters foundation (03:40)

- Added adapter base + Jarvis, JonesinSRC website, and Snitch LLC collectors
- Added `sync` CLI command and `sync-state.json` run tracking
- Added adapter/unit tests (`tests/test_adapters.py`)

## Job 2 — JonesinSRC product adapters (05:30)

- Added `jonesinsrc-products` adapter for WallSlayer, PrizePicks Monster, Kalshi Monster
- Wired ingest pipeline via `action_registry.sync`
- First live sync ingested 7 adapter actions into the registry

## Job 3 — Jarvis summary view (07:30)

- Added `src-tauri/src/commands/action_registry.rs`
- Added `ActionRegistryView.tsx` and **Actions** nav tab in `src-ui/src/App.tsx`
- Frontend build passes

## Job 4 — Notifications + approval gating (09:00)

- Added `notifications.py` and `approval.py`
- Sync refreshes `data/notifications.json`
- Jarvis listens for `action-registry://alerts` and startup alert polling
- Approval-required actions (stale binary rebuild, WallSlayer funnel work) surface as toasts

## Verification

```bash
cd workspace/action-registry
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src python3 -m action_registry sync
PYTHONPATH=src python3 -m action_registry summary
```

```bash
cd src-ui && npm run build
```

## Current registry state after sync

- 13 active actions (seed + adapter ingest)
- 2 approval-required alerts (stale binary, WallSlayer funnel)
- Notifications written to `data/notifications.json`