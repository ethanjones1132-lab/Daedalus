# Reading the cold-start line (DD-140)

Packaged startup now reports where its time went on one `jarvis::startup` log
line, prefixed `cold-start:`. The stamps are monotonic milliseconds measured
from `run()` entry (`src-tauri/src/lib.rs`, first statement of `run()`, which is
the first line of `main`), so they are offsets, not wall-clock times.

## Where to look

`%LOCALAPPDATA%\com.jarvis.desktop\logs\Jarvis.log` on Windows (the path the
`tauri-plugin-log` plugin owns), or `~/.local/share/com.jarvis.desktop/logs/`
elsewhere. Search for `cold-start:`.

A boot emits one line per stage that is reached. Lines before the last one are
partial: `complete=no`, and stages not yet reached read `missing`. The line with
`complete=yes` is the complete cold-start measurement; a probe should use the
last `cold-start:` line of the run.

## Format

```text
cold-start: complete=yes process_start_ms=0 sidecar_spawn_ms=42 server_health_ms=1840 bootstrap_return_ms=2103 window_shown_ms=964 total_ms=2103 spawn_after_start_ms=42 health_after_spawn_ms=1798 bootstrap_after_health_ms=263 window_after_health_ms=-876
```

| Key | Stage |
| --- | --- |
| `process_start_ms` | `run()` entered, before single-instance handoff, before the DB is opened |
| `sidecar_spawn_ms` | immediately before `process_lifecycle::spawn_managed` for the bundled Bun server |
| `server_health_ms` | first successful `/health` probe (`mark_healthy`) |
| `bootstrap_return_ms` | last boot work done in `bootstrap_services`, just before the cron scheduler loop takes the thread (the function never actually returns) |
| `window_shown_ms` | first finished page load of the `main` webview (`Builder::on_page_load`, `PageLoadEvent::Finished`) |
| `total_ms` | process-relative time when this line was written |

Deltas are signed and derived from the stamps above:

| Delta | Question it answers |
| --- | --- |
| `spawn_after_start_ms` | how much of startup happened before the sidecar was even launched |
| `health_after_spawn_ms` | sidecar launch → first `/health` answer |
| `bootstrap_after_health_ms` | server ready → boot work finished |
| `window_after_health_ms` | server ready → window content shown; **negative** means the window finished loading before the server answered `/health` |

A stage that was never reached renders as `missing`, and every delta that needs
it is `missing` as well. Stamps are first-write-wins, so a supervisor restart or
a page reload later in the same process cannot overwrite the cold-start numbers.

## What the stamps do not mean

`window_shown_ms` is a finished page load, not the OS-level window creation: the
window is created and shown from `src-tauri/tauri.conf.json` before the Tauri
run loop starts, so it is visible before `on_page_load` fires. Treat the stamp
as "the app content is in the window", which is the user-visible finish line.

The five stages are the only points touched. Boot order, sleeps and awaits are
unchanged; the line measures them, it does not reshape them.

## Tests that pin it

`src-tauri/src/startup_readiness.rs` builds the line from recorded stamps
against a mocked clock. Its tests pin the exact string for a complete boot, the
`missing` rendering for a partial boot, first-write-wins, and the field order,
so a future edit cannot drop or silently reorder a stage.
