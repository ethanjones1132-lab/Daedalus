# Unified Action Registry Workspace



This workspace bootstraps **item 1** from the current automation roadmap: a single, file-backed action registry that can track work across the **Jarvis / home-base platform**, the **JonesinSRC website**, the **PrizePicks / Kalshi / WallSlayer product surfaces**, and **Snitch LLC** without losing provenance, urgency, or approval requirements.



## Why this exists



The file-backed action pattern already proved useful operationally. This workspace turns that pattern into a reusable registry with:



- a normalized cross-project action shape

    10|- separate `active`, `blocked`, and `done` buckets

- a lightweight Python store + CLI for local automation glue

- a seed/example file for current focus surfaces and future adapters



The schema stays generic enough to absorb other systems later without rewriting the core store.



## Workspace layout



```text

workspace/action-registry/

    20|├── data/

│   ├── active.json

│   ├── blocked.json

│   └── done.json

├── examples/

│   └── bootstrap.actions.json

├── schemas/

│   └── action-item.schema.json

├── src/action_registry/

│   ├── __init__.py

    30|│   ├── __main__.py

│   ├── cli.py

│   ├── models.py

│   └── store.py

├── tests/

│   └── test_store.py

└── pyproject.toml

```



## Normalized action model

    40|

Every action is designed to preserve the fields we keep rediscovering across projects:



- `project`

- `source_system`

- `source_area`

- `priority`

- `risk_level`

- `approval_required`

- `acceptance_criteria`

    50|- `dependencies`

- `evidence`

- `result_summary`



## Quick start



From the repo root:



```bash

cd workspace/action-registry

    60|PYTHONPATH=src python3 -m action_registry summary
PYTHONPATH=src python3 -m action_registry validate
PYTHONPATH=src python3 -m action_registry validate --file examples/bootstrap.actions.json
PYTHONPATH=src python3 -m action_registry sync
python3 -m unittest discover -s tests -v
```



If you want to populate the workspace with the bundled focus-surface examples:



```bash

    70|cd workspace/action-registry

PYTHONPATH=src python3 -m action_registry seed --reset

PYTHONPATH=src python3 -m action_registry summary

```



## Current focus surfaces



| Surface | Evidence-backed focus | Common action types |

|---|---|---|

| Jarvis / home-base | build provenance, eval harness, bridge work, platform safety | release guards, regression fixes, verification tasks |

    80|| JonesinSRC website | trust signals, lead capture, funnel truth, conversion work | funnel triage, contact follow-up, checkout investigation |

| PrizePicks Monster / Kalshi Monster / WallSlayer | commercialization and product operations | product tracks, funnel diagnostics, support, publishing |

| Snitch LLC | pool-detection pipeline validation and packaging | data pipeline review, address matching, report generation |



## Adapters and sync

Live adapters map project signals into the normalized schema:

| Adapter | Source signals |
|---|---|
    90|| `jarvis` | stale release binary, missing eval harness, AGENTS.md platform priorities |
| `jonesinsrc-website` | funnel truth, lead capture, repo reachability |
| `snitch-llc` | parcel/output counts, pipeline packaging |
| `jonesinsrc-products` | WallSlayer, PrizePicks Monster, Kalshi Monster product tracks |

Run a full adapter ingest + notification refresh:

```bash
PYTHONPATH=src python3 -m action_registry sync
```
   100|
Scheduled overnight jobs for this rollout live in `jobs/schedule.json`.

## Jarvis UI

Jarvis exposes an **Actions** tab backed by Tauri commands:

- `get_action_registry_summary`
- `get_action_registry_bucket`
- `get_action_registry_alerts`
   110|- `sync_action_registry`

The UI listens for `action-registry://alerts` and shows toasts for escalations and approval-required work.

## What is still open

- confidence scoring automation
- richer live event ingestion (Shopify, support queues, webhooks)
- approval workflow UI beyond toast surfacing
