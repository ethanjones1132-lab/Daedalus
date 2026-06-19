# Action Registry — Agent Operating Guide

## Daily loop

```bash
cd workspace/action-registry
PYTHONPATH=src python3 -m action_registry sync
PYTHONPATH=src python3 -m action_registry brief --format markdown
PYTHONPATH=src python3 -m action_registry next
```

## Lifecycle

| Intent | Command |
|--------|---------|
| Start work | `start <id>` |
| Approve side effects | `approve <id>` |
| Waive approval | `approve <id> --waive` |
| Block with reason | `block <id> --reason "..."` |
| Complete | `done <id> --result "..."` |
| Cancel | `cancel <id> --reason "..."` |

## Rules

1. Prefer `track_key` identity — one canonical row per `project:source_area`.
2. Adapters emit **signals** that merge into existing **tracks**; do not create parallel product/website rows.
3. Use `next` to pick work; skip items that fail approval gating.
4. After completing work, always `done` with a `result_summary`.
5. Run `dedupe --dry-run` before bulk migrations.

## Concepts

- **track** — long-lived surface record (seed/bootstrap)
- **signal** — ephemeral adapter condition (stale binary, missing eval file)
- **task** — manually created execution item