# Daedalus startup — findings, evidence and fix plan

**Date:** 2026-10-21
**Subject:** Cold start of the Daedalus/Jarvis Tauri app (`home-base.exe`) on Windows 11 — process launch → window painted → Bun server healthy → inference backend ready.
**Status:** Findings only. **No source file was changed** to produce this document.
**Measured on:** the dev box (`C:\Projects\home-base-recovered`, `C:\Users\ethan`), packaged app + `src-tauri/target/debug/home-base.exe`, Bun 1.3.12, Rust 1.85+ toolchain, Python 3.14, WSL2 present but its VHDX is **not attachable** on this box (`Access is denied` on `E:\Data\wsl-ubuntu\ext4.vhdx`) — see DS-13.
**Coverage:** the native Rust surface (`src-tauri/`), the Bun server (`server-jarvis/`) and the React UI (`src-ui/`).
**Relationship to existing work:** this document **extends** `DD-023` in `C:\Projects\ops\backlogs\daedalus.md` (packaged app ~19 s slower than its own server needs). DD-023 owns the *measurement* of the packaged cold start; this document owns the **causes** behind that 19 s, plus the rest of the boot path. Findings here are numbered `DS-01…DS-nn` and should be filed into `ops/backlogs/daedalus.md` as new `DD-0xx` items (mapping table in §6).

---

## How to read this

| Legend | Meaning |
|---|---|
| **MEASURED** | Timed on this machine with the command/measurement shown in the finding. |
| **READ** | Established by reading source. The file:line is the proof; the cost is inferred, not timed. |
| **UNCONFIRMED** | A hypothesis that needs a measurement this document did not perform. |

Severity is about **startup experience**, not correctness:

| Severity | Meaning |
|---|---|
| **S1** | Directly adds seconds to a cold start, or makes the app look broken while it starts. |
| **S2** | Adds hundreds of ms / repeated subprocess or socket work; wasteful and noisy but not usually user-visible. |
| **S3** | Hygiene, correctness of a diagnostic, or a latent trap. Cheap to fix, no user-visible cost today. |

Every finding carries a **Proposed fix** and a **Suggested check** so it can become a worker brief without re-deriving the analysis.

---

## How to use this document

**For the right hands (worker fleet).** Each finding is self-contained: it states the symptom, the exact file:line, the measurement (or the explicit note that it is unmeasured), a proposed fix and a check command. A brief can be written as:

> **Where you work:** `<repo>`, files `<file>:<line>` only. **Finish-line item:** `<DD-0xx>`. **Do:** `<the Proposed fix, verbatim>`. **Check:** `<the Suggested check, verbatim>`. **Do not:** touch files outside the listed scope. **Source:** `docs/audits/2026-10-21-daedalus-startup-findings.md` → `<DS-nn>`.

**Order of work:** the waves in §6 are ordered by expected startup win, not by severity. **Wave 1** is the delay. **Wave 2** is the errors that should not exist — these are what make the app *look* broken, and they are cheap. **Wave 3** is the standing subprocess waste. **Wave 4** is weight and hygiene.

**One caveat on scope:** the findings span three codebases (`src-tauri/`, `server-jarvis/`, `src-ui/`). Each suggested backlog item names a single area — **do not merge a Rust finding and a server finding into one brief**, or a UI finding and a Rust one.

**Two rules for whoever picks this up:**

1. **Do not re-derive.** The measurements in §8 are the evidence. Re-running them is only worth it if the claim is in dispute.
2. **Do not open a brief for DS-11 alone.** The migrations are ungated, but they measure at ~10 ms — that is a correctness cleanup, not a startup fix.

**What this document deliberately does not claim.** It does not claim a new packaged cold-start number (DD-023 owns that, and the packaged probe still hangs). It does not claim the ≈10 s child-start gap is solved — it **narrows** it (§4). And it changes no source.

---

## 1. The startup timeline as it actually runs

Traced from source. `A` = blocks the window appearing; `B` = runs after the window is up but before the app is usable.

| # | Phase | Where | Blocks | Cost |
|---|---|---|---|---|
| 1 | Python interpreter discovery (`py -3 --version`, `python --version`, …) | `src-tauri/src/lib.rs:151-164`, `86-141` | **A** | **MEASURED 932 ms** on this box (`py -3 --version`); `python --version` = 22 ms |
| 2 | Open SQLite, apply pragmas | `src-tauri/src/db/mod.rs:84-119` | **A** | MEASURED 0.5 ms open + 8.4 ms pragmas |
| 3 | Run the **whole** migration set (50 `CREATE TABLE`, 65 `add_column_if_missing`, 58 `execute_batch`), **no `PRAGMA user_version` gate** | `src-tauri/src/db/migrations.rs:10` | **A** | MEASURED ~10 ms proxy (26-table no-op DDL sweep = 0.1 ms; 26 schema probes = 1.6 ms). *Not* the bottleneck |
| 4 | Seed 21 bundled skills (2 statements each, large bodies) | `src-tauri/src/lib.rs:1586` → `src-tauri/src/commands/skills.rs:457-490` | **A** | READ — 42 statements, main thread |
| 5 | Legacy file→SQLite config migration | `src-tauri/src/lib.rs:1427` | B | READ |
| 6 | Memory-turn recovery + recorded-capture recovery | `src-tauri/src/lib.rs:1438`, `1452` | B | READ |
| 7 | Load config — **may spawn `wsl.exe`** | `src-tauri/src/lib.rs:1463` → `src-tauri/src/commands/settings.rs:272-277` → `src-tauri/src/wsl.rs:218` | B | MEASURED 119 ms per `wsl.exe` call on this box (fails fast here; 5 s timeout in code) |
| 8 | **Start the inference backend** and *wait for it* | `src-tauri/src/lib.rs:1473-1494` | B | READ — Ollama path polls up to 30 × 500 ms (nominal "15 s"), each poll also runs a WSL probe (DS-04) |
| 9 | **Start the Bun server** | `src-tauri/src/lib.rs:1499` | B | READ — happens **after** step 8 |
| 10 | Probe `/health` on a Bun server that does not exist yet | `src-tauri/src/lib.rs:1295` → `981-1015` | B | MEASURED 5–6 s per the DD-023 log evidence; up to 4 candidates × 2 s (`lib.rs:1006`) |
| 11 | Spawn Bun, poll until healthy (20 s ceiling) | `src-tauri/src/lib.rs:1325-1338` | B | READ — the ~10 s child-start gap in DD-023 |
| 12 | Start the Claude CLI proxy (if enabled) | `src-tauri/src/lib.rs:1507-1532` | B | READ |
| 13 | Start the supervisor watchdog | `src-tauri/src/lib.rs:1536` | — | READ — ticks every 20 s (`supervisor.rs:24`) |
| 14 | Start the cron scheduler (20 s initial delay, 60 s poll) | `src-tauri/src/lib.rs:1539` → `cron_scheduler.rs:19-20, 2113` | — | READ |
| 15 | UI mounts, fires its own boot requests | `src-ui/src/main.tsx`, `App.tsx`, `shell/Shell.tsx` | B | see §3 |

**The structural problem in one line:** the **Bun server — which every UI feature fetches from** — is started *after* the inference backend, and *after* a pointless health probe of a server that has not been spawned yet.

---

## 2. Findings

### DS-01 — Bun (the UI's only data source) starts after the inference backend — S1 — READ

The UI does not go through the native surface for most data. It fetches directly from `http://127.0.0.1:19877`:

- `src-ui/src/features/sessions/useSessionTurn.ts:217` — `JARVIS_API_URL = 'http://127.0.0.1:19877'` (the chat path, per `CONTEXT.md`)
- `src-ui/src/features/agents/types.ts:37`, `channels/ChannelsPage.tsx:57`, `skills/skill-model.ts:8`, `skills/SkillLearningPage.tsx:107`, `system/SystemStatusBar.tsx:30`, `health/useRuntimeTelemetry.ts:13`

Yet the boot order is: config → **backend** → **Bun**.

```rust
// src-tauri/src/lib.rs:1473-1503
match backend {
    JarvisBackend::Ollama => { crate::start_ollama_and_warm(cfg.ollama.model.clone()).await; }   // ← waits for the port
    JarvisBackend::LlamaCpp => { … start_llama_cpp_server(…).await … }
    …
}
if let Err(e) = crate::ensure_jarvis_server_started().await { … }   // ← Bun only starts here
```

`start_ollama_and_warm` blocks on a port-readiness loop *before* Bun is even considered (`lib.rs:250-262`), and the comment on `start_llama_cpp_server` (`lib.rs:351-353`) says explicitly that model loading "can take longer than app bootstrap" — the same reasoning was never applied to Bun.

**Why it matters:** every UI request issued in the first N seconds hits a dead `127.0.0.1:19877` and fails. The window is up and responsive (DD-023 measured 4–6 s), so the app *looks* alive and *is* broken. This is the single biggest structural cause of "slow startup with errors that should not exist".

**Proposed fix:** start Bun **first**, in parallel with the inference backend (`tokio::join!`), and let both converge. Bun is required by every backend; the inference backend is not required by Bun.

**Suggested check:** `cargo test` regression asserting boot order, plus the packaged cold-start probe (`scripts/probe-cold-start.ps1`) showing `server_listening` before `backend ready`.

---

### DS-02 — The app health-probes a Bun server it has not started yet — S1 — READ (+ DD-023 log evidence)

```rust
// src-tauri/src/lib.rs:1269-1348 (ensure_jarvis_server_started)
if fresh() { return Ok(()); }                       // TTL fast path
…
if probe_jarvis_healthy().await { … return Ok(()); }   // ← 1295: probe BEFORE spawn
…
let server_entry = find_jarvis_server()…;              // ← 1323
spawn_blocking_on_current_runtime(move || start_jarvis_server(&server_entry, true)).await…;  // ← 1325
```

`probe_jarvis_healthy` (`lib.rs:981-1015`) walks **up to four** candidate URLs (`wsl.rs:171-191`: cached URL, `JARVIS_API`, `127.0.0.1:19877`, `localhost:19877`), each with a **2 s** timeout (`lib.rs:1006`), and builds a **fresh `reqwest::Client`** every call (`lib.rs:982`) — no connection reuse.

On a cold start the server provably cannot exist yet, so every one of those probes is a guaranteed miss. The DD-023 log evidence records **≈5–6 s burned before any spawn**, on two separate packaged runs.

**Why it matters:** pure, guaranteed waste on the critical path — and it is the largest *single* identified slice of the 19 s.

**Proposed fix:** on the cold-start path (no tracked child, no cached Bun URL) go straight to spawn. Keep the probe only for the restart/recovery path, where a server may already be running.

**Suggested check:** a unit test asserting that a cold `ensure_jarvis_server_started()` performs **zero** health probes before spawning; the packaged probe showing `spawn` ≤ ~1 s after bootstrap entry.

---

### DS-03 — Startup order in `run()` blocks the first paint — S1/S2 — READ + MEASURED

Everything in `run()` before `tauri::Builder::default()…run()` happens **before the window exists**:

```rust
// src-tauri/src/lib.rs:1599-1604
.manage(HermesAppState::with_config(build_hermes_config()))   // ← 1604: spawns `py -3 --version`
…
let db = match crate::db::AppDb::new(&app_data_dir) {          // ← 1584: open + full migration set
    Ok(db) => { let _ = crate::commands::skills::seed_skills(&db); db }   // ← 1586: 42 statements
```

`build_hermes_config()` → `find_jarvis_python()` (`lib.rs:124-141`) runs `command.status()` for each candidate until one succeeds — **synchronously, with no timeout**, on the main thread.

**MEASURED on this box:**

| Command | Wall time |
|---|---|
| `py -3 --version` (first candidate found) | **932 ms** |
| `python --version` | 22 ms |
| `python -c "print(1)"` | 70 ms |

The four `~/.openclaw/jarvis/hermes/.venv/…` candidates do not exist here, so `py -3` is tried first and wins.

**Why it matters:** ~1 s of pure dead weight before the window can appear, spent probing for a Python interpreter that only the Hermes commands need (`hermes_spawn`/`hermes_invoke`/… are still registered at `lib.rs:1801-1809`, so the interpreter may be needed — but it is needed **lazily**, not before the window exists). It is also unbounded: `command.status()` has no timeout, so a hung `py` launcher blocks the window indefinitely.

**Proposed fix:** move Python discovery off the pre-window path — resolve the interpreter lazily on the first Hermes command, or cache it after the first successful probe; give the probe a timeout. If the Hermes commands are being retired, drop the discovery entirely.

**Suggested check:** a test asserting `run()` performs no subprocess spawn, plus a first-paint timing in the cold-start probe.

---

### DS-04 — Local-only services are probed through WSL — S2 — READ + MEASURED

```rust
// src-tauri/src/lib.rs:1350-1368
pub fn is_port_listening(port: u16) -> bool {
    if local_port_is_listening(port) { return true; }
    is_wsl_port_listening(port)      // ← spawns `wsl.exe` on Windows
}
// src-tauri/src/lib.rs:1370-1384 → `wsl.exe -- python3 -c "…"` with a 2 s timeout
```

`is_port_listening` is used for **Ollama (11434)**, **llama.cpp (default 8080)** and the **bridge (19876)** — all of which are, by construction, local Windows listeners. `bun_server_is_listening()` (`lib.rs:1195-1200`) is the only call site that guards the WSL branch with `bun_uses_wsl()`.

**MEASURED on this box:** `wsl.exe -- python3 -c …` = **119 ms** (fails fast: the distro VHDX cannot be attached). On a healthy WSL2 box a distro launch is 0.5–2 s each.

The blow-up is in the **Ollama readiness loop**:

```rust
// src-tauri/src/lib.rs:250-262
for _ in 0..30 {
    tokio::time::sleep(Duration::from_millis(500)).await;
    if is_port_listening(11434) { … }     // ← local check + a WSL spawn every iteration
}
```

30 iterations × (500 ms + one `wsl.exe` spawn) is nominally "15 s" but is really **15 s + 30 × WSL-launch cost** — on a box with a cold-but-working WSL2 that is 30–60 s, while the error message still claims 15 s.

**Why it matters:** the "15 s" budget in the Ollama path is a fiction on Windows, and it runs *before* Bun starts (DS-01).

**Proposed fix:** split the API — `is_local_port_listening` for services that can only be local; keep the WSL fallback only for Bun, and gate it on `bun_uses_wsl()` the way `bun_server_is_listening` already does.

**Suggested check:** a unit test that `is_port_listening` for the Ollama port never invokes `wsl.exe`; the packaged probe showing a bounded Ollama wait.

---

### DS-05 — `wsl_openclaw()` is broken: it prefixes `openclaw` to every argument — S3 (correctness) + S2 (cost) — READ + MEASURED

```rust
// src-tauri/src/wsl.rs:250-282
pub fn wsl_openclaw(args: &[&str]) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let joined = shlex_join(args);
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--", "bash", "-lc", &format!("openclaw {joined}")]);   // ← always prefixes "openclaw"
```

Every caller that expects a plain POSIX command therefore runs the wrong command:

| Caller | Intended | Actually runs |
|---|---|---|
| `commands/system.rs:456` `disk_health()` | `df -BG --output=… /` | `openclaw df -BG --output=… /` |
| `commands/system.rs:481` `memory_health()` | `cat /proc/meminfo` | `openclaw cat /proc/meminfo` |
| `commands/system.rs:388` (ollama model in health) | `ollama ps --format json` | `openclaw ollama ps --format json` |
| `jarvis/runner.rs:1997` (`bun_available`) | `which bun` | `openclaw which bun` |

**MEASURED:** `wsl.exe -- bash -lc "openclaw which bun"` on this box = **53 ms**, exit `-1`, stderr = the WSL disk-attach failure. The result is discarded and the caller substitutes `"?"` / `0` / `false`.

**Why it matters — two failures at once:**
1. **The diagnostics are permanently broken.** Disk and memory health in the Diagnostics grid always read `"?"` and `0%`; `ollama_model` in health is always `None`; `bun_available` is always `false`. Users are shown a broken readout that looks like a real measurement.
2. **The failures are silent.** Every one of these is a `wsl.exe` spawn with a **30 s** timeout (`wsl.rs:257`) that is swallowed into `"?"`. Nothing tells the operator the WSL bridge is dead.

**Proposed fix:** split into two helpers — `wsl_run(argv)` that runs the command as given, and a separate `wsl_openclaw(args)` for the one case that really wants the `openclaw` CLI. Make the Windows path run the command directly (`wsl.exe -- bash -lc "<cmd>"`) and report the failure instead of substituting `"?"`.

**Suggested check:** unit tests for `wsl_run` argument handling on Windows, and a health test asserting disk/memory parse a real `df`/`/proc/meminfo` payload.

---

### DS-06 — `wsl::wsl_home()` is not cached and is called from the config load — S2 — READ + MEASURED

There are **two** `wsl_home()` implementations:

| Function | Location | Cached? | Timeout |
|---|---|---|---|
| `lib.rs::wsl_home()` | `src-tauri/src/lib.rs:36-57` | yes (`OnceLock`) | 15 s |
| `wsl::wsl_home()` | `src-tauri/src/wsl.rs:218-244` | **no** | 5 s |

The uncached one is on the boot path:

```rust
// src-tauri/src/commands/settings.rs:272-277 — inside load_jarvis_config
if config.jarvis_path.is_empty() {
    config.jarvis_path = format!("{}/.openclaw/agents/coderclaw/workspace/Jarvis",
        crate::wsl::wsl_home());      // ← spawns `wsl.exe -- bash -lc 'echo -n $HOME'` every call
}
```

`load_jarvis_config` runs at boot (`lib.rs:1463`) and on every `jarvis_get_config`-style read.

**MEASURED:** `wsl.exe -- python3 -c …` = 119 ms; `wsl.exe -- bash -lc …` = 53 ms (fails fast on this box). The code allows 5 s.

**Why it matters:** a config read should never spawn a shell. On a box with a cold WSL2 distro this is a multi-second stall on a function that only needs a path string. It is also *inconsistent* — the same value has two implementations with different caching and timeout behaviour.

**Proposed fix:** delete one of the two; cache the survivor; derive the path from `USERPROFILE`/`HOME` on Windows (the value is only a fallback default anyway).

**Suggested check:** a test asserting `load_jarvis_config` performs no subprocess spawn; a unit test that the resolved path is stable across calls.

---

### DS-07 — The log plugin writes TRACE to disk and rotates at 40 KB, evicting the startup instrumentation — S2 — READ + MEASURED (file contents)

```rust
// src-tauri/src/lib.rs:1600
.plugin(tauri_plugin_log::Builder::default().build())
```

`Builder::default()` in `tauri-plugin-log 2.8.0` sets **no level filter**, so the max level is `Trace`; `DEFAULT_MAX_FILE_SIZE` is **40 000 bytes** and `DEFAULT_ROTATION_STRATEGY` is `KeepOne` (`tauri-plugin-log-2.8.0/src/lib.rs:46-52`, `404-430`).

**MEASURED — the app's own log file, `%LOCALAPPDATA%\com.jarvis.desktop\logs\Jarvis.log` (14 362 bytes, from a run at 18:19 EDT = 22:19 UTC on 2026-10-21):** every single line is `reqwest` internals:

```
[2026-10-21][22:19:05][reqwest::connect][DEBUG] starting new connection: http://127.0.0.1:8080/
[2026-10-21][22:19:05][reqwest::blocking::wait][TRACE] wait at most 3s
[2026-10-21][22:19:05][reqwest::blocking::client][TRACE] closing runtime thread (ThreadId(75))
…
[2026-10-21][22:20:20][reqwest::blocking::wait][TRACE] park timeout 1.9999996s
```

**There are zero `jarvis::startup` lines in the file** — and zero in *any* file in the log directory.

The mechanism is visible in the file itself: the app ran at 18:13 EDT, but the file's first entry is 18:19:05 EDT and it is only 14 KB — i.e. the log **rotated at 18:19** (crossing the 40 KB cap) and `KeepOne` deleted the previous file, which is where the boot's `jarvis::startup` markers had been written.

**Why it matters — this is not just noise, it breaks the measurement path:**
- Every HTTP probe writes ~10 lines to stdout **and** to disk. On the observed log, probes fire every ~15 s, each producing ~40 lines.
- The file rotates at 40 KB and keeps **one** file, so the TRACE flood evicts the app's own `jarvis::startup` INFO lines — the exact lines DD-023 relies on to measure the split between "app delay" and "server delay".
- Log timestamps are **UTC** (`DEFAULT_TIMEZONE_STRATEGY = UseUtc`, `lib.rs:48`) while the file mtime is local — a 4-hour offset that will silently corrupt any timing analysis that mixes the two.

**Proposed fix:** `.plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).max_file_size(…) .rotation_strategy(…))`; keep a `jarvis::startup` file target that is not subject to the same rotation budget (or raise the cap to megabytes).

**Suggested check:** a test asserting the app's startup markers survive a burst of probes; a grep-based check that `reqwest` does not appear at TRACE in `Jarvis.log`.

---

### DS-08 — `get_system_health` and `jarvis_check_status` each spawn WSL and HTTP probes on every poll — S2 — READ + MEASURED (log cadence)

`get_system_health` (`src-tauri/src/commands/system.rs:381-452`) performs, per call:
- `is_port_listening(11434)` → + one `wsl.exe` spawn (DS-04)
- `wsl_openclaw(&["ollama","ps","--format","json"])` → **wrong command** (DS-05) + 30 s timeout
- `bun_server_is_listening()`, `is_port_listening(19876)`, `is_port_listening(llama port)` → + up to two more `wsl.exe` spawns
- `disk_health()` → wrong command + `wsl.exe` spawn
- `memory_health()` → wrong command + `wsl.exe` spawn

`jarvis_check_status` (`src-tauri/src/commands/jarvis_commands.rs:1157-1164` → `jarvis/runner.rs:1912-2020`) adds `is_port_listening` × 2, a blocking llama.cpp `/models` GET with a **3 s** timeout, a blocking Bun `/health` GET with a **2 s** timeout, and `wsl_openclaw(&["which","bun"])`.

**MEASURED — the cadence in the real log:** probes to `127.0.0.1:19877` at 22:19:05 → 22:19:09 → 22:19:14 → 22:19:20 → 22:19:35 → 22:19:51 → 22:20:07 → 22:20:20 — i.e. **every ~15 s**, each with a 2 s client timeout, and several entries show `wait timeout exceeded` (the request hangs for the full timeout rather than being refused).

**Why it matters:** every poll spawns up to five processes, writes ~40 log lines, and can block for seconds. Two different commands probe the same subsystems, so the UI is paying this twice per interval.

**And `get_system_health` does it on the wrong thread.** `jarvis_check_status` was deliberately moved onto `spawn_blocking` for exactly this reason:

```rust
// src-tauri/src/commands/jarvis_commands.rs:1158-1164
/// Clone under the mutex, then release it before the synchronous health
/// probes. `check_jarvis_status` performs blocking HTTP and WSL process
/// work, so running it on an async command worker can starve Tauri IPC.
```

`get_system_health` (`commands/system.rs:381-452`) makes the same class of call — `disk_health().await` and `memory_health()` run `wsl_openclaw` (a `Command::status()` with a 30 s timeout) **directly inside an `async fn`**, with no `spawn_blocking`. On a Windows box with a slow WSL distro, one `get_system_health` call can occupy a Tokio worker thread for seconds and starve the IPC the rest of the UI depends on.

**Proposed fix:** cache the WSL-dependent probes with a short TTL; make the health path platform-native (Windows: `GetDiskFreeSpaceEx` / `GlobalMemoryStatusEx`; no WSL); move the remaining blocking calls onto `spawn_blocking`; merge `get_system_health` and `jarvis_check_status` into one source of truth.

**Suggested check:** a test asserting `get_system_health` performs no subprocess spawn; a log-cadence check that the number of `wsl.exe` spawns per minute is bounded.

---

### DS-09 — `get_build_info` shells out to `git` on every call — S2 — READ

```rust
// src-tauri/src/commands/system.rs:348-360
let source_sha = repo_root.and_then(|root| {
    std::process::Command::new("git").arg("-C").arg(root)
        .args(["rev-parse", "HEAD"]).output().ok()…
```

A `git` subprocess per invocation, in a command the UI is likely to call on a status refresh. `git rev-parse HEAD` on a cold Windows FS is ~50–150 ms and touches the whole `.git` directory.

**Proposed fix:** compute once at startup and cache (the SHA cannot change while the app runs); drop the runtime `git` call entirely — the build already embeds `JARVIS_GIT_SHA` (`system.rs:338`).

**Suggested check:** a test asserting two calls return the same cached value with no subprocess.

---

### DS-10 — The supervisor watchdog re-probes every port every 20 s, WSL included — S2 — READ

```rust
// src-tauri/src/supervisor.rs:24-25
const TICK: Duration = Duration::from_secs(20);
```

Each tick calls `bun_server_is_listening()`, `claude_proxy_is_listening()`, `is_port_listening(OLLAMA_PORT)` and `is_port_listening(llama_cpp_config.port)` — the last two take the unconditional WSL branch (DS-04). It also emits a `jarvis://supervisor` event every tick, so the UI wakes up every 20 s too.

**Why it matters:** a permanent, low-frequency but unbounded subprocess stream for the lifetime of the app; on a healthy-WSL box this is ~2 distro launches per 20 s.

**Proposed fix:** the same `is_local_port_listening` split as DS-04; keep a cached "last known state" and only re-probe on change.

---

### DS-11 — Migrations are not version-gated — S3 — READ + MEASURED (and it is *not* the bottleneck)

`src-tauri/src/db/migrations.rs:10` runs the whole DDL set on every boot: **50** `CREATE TABLE`, **65** `add_column_if_missing` calls, **58** `execute_batch` calls. There is **no `PRAGMA user_version`** anywhere in `src-tauri/src` (grepped: zero hits), so there is no cheap "already at the latest version" exit.

**MEASURED against a copy of the real 3.1 MB `jarvis.db`:**

| Step | Time |
|---|---|
| open | 0.5 ms |
| pragmas (WAL, foreign_keys, mmap_size 30 GB, cache_size −20000) | 8.4 ms |
| list tables | 1.5 ms |
| no-op DDL sweep over all 26 real tables | 0.1 ms |
| 26 × `pragma_table_info` schema probes | 1.6 ms |

**Conclusion: the database is ~10 ms of boot, not a bottleneck.** This kills the "migrations are slow" hypothesis and is worth recording so the right hands do not spend a brief on it. It is still worth versioning eventually (correctness: an ungated migration set cannot be reasoned about), but it is **S3, not S1**.

**Note:** `PRAGMA mmap_size = 30000000000` (`db/mod.rs:105`) asks for a 30 GB memory map — harmless on 64-bit, but it is an odd default to carry in a shipped app.

---

### DS-12 — A machine-specific absolute path is compiled into the server lookup — S3 — READ

```rust
// src-tauri/src/lib.rs:934-941
let dev_candidates: &[&str] = &[r"C:\Projects\home-base-recovered\server-jarvis\src\index.ts"];
for cand in dev_candidates {
    if std::path::Path::new(cand).exists() {
        println!("[Jarvis] Found server at native dev path: {}", cand);
```

A developer's checkout path is checked on every launch on Windows. On this box it matches first, so the packaged app silently prefers a **source** `index.ts` over the bundled `index.js` when running from the repo — which changes what is being measured.

**Proposed fix:** drop the hardcoded path; the `current_exe` ancestry walk (`lib.rs:895-910`) and the CWD walk (`lib.rs:915-930`) already cover the dev case.

**Suggested check:** a test that `find_jarvis_server` never returns a path under a hardcoded developer root.

---

### DS-13 — A broken WSL install is invisible to the app — S3 — MEASURED

**MEASURED:** `wsl.exe -- python3 -c …` on this box exits `-1` with:

```
Failed to attach disk 'E:\Data\wsl-ubuntu\ext4.vhdx' to WSL2: Access is denied.
Error code: Wsl/Service/CreateInstance/MountDisk/HCSC/ACCESS_DENIED
```

Every WSL-backed path in the app (`disk_health`, `memory_health`, `ollama ps`, `which bun`, `wsl_home`, `is_wsl_port_listening`) fails silently and substitutes `"?"`, `0` or `false`. Nothing in the UI or the logs says "WSL is broken".

**Why it matters:** on a machine with a broken WSL, the Diagnostics grid shows confident zeros, the app looks like it measured something, and no one can tell the difference between "0% memory used" and "I could not read memory". It also means every WSL-dependent diagnostic is permanently wrong on exactly the class of machine that needs it most.

**Proposed fix:** surface WSL availability as a first-class health field (`wsl_available: bool` + the error string), and make the Diagnostics UI say "unavailable" instead of `?`/`0`.

---

## 3. Findings from the UI boot path

The UI mounts `Shell` (`src-ui/src/shell/Shell.tsx`), which eagerly renders the **HealthBanner**, the **SystemStatusBar**, the **BuildBadge**, the **ActionRegistryAlertBanner**, the **Rail** (which mounts the companion store) and the current route (Sessions by default). Route *pages* are lazy (`src-ui/src/shell/routes.ts:76-121`) — that part is healthy.

**Boot cost, measured from the current build output (`src-ui/dist`, built 18:11 on 2026-10-21):**

| | |
|---|---|
| Boot-critical JS | **≈936 KB raw / ≈288 KB gzip** across 4 chunks (entry 448 KB, shared markdown 327 KB, SessionsPage 157 KB, MarkdownView 4 KB) |
| Render-blocking CSS | 97 KB (17 KB gzip), 15 `@font-face` rules |
| Native/HTTP reads fired at boot | **15** |
| Tauri event subscriptions registered at boot | **21** (`cron://missed-jobs` subscribed **twice**) |
| Live polling timers alive at boot | **3** (`jarvis_check_status` @15 s, system telemetry @30 s, companion @60 s) |

### DS-14 — Two native health commands probe the same subsystems, at two intervals, both at t=0 — S2 — READ

| Surface | Command | Interval | Fires at mount? |
|---|---|---|---|
| `HealthBanner` (`features/system/HealthBanner.tsx:79,86`) | `jarvis_check_status` | 15 000 ms | **yes** |
| `SystemStatusBar` (`features/system/SystemStatusBar.tsx:167,203`) | `get_system_health` | 30 000 ms | **yes** |
| `SystemStatusBar` (`SystemStatusBar.tsx:179`) | `fetch http://127.0.0.1:19877/health/inference` | 30 000 ms | **yes** |
| `SystemStatusBar` (`SystemStatusBar.tsx:191`) | `jarvis_get_config` | 30 000 ms | **yes** |
| `OverviewPage` (`features/overview/OverviewPage.tsx:62,74`) | `get_system_health` + `list_agents` + `list_sessions` | 15 000 ms | on visit |
| `HealthPage` (`features/health/HealthPage.tsx:125,126`) | `jarvis_check_status` + `get_system_health` | — | on visit |

`usePolling` fetches **immediately on mount** and then on the interval (`src-ui/src/hooks/usePolling.ts:62`).

`jarvis_check_status` and `get_system_health` each independently probe Ollama, llama.cpp, the Bun server and the Claude proxy — with different implementations (`jarvis/runner.rs:1912` vs `commands/system.rs:381`), different timeouts (2 s / 3 s / 5 s) and different WSL usage. The app pays the DS-08 cost **twice per cycle**, and the two surfaces can disagree about the same subsystem.

**Proposed fix:** one native health snapshot, one interval, one caller. The UI already has a shared derivation module (`features/system/health-derivation.ts`) — extend it rather than adding a second probe path.

**Suggested check:** a test that asserts only one health command is invoked per polling cycle.

---

### DS-15 — The startup grace covers Bun but **not** the backend, so a normal cold start reads "Offline" — S1 — READ

```ts
// src-ui/src/features/system/health-derivation.ts:52-56
function overallLevel(s, fetchError, mountedForMs): HealthLevel {
  if (fetchError) return 'unavailable';
  if (!backendOk(s)) return 'down';                                            // ← no grace
  if (!(s.bun_server_running ?? false))
    return mountedForMs < STARTUP_GRACE_MS ? 'starting' : 'warn';                // ← grace exists here
  return 'ok';
}
```

`STARTUP_GRACE_MS = 20_000` (`health-derivation.ts:15`) exists precisely to stop a cold start from being reported as degraded — but it is applied **only** to the Bun server.

The backend check has no grace at all, and the backend is *by design* not up yet during boot: the native boot starts it in the background (`lib.rs:1473-1494`), and `start_llama_cpp_server` explicitly returns before the model has loaded (`lib.rs:351-353`). `backendOk` for `llama_cpp` requires `llama_cpp_running` (`health-derivation.ts:46`), and for `ollama` it requires `ollama_running && model_available` (`:45`) — i.e. an `/api/tags` round-trip that only succeeds once the model is loaded.

**Consequence:** at t=0 (the first poll fires immediately, `usePolling.ts:62`) the banner renders **"Offline"** with the summary `Backend "llama_cpp" is unreachable` (`health-derivation.ts:62`) — for a boot that is proceeding exactly as designed. This is precisely the class of "error that should not exist" that makes a slow startup look broken.

**Proposed fix:** extend the same startup grace to the backend — a not-yet-ready backend inside the grace window should read `starting` ("Loading the local model…"), not `down`. The native side should also say *why* it is not ready (spawned / loading / failed) rather than a bare boolean.

**Suggested check:** a unit test in `health-derivation.test.ts` asserting that a backend-down status inside the grace window yields `starting`, not `down`.

---

### DS-16 — The footer shows a red **"SYS STOPPED"** for the whole cold-start window, while the banner above it correctly says "Starting" — S1 — READ

```ts
// src-ui/src/domain/system-telemetry-state.ts:417-418
} else if (services.bun === 'down' || services.bridge === 'down') {
  overall = 'stopped';
```

`bun` is unconditionally `required` (`system-telemetry-state.ts:253-258`, `ALWAYS_REQUIRED`), so during cold start `overall = 'stopped'` → `OVERALL_LABEL.stopped = 'SYS STOPPED'` with `OVERALL_TONE.stopped = 'error'` (`:112-128`), rendered in the footer bar.

The banner directly above it has an explicit 20 s grace for exactly this case (`health-derivation.ts:15,55`). So the two always-mounted health surfaces **disagree for the first ~20 s** — "Starting Bun server — tools and skills are warming up" above, "SYS STOPPED" below — and the footer keeps saying STOPPED until its next 30 s tick, i.e. **up to 30 s of a red error verdict for a service that is merely starting**.

**Why it matters:** this is the single most visible "error that should not exist" during a cold start, and it sits in the chrome of every screen.

**Proposed fix:** give the telemetry derivation the same grace window the banner already has (it is a pure function in `src-ui/src/domain/system-telemetry-state.ts`, so it can be unit-tested); or drive both surfaces from one shared verdict.

**Suggested check:** a unit test asserting the telemetry overall level is `starting`, not `stopped`, inside the grace window.

---

### DS-17 — The boot read that talks to Bun directly *always* fails during cold start, and is rendered as an error — S2 — READ

```ts
// src-ui/src/features/system/SystemStatusBar.tsx:174-185
const response = await globalThis.fetch(`${BUN_URL}/health/inference`);   // BUN_URL = 'http://127.0.0.1:19877'  (:30)
if (!response.ok) throw new Error('Inference telemetry unavailable');
```

→ `dispatch({ type: 'inference-failure' })` → `state.inference.error = true` → a user-visible alert chip with a **Retry** button (`SystemStatusBar.tsx:293-309`). A Bun server that is two seconds from ready is presented as "inference telemetry is unavailable".

The same pattern applies to the chat path: `useSessionTurn.ts:1892` fetches `${JARVIS_API_URL}/chat/stream`; if Bun is not listening the operator sees `The turn failed. Your message is kept as a draft — send it again to retry.` (`useSessionTurn.ts:2727-2728`) with **no hint that the server is still starting**.

**Proposed fix:** gate the direct-Bun fetches on the same "server is starting" state the banner already computes, and say "starting" instead of "unavailable".

---

### DS-18 — There are no retry loops anywhere in the UI, so a cold-start failure persists for 15–30 s — S2 — READ

The complete `setTimeout` inventory in `src-ui/src/**` (non-test) contains **zero** retry loops — only toast auto-dismiss, a copy-button reset, scroll timing and turn timeouts. Every failure surfaces a manual **Retry** button (`HealthBanner.tsx:139`, `SystemStatusBar.tsx:282-290,299-307`, `ActionRegistryAlertBanner.tsx:29-36`).

The fastest automatic re-check is the 15 s `HealthBanner` tick. So a cold start that takes 20 s shows a stale error banner for up to 15 s **after** the service is actually healthy.

**Proposed fix:** a short backoff re-check (1 s → 2 s → 4 s, capped) while the app is inside the startup grace window.

---

### DS-19 — The Session list is read several times at boot, through two duplicate native commands — S3 — READ

`jarvis_list_sessions` (`commands/jarvis_commands.rs:1048-1053`) and `list_sessions` (`commands/sessions.rs:816-818`) are **the same query** — both call `list_session_rows(&db)` — exposed under two names and returning two different shapes (`JarvisSession` vs `SessionSummary`).

At boot the UI calls:
- `jarvis_list_sessions` — `features/sessions/SessionsPage.tsx:93`
- `list_sessions` — `features/sessions/SessionsPage.tsx:230`, `features/sessions/SessionFeeds.tsx:84`, `features/sessions/SessionLedger.tsx:36`

And `jarvis_get_config` is fetched **twice** at boot — `SystemStatusBar.tsx:191` and `SessionsPage.tsx:183`.

So the sessions table is read **3–4 times** during the first paint, under two command names, with no shared cache.

**Proposed fix:** pick one command and one shape; cache the boot read in the provider and reuse it.

**Suggested check:** a test asserting the Sessions page issues one session-list read on mount.

---

### DS-20 — Duplicated polling logic means a fix lands in one copy only — S3 — READ

`GoalCronPage.tsx:1185-1259` is a near-verbatim copy of `useCronJobs.ts:88-153` — same `fetchInFlight`/`fetchJobs`/`fetchPendingMissed`, same `setInterval(…, 3000)`, and a **second** `listen('cron://missed-jobs')` subscription. `ActionsPage.tsx:115-164` and `TrustedActionsPage.tsx:473-551` are the same story.

Both `cron://missed-jobs` handlers stay registered at boot (`useAppSignals.ts:81-92` toasts; `features/companion/companion-store.ts:103-109` updates the rail), so every emit is handled twice and the second handler triggers another `list_cron_jobs` + `list_pending_missed_jobs` pair (`companion-store.ts:110`).

**Proposed fix:** one implementation per capability; the page components consume the shared hook.

---

### DS-21 — Boot-critical JS is 936 KB and the markdown/highlight stack is in the boot path — S2 — MEASURED

| chunk | raw | gzip | content |
|---|---|---|---|
| `index-CAaQkk5l.js` (entry) | 448 KB | 141 KB | React 19, **framer-motion**, lucide icons, the Shell |
| `index-B50yVYC3.js` (shared) | 327 KB | 99 KB | `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` (37 languages) |
| `SessionsPage-CzL_eeaY.js` | 157 KB | 46 KB | statically imports the shared chunk + `MarkdownView` |
| `index-rdB1x5VX.css` | 97 KB | 17 KB | 15 `@font-face` rules |

Two specific wastes:
- **`framer-motion` is in the entry chunk for one 2-pixel indicator** — `src-ui/src/shell/Rail.tsx:1,67-74` renders a single `<motion.span layoutId="rail-active">`, and the chunk contains the whole `MotionValue`/`projection`/`stiffness` runtime.
- **`react-markdown` + `highlight.js` load before the workspace is usable**, even though the transcript is empty on a fresh launch — `MarkdownView.tsx:15-17` is imported statically by `SessionFeeds.tsx:10` and `TurnMessage.tsx:8`, both inside the SessionsPage chunk. `MarkdownView.tsx:201` also sets `detect: true`, so `highlightAuto` runs on every unlabelled code block at runtime.

`src-ui/vite.config.ts` declares **no** `manualChunks`, no `chunkSizeWarningLimit` and no `build.target`.

**Proposed fix:** manual chunks for `react`/`react-dom` and for the markdown stack; replace the single `framer-motion` usage with a CSS transition; load `MarkdownView` lazily behind a dynamic import; drop the unused font subsets.

**Suggested check:** `npm run build` in `src-ui` plus a chunk-size assertion in CI (CI already records the bundle size).

---

### DS-22 — StrictMode doubles every boot read **in development only**; one shared store is missing its in-flight guard — S3 — READ

`StrictMode` is on (`src-ui/src/main.tsx:16`), but React 19 only double-invokes mount effects in its **development** build. The packaged app loads `src-ui/dist` (`tauri.conf.json:7`), built by `vite build` → production React (`react.production` is present in `dist/assets/index-CAaQkk5l.js`). `tauri dev` uses `devUrl: http://localhost:5173` → Vite dev server → development React → the double-invoke **is** active there.

In dev, every boot read fires twice: `usePolling` (`usePolling.ts:62`), `useAppSignals` (`useAppSignals.ts:60`), `useTheme` (`useTheme.ts:111`), `SessionsPage` (`SessionsPage.tsx:93,183`), and all **17** `listen()` registrations in `useSessionTurn.ts:1085-1490`.

Two shared stores guard against this inconsistently:
- `src-ui/src/domain/build-provenance.ts:274-276` — `if (inFlight) return;` → `get_build_info` is issued **once**.
- `src-ui/src/features/companion/companion-store.ts:94-116` — **no in-flight guard**, so `stop()` resets the state and `start()` re-fires `refresh()`; the first `list_cron_jobs` / `list_pending_missed_jobs` / `jarvis_get_companion` requests are genuinely issued and then discarded.

**Proposed fix:** give the companion store the same in-flight guard as the build-provenance store. (Dev-only impact, but it is the same shared-store pattern that will bite the next subscriber.)

---

## 4. Findings from the Bun server boot path

*(DS-23 and DS-24 are native-side findings about the Bun **child process** — its adoption and its teardown — and are grouped here because they are the other half of "the server is up". DS-25…DS-35 are inside the server itself.)*

The Bun server is **not** the slow part. Measured on this box, under the app's own spawn conditions (fresh copy of the 4.5 MB bundle, own working directory, stdout/stderr redirected to append-mode files, `JARVIS_SERVER_PORT` set):

| Stage | Measured |
|---|---|
| `Command::spawn` returns | **6 ms** / 92 ms |
| child's first log line → `Listening on http://localhost:19899` | **212 ms** |
| **spawn → `/health` answers 200** | **1 918 ms** / 1 912 ms |

The server's own log shows the whole startup sequence (`server-jarvis.self.log`):

```
2026-10-22T03:11:35.187Z INFO [SelfLog] guaranteed server log active
2026-10-22T03:11:35.209Z INFO SelfTuningStore: telemetry sink
2026-10-22T03:11:35.359Z INFO Jarvis_Orchestrator: Inference feedback startup load: applied=0 ignored=0 status=expired
2026-10-22T03:11:35.371Z INFO Jarvis_Orchestrator: Policy staging startup load: production=none candidate=pol_1_f4d447ec canary=pol_1_f4d447ec lkg=none
2026-10-22T03:11:35.399Z INFO Jarvis_API: Listening on http://localhost:19899
```

**First log line → listening = 212 ms.** The server's startup work is three cheap store loads and a policy-staging read.

**This narrows DD-023's open question.** The ≈10 s gap DD-023 recorded between `Command::spawn` returning and the child's first log line **is not** explained by the server's own boot — that is 212 ms. It is also not explained by the bundle size alone (the same 4.5 MB bundle loads in 1.9 s here). What remains specific to the packaged app is: the **freshly extracted `bun.exe`** (measured cold `bun --version` on this box: **2 665 ms**; warm: 15–23 ms), and **parent-side contention** while the WebView loads and the UI fires its boot health probes.

**But the server's own boot is not free, and it carries the defects below.** The server is 6 803 lines in one file with **116 top-level imports** pulling **129 modules / 2.34 MB of source** into a **4.69 MB bundle**. Its module body runs **179 top-level statements** with **zero top-level `await`** — so everything happens before `Bun.serve` binds at `server-jarvis/src/index.ts:6764`.

Good news first: the startup filesystem footprint is **small and fully bounded** — **5 files** touched (`config.json`, `inference-feedback.json`, `policy-versions.json`, `self-tuning.db`, and a log-dir `mkdirSync`), **zero directory scans** at startup (the agents root and skills dir are scanned *per request*), and **zero network calls** before the bind.

### DS-23 — The app adopts any healthy listener on :19877 without a build-identity check — S1/S2 — MEASURED

At the time of this review, the listener on `:19877` was **not** the app's child. It was:

```
ProcessId 2192  bun.exe
CommandLine: "C:\Users\ethan\.bun\bin\bun.exe" "C:\Users\ethan\OneDrive\Desktop\index.js"
ParentProcessId 3300  →  cmd.exe /d /s /c tsx scripts/smoke.ts RoomNew-Wide   (parent now gone)
```

Its `/health` answers:

```json
{ "ok": true, "uptime": 17799.4, "version": "1.0.0", "backend": "llama_cpp",
  "git_sha": "a670ffa099c0334a17930ac3c4189e6d6be43525",
  "built_at": "2026-10-21T18:11:14.5111202-04:00", "git_dirty": false }
```

`ensure_jarvis_server_started` probes `/health`, gets a 200, and returns `Ok(())` (`lib.rs:1295-1298`) — so the app would **adopt this copy** and run against it. The ownership model deliberately refuses to kill a listener it does not own (`process_lifecycle.rs:6`, `lib.rs:1211-1215`), which is correct; the missing half is that it also never *checks* what it adopted.

**Why it matters:** `/health` already returns `git_sha` and `built_at`. Comparing them against the app's own build (`JARVIS_GIT_SHA`, embedded at `commands/system.rs:338`) is a two-line check that would catch (a) a stale server from a previous build, (b) a foreign process squatting the port, and (c) a half-dead server. Today the app silently uses whatever answers.

**Proposed fix:** on adoption, compare the `/health` payload's `git_sha`/`built_at` with the app's own; on mismatch, report it and offer/perform a restart of the owned child instead of adopting silently.

**Suggested check:** a test that a `/health` payload with a foreign `git_sha` is not adopted as-is.

### DS-24 — Child processes are only torn down on a clean exit; a hard kill leaves them running — S2 — MEASURED

```rust
// src-tauri/src/lib.rs:1813-1817
.run(|_app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        process_lifecycle::stop_all();
    }
});
```

`stop_all()` exists and is correct (`process_lifecycle.rs:222-241`), but it is wired **only** to `ExitRequested`. A hard kill — Task Manager, a closed console, a crash, an OS restart of the window process — never emits it.

**MEASURED on this box:** the app that ran at 18:13–18:20 EDT today is gone, and its **`llama-server` (PID 21184, started 18:15:52) is still running**, holding :8080 — a multi-gigabyte model server with no owner.

**Why it matters:** the next launch finds :8080 already listening, skips starting llama.cpp, and inherits a server whose configuration may be from a previous run. Combined with DS-23, a leftover child makes the next start *look* healthy while running someone else's process.

**Proposed fix:** on Windows, put the child processes in a **Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**, so they die with the parent even on a hard kill. This is the platform-correct mechanism and is cheap to add next to `process_lifecycle`.

**Suggested check:** a test that spawns a managed child, force-kills the parent process, and asserts the child is gone.

### DS-25 — 63 % of the production bundle is a tokenizer table that is only needed per turn — S1 — READ (bytes measured)

```ts
// server-jarvis/src/tokens.ts:12
import { encode } from "gpt-tokenizer";
```

`gpt-tokenizer`'s ESM entry eagerly imports `bpeRanks/o200k_base.js` (2 171 000 B raw), which the Bun build inlines as one giant array literal:

```
server-jarvis/dist/index.js:7172   // node_modules/gpt-tokenizer/esm/bpeRanks/o200k_base.js
server-jarvis/dist/index.js:7173   var c0 = ["!", '"', "#", "$", "%", "&", "'", "(", ")", "*", "+", …
```

**Bytes for `dist/index.js:7172-10431` = 2 942 494 of the bundle's 4 685 354 — 63 %.**

`countTokens` is used in exactly two per-turn places (`index.ts:1961`, `index.ts:4166`) and **never at startup**. So ~3 MB of the bundle is parsed and materialised before `serve()` binds, purely as startup tax.

**Proposed fix:** load the tokenizer lazily (`await import()` on first token count, or a precomputed count for the common case), or ship a smaller model.

**Suggested check:** a bundle-size assertion in the server build (`build-frontend.ts:97-135`) — e.g. the bundle must be under 2 MB.

### DS-26 — A synchronous `cmd.exe` spawn happens at import time on every server start — S2 — READ

```ts
// server-jarvis/src/config.ts:538-551
const raw = execSync("cmd.exe /c \"echo %USERPROFILE%\"", { encoding: "utf-8", … });
// server-jarvis/src/config.ts:564
export const CONFIG_DIR = locateConfigDir();   // ← module-level const initializer
```

`locateConfigDir()` calls `getWindowsHome()` unconditionally, and `CONFIG_DIR` is a module-level `const`, so the child process is spawned during **import evaluation** — before `installSelfLog()`, before the SQLite open, before `serve()`. (A duplicate exists at `self-tuning/store.ts:374-391`, but that path is only reachable from `locateJarvisDb()`, which no production code calls.)

**Why it matters:** a blocking child-process spawn on the startup path, in the same class as the ≈10 s "spawn → first log line" gap DD-023 is chasing. It is also why `CONFIG_DIR` differs between a WSL-spawned and a Windows-spawned server.

**Proposed fix:** use `os.homedir()` / `process.env.USERPROFILE` directly — no subprocess.

**Suggested check:** a test that importing the config module spawns no process.

### DS-27 — `installSelfLog()` runs *after* every imported module, contradicting its own comment — S2 — MEASURED (log evidence)

```ts
// server-jarvis/src/index.ts:8-12
// Task 4.3: the self-log tee must install before ANY other module logs, so
// every line of this process's life is in the guaranteed log regardless of
// how the server was spawned (Tauri supervisor, deploy script, manual bun).
import { installSelfLog, selfLogPath } from "./self-log";
installSelfLog();
```

ESM hoists imports, so the 129 imported modules' bodies run **before** `installSelfLog()` executes. The `index.ts:7` startup banner (`[Jarvis startup] process entry uptime=…`) is therefore **never written to the self-log** — it goes to stdout only.

**MEASURED:** the captured `server-jarvis.self.log` starts at `[SelfLog] guaranteed server log active`; the `[Jarvis startup] process entry` line is absent. That missing line is exactly the one that would tell you how long the import phase took.

**Proposed fix:** move the self-log installation into a module that everything imports first (e.g. `import "./self-log-bootstrap"` placed at the very top of `index.ts`, with the install call inside that module) — or make `self-log.ts` install its tee at module scope.

**Suggested check:** a test that the self-log contains the startup banner after a server start.

### DS-28 — `console.warn` is recorded at level INFO in the only guaranteed log — S2 — REPRODUCED

```ts
// server-jarvis/src/index.ts:304-348
const originalLog = console.log;      // ← this is already the self-log tee
…
console.warn  = (...args) => { originalLog(formatLogLine("WARN",  ...args)); };  // ← originalLog, not the warn tee
```

`originalLog` is the **INFO** tee installed by `installSelfLog` (`self-log.ts:75`). The `console.warn` tee (`self-log.ts:76`) is replaced and never called again, so **every warning is written to `server-jarvis.self.log` with level `INFO`**.

**REPRODUCED** with a faithful inline harness on Bun 1.3.12:

```
2026-10-22T03:11:20.178Z INFO FMT-WARN this is a WARNING     ← should be WARN
2026-10-22T03:11:20.179Z ERROR FMT-ERR this is an ERROR
2026-10-22T03:11:20.179Z INFO FMT this is INFO
```

**Why it matters:** the self-log is the only log guaranteed to exist, and this audit's own evidence is read from it. Warnings — the exact class of message that would explain a degraded boot — are indistinguishable from INFO.

**Proposed fix:** capture `console.warn`'s original tee before overriding it (or call the self-log's warn tee explicitly).

**Suggested check:** a test asserting a `console.warn` lands in the self-log at level WARN.

### DS-29 — Startup opens the production telemetry DB, runs 25 always-failing `ALTER`s and reads up to 2 400 rows — for an optional scorecard — S2 — READ + MEASURED

```ts
// server-jarvis/src/index.ts:385-393
try {
  const scorecardSeedStore = new SelfTuningStore();
  for (const stage of SCORECARD_SEEDED_STAGES) {
    modelScorecard.seedFromHistory(stage, scorecardSeedStore.getRecentStageAttributions(stage, sinceIso, 400));
  }
} catch (e) { console.warn("[Jarvis Orchestrator] model scorecard history seed skipped:", e); }
```

`SelfTuningStore`'s constructor (`self-tuning/store.ts:738-747`) opens `~/.openclaw/jarvis/self-tuning.db` with `create: true`, runs `SELF_TUNING_SCHEMA` (**14 `CREATE TABLE IF NOT EXISTS`**) and then **25 `ALTER TABLE … ADD COLUMN`** statements, each in its own `try { } catch { /* column already exists */ }` — so a genuine migration failure (disk full, locked DB) is **indistinguishable** from "column already exists". Then **6 queries** each read up to 400 `model_attributions` rows (up to **2 400 rows** in one boot).

`index.ts:782` creates a **third** `SelfTuningStore` instance; `persistent-conductor.ts:560` defaults to a **fourth**.

**MEASURED:** this is ~22 ms of the 212 ms budget in the log (`03:11:35.187` → `03:11:35.209`). On a cold WSL ext4 mount with a large `self-tuning.db` it is materially worse — and it buys a scorecard that silently degrades to "skipped" on any error.

**Proposed fix:** seed the scorecard lazily (after `serve()`) instead of in the module body; version the telemetry schema with a `PRAGMA user_version` so the 25 ALTERs run once, not every boot; make the ALTER failures distinguishable.

**Suggested check:** a test asserting a second boot performs no `ALTER TABLE`.

### DS-30 — There is no `unhandledRejection` handler: an unhandled promise rejection **kills the Bun server** — S1 — REPRODUCED

Grep across all non-test `server-jarvis/src/**` finds `process.on("unhandledRejection", …)` in **exactly one place — a test file**. Production code has none.

**REPRODUCED** on Bun 1.3.12:

```
$ bun -e "Promise.reject(new Error('boom-unhandled')); setTimeout(()=>console.log('still alive'),300);"
error: boom-unhandled
exit code 1        ← the process DIED; the setTimeout never ran
```

`streamJarvis` (`index.ts:1467-6107`) is ~4 600 lines with many floating promises — e.g. `index.ts:1825` `(async () => { … })();`, an unawaited IIFE whose rejection is **not** attached to the outer `try`.

**Why it matters:** any throw inside such a promise **terminates the entire server**, mid-turn, with no diagnostic beyond a raw stack. This is the mechanism behind "the app suddenly loses its server".

**Proposed fix:** add `process.on("unhandledRejection", …)` and `process.on("uncaughtException", …)` handlers that log with full context and keep the process alive for the rejection case (Bun's default is to exit).

**Suggested check:** a test that starts the server, rejects an unawaited promise, and asserts the process is still serving.

### DS-31 — `serve()` has no EADDRINUSE handling: the port-taken case dies with a raw stack — S1 — REPRODUCED

```ts
// server-jarvis/src/index.ts:6764-6775
serve({ port: PORT, idleTimeout: 0, fetch: baseFetch });
```

No `try/catch`, no error handler, no retry, no pre-bind check. **REPRODUCED** on Bun 1.3.12 — `Bun.serve` throws **synchronously** at bind time:

```
THREW: Error | code= EADDRINUSE | errno= 0 | msg= Failed to start server. Is port 55258 in use?
```

The exception escapes module evaluation, so the process dies with an unhandled stack trace.

**Why it matters:** the file's own comment at `index.ts:6354-6359` records the incident this creates — *"ensure killed and respawned the Bun process mid-turn → competing spawns logged EADDRINUSE and left :19877 in a ghost LISTEN state (live 2026-08-05/06 session logs)"*. The native side has a proper ghost-socket diagnostic (`lib.rs:1341-1346`), but the Bun side has no equivalent, so the second spawn dies with a raw stack instead of the diagnostic the native side is trying to produce.

**Proposed fix:** wrap `serve()` in a `try/catch`; on `EADDRINUSE`, probe whether the existing listener is a healthy Daedalus server and exit with a clear, structured message if it is not.

**Suggested check:** a test that binds a second server to a taken port and asserts a structured error, not a raw throw.

### DS-32 — `/health` and `/status` failures are logged nowhere, and a `/health` 500 is what drives the respawn loop that creates the EADDRINUSE state — S1 — READ

```ts
// server-jarvis/src/index.ts:6327
const isNoisy = path === "/status" || path === "/health" || path === "/health/readiness";
// server-jarvis/src/index.ts:6754-6758
} catch (err: any) {
  if (!isNoisy) console.error(`[Jarvis API] …`);
  return Response.json({ error: err.message || String(err) }, { status: 500 });
}
```

If `loadConfig()` throws (malformed `config.json`), `/health` returns **500 with zero server-side log lines** — and `probe_jarvis_healthy` (`lib.rs:1001-1015`) treats a non-2xx as "not healthy", which drives the native respawn path that produces the EADDRINUSE ghost-socket state in DS-31.

**Why it matters:** the exact failure that must be diagnosable (config broken → health 500 → app says "Bun not running" → app respawns into a ghost port) is the one the logging policy deliberately suppresses.

**Proposed fix:** never suppress the log for `/health` — it is the one endpoint whose failure is acted upon automatically.

**Suggested check:** a test that a `/health` 500 produces a server-side log line.

### DS-33 — `loadConfig()` never caches a missing config, and a malformed config is re-read and re-logged every 5 s forever — S2 — READ

```ts
// server-jarvis/src/config.ts:1018-1036
try {
  if (existsSync(CONFIG_FILE)) { … configCache = normalizeConfig(raw); configCacheTime = now; return configCache!; }
} catch (e) { console.error("[Config] Load error, using defaults:", e); }
return defaultConfig();          // ← no cache write
```

Two problems: (1) **file absent** → `defaultConfig()` is returned and **never cached**, so every call rebuilds the ~330-line default object and re-runs `existsSync`; (2) **file malformed** → the catch logs and returns defaults, and because the cache is not populated on the error path, **every** subsequent call re-reads, re-parses, re-throws and re-logs — once per 5-second TTL window, forever.

**Why it matters:** the server runs on `llama_cpp.base_url = http://127.0.0.1:8080/v1` defaults while the UI shows the user's configured model. The log line is the only signal, and it repeats indefinitely.

**Proposed fix:** cache the failure too (with a shorter TTL), and surface "config unreadable — using defaults" as a first-class state rather than a log line.

### DS-34 — The conductor warm-up retry loop is unbounded and never `unref`'d — S2 — READ

```ts
// server-jarvis/src/index.ts:6783-6803
while (loadConfig().orchestrator.conductor.enabled) {
  try { … return; }
  catch (error) {
    attempt += 1;
    const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    console.warn(`[PersistentConductor] warm-up attempt=${attempt} failed; retry_ms=${retryMs}: …`);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
```

The `setTimeout` is **not** `unref`'d, so it holds the event loop open. If the model server never comes up, this retries **forever** at 30 s intervals, writing a WARN line each time — recorded at level INFO (DS-28).

**Why it matters:** it runs after `serve()`, so it does not delay the bind, but the server never becomes idle, never lets Bun exit cleanly on a stop signal, and produces unbounded log growth.

**Proposed fix:** `unref()` the timer, bound the retries, and stop once the conductor is known to be unavailable.

### DS-35 — Per-request cost: a new SQLite connection per store method, `claude --version` spawned per `/status`, agents root rescanned per `/agents` — S2 — READ

Three independent per-request costs, all confirmed by reading the code:

| Endpoint | Cost per request | Evidence |
|---|---|---|
| any `SelfTuningStore` method | **a fresh SQLite connection** — `getDb()` never caches the production connection (`self-tuning/store.ts:737-739`; `cachedDb` is only assigned in the in-memory branches) | `index.ts:6750` creates `new SelfTuningStore()` **per request**; `tuning-routes.ts:86-87` then calls `getPendingProposals()` + `getAppliedProposals()` + 2 methods **per proposal** ⇒ 1 + 2N connection opens for one `GET /tuning/proposals`, on a DB the code's own comment says is on a WSL ext4 mount (`store.ts:421-426`) |
| `/status` | **one `execSync("where claude")` + one `spawn("claude", ["--version"])`** (`claude-cli.ts:92-103`, `422-439`), plus an Ollama `/api/tags` probe, a llama.cpp `/models` fetch (no cache), an optional OpenRouter check and a TCP connect to the bridge | `index.ts:6224-6230` |
| `/agents` | **`readdirSync` of the agents root + `existsSync` + read + parse of every `soul.md`** — no cache, no memoization; and `findAgent()` scans again, so an activate request scans **twice** | `agent-lifecycle.ts:191-202`, `agent-routes.ts:25,132-134` |

Also worth noting: `total_requests` in `/status` counts **chat turns**, not HTTP requests (`index.ts:1822` increments inside `streamJarvis`; `index.ts:6305` reports it) — so it cannot be used to sanity-check request volume. And the router's top-level catch returns **raw `err.message`** (absolute paths included) to the browser (`index.ts:6758`).

**Proposed fix:** cache the SQLite connection in the store; cache the Claude CLI availability probe with a TTL; cache the agents-root scan; count requests at the router, not in the stream handler.

**Suggested check:** a test that N requests to `/tuning/proposals` open one SQLite connection, and that `/status` spawns no child process on a cached read.

---

## 5. What is already known, and what is still open

**Already established (DD-023, packaged runs, 2026-10-19):**
- Window up and responsive 4–6 s after launch.
- Bun server reachable ~21 s after launch (warm) / ~41 s (first run).
- The standalone bundled server is healthy in 0.5–2 s — **the server is not the slow part**.
- Split: ≈5 s pre-spawn health probe + ≈10 s child-process start + ≈0.2 s server boot.
- Leading hypothesis for the ≈10 s child gap: Windows Defender first-scan of the freshly extracted `bun.exe`/`index.js` — **not proven**.

**This document adds — 35 findings in four groups.**

*Structural causes of the delay*
- **DS-01** — Bun is started *after* the inference backend. The reason the app is unusable while it looks alive.
- **DS-02** — the ≈5 s pre-spawn probe is structurally removable.
- **DS-03** — ≈1 s of the first paint is a Python probe for an interpreter that only the lazily-used Hermes commands need.
- **DS-25** — 63 % of the server bundle (2.94 MB) is a tokenizer table that is only needed per turn, and it is parsed before `serve()` binds.
- **DS-26 / DS-29** — an import-time `cmd.exe` spawn and a 25-`ALTER` telemetry-schema run, both on the startup path.

*Standing waste*
- **DS-04 / DS-05 / DS-06 / DS-08 / DS-09 / DS-10** — a permanent stream of `wsl.exe` / HTTP / `git` subprocesses that is pure waste and, in three places, returns **wrong answers** (disk, memory and Ollama-model health are permanently broken).
- **DS-35** — a fresh SQLite connection per store method, `claude --version` spawned per `/status`, agents root rescanned per `/agents`.

*Errors that should not exist*
- **DS-15 / DS-16** — the banner says "Offline" and the footer says "SYS STOPPED" during a cold start that is working exactly as designed, and the two surfaces disagree with each other.
- **DS-17 / DS-18** — the direct-to-Bun boot read always fails and is shown as an error; there are no retry loops, so the stale error persists 15–30 s after the service recovers.
- **DS-30 / DS-31 / DS-32** — the Bun server has **no `unhandledRejection` handler** (an unhandled rejection kills it), **no `EADDRINUSE` handling** (a taken port dies with a raw stack), and **suppresses the log for `/health`** (the one endpoint whose failure is acted on automatically).
- **DS-23 / DS-24** — the app adopts an unverified server and leaves children behind on a hard kill.
- **DS-27 / DS-28** — the "guaranteed" self-log misses the startup banner and records every warning at level INFO.

*Weight*
- **DS-21** — 936 KB of boot-critical JS, including `framer-motion` for one 2 px indicator and the whole `highlight.js` stack for an empty transcript.
- **DS-11** — the migrations are ungated, but they measure at **~10 ms**. Not worth a brief on their own.

**Still open / unmeasured:**
1. The ≈10 s child-process start gap. **This document narrows it**: the server's own boot is 212 ms and the whole bundle loads in 1.9 s under app-like spawn conditions (§4), and the freshly extracted `bun.exe` accounts for ≈2.7 s cold. What is left is parent-side contention and/or the packaged install path. The instrumentation for it landed in `d83ee6f` / `55a5acd`; the measurement still needs an authorised packaged run.
2. Whether the parent-side contention is the WebView load, the TRACE-level logging (DS-07) or the boot health probes (DS-08) — all three land in the same window as the spawn.
3. The millisecond cost of parsing the 2.94 MB tokenizer literal (DS-25). The byte count is certain; the parse cost is not measured.
4. First-paint wall-clock on real hardware. The UI numbers in §3 are **bundle and request counts**, not timings.
5. Whether the packaged app's first `Bun.serve` bind is slowed by the 30 GB `mmap_size`/WAL settings (unlikely; unmeasured).

**Measurement caveat for anyone picking this up:** the packaged cold-start probe (`scripts/probe-cold-start.ps1`) has a hang of its own — a run on 2026-10-19 started at 23:47 and never finished within 15 minutes. Treat the **log-derived numbers** as the evidence, not the probe verdict, until the probe is fixed (DD-023 remains open for this).

---

## 6. Suggested backlog items

Each maps to one `DD-0xx` item in `C:\Projects\ops\backlogs\daedalus.md`. Ordered by expected startup win.

### Wave 1 — the delay (do these first)

| Doc ID | Suggested title | Sev | Size | Suggested check |
|---|---|---|---|---|
| DS-01 | Start the Bun server before/parallel to the inference backend | S1 | M | `cargo test` boot-order regression + packaged probe |
| DS-02 | Skip the pre-spawn health probe on a cold start | S1 | S | unit test: cold `ensure_jarvis_server_started()` performs zero probes |
| DS-03 | Move Python discovery off the pre-window path | S1 | S | test: `run()` spawns no subprocess before the window |
| DS-25 | Load the gpt-tokenizer table lazily — 63 % of the bundle is loaded before `serve()` | S1 | M | bundle-size assertion in the server build (target < 2 MB) |
| DS-07 | Cap the log plugin at Info and stop the 40 KB rotation from evicting the startup markers | S2 | S | grep check: no `reqwest` TRACE in `Jarvis.log`; startup markers survive |

### Wave 2 — the errors that should not exist

| Doc ID | Suggested title | Sev | Size | Suggested check |
|---|---|---|---|---|
| DS-30 | Add `unhandledRejection`/`uncaughtException` handlers to the Bun server — today an unhandled rejection kills it | S1 | S | test: the server survives an unawaited rejection |
| DS-31 | Handle `EADDRINUSE` at `serve()` instead of dying with a raw stack | S1 | S | test: a taken port produces a structured error |
| DS-32 | Never suppress the server-side log for `/health` — a health 500 is what drives the respawn loop | S1 | S | test: a `/health` 500 produces a log line |
| DS-15 | Give the backend the same startup grace the Bun server has (no "Offline" during a normal cold start) | S1 | S | `health-derivation.test.ts`: backend-down inside the grace window ⇒ `starting` |
| DS-16 | Stop the footer showing "SYS STOPPED" during the cold-start window | S1 | S | `system-telemetry-state` unit test: `starting`, not `stopped`, inside the grace window |
| DS-23 | Verify the adopted Bun server's `git_sha`/`built_at` before using it | S1/S2 | S | test: a foreign `git_sha` is not adopted silently |
| DS-17 | Do not render a direct-to-Bun boot read failure as an error | S2 | S | UI test: no error chip while the server is inside the startup grace window |
| DS-18 | Add a short backoff re-check inside the startup grace window | S2 | S | UI test: a recovered service clears its banner without a manual Retry |
| DS-13 | Surface WSL availability as a first-class health field | S3 | M | health test with WSL unavailable |

### Wave 3 — the standing waste

| Doc ID | Suggested title | Sev | Size | Suggested check |
|---|---|---|---|---|
| DS-04 | Stop probing WSL for local-only services | S2 | S | test: the Ollama port check never invokes `wsl.exe` |
| DS-05 | Fix `wsl_openclaw` so the disk/memory/health diagnostics run the right command | S2+S3 | M | unit tests for the new `wsl_run` + a health test that parses a real `df`/`/proc/meminfo` payload |
| DS-08 | Cache the WSL/HTTP probes in the health + status paths, and move them off the async worker | S2 | M | test: `get_system_health` spawns no subprocess |
| DS-06 | Cache/merge the two `wsl_home()` implementations | S2 | S | test: config load spawns no subprocess |
| DS-09 | Cache the build-info `git` call | S2 | S | test: repeated calls do not spawn `git` |
| DS-10 | Cut the supervisor's per-tick WSL probes | S2 | S | test: a supervisor tick spawns no subprocess |
| DS-26 | Replace the import-time `execSync("cmd.exe")` with `os.homedir()` | S2 | S | test: importing the config module spawns no process |
| DS-29 | Seed the scorecard after `serve()`, and version the telemetry schema so the 25 ALTERs run once | S2 | M | test: a second boot performs no `ALTER TABLE` |
| DS-33 | Cache the "config missing/malformed" path so it stops re-reading and re-logging every 5 s | S2 | S | test: a malformed config is logged once, not every TTL window |
| DS-34 | Bound and `unref` the conductor warm-up retry loop | S2 | S | test: the server idles when the conductor cannot warm |
| DS-35 | Cache the SQLite connection, the Claude-CLI probe and the agents-root scan | S2 | M | test: N requests to `/tuning/proposals` open one SQLite connection; `/status` spawns no child process |
| DS-24 | Put managed children in a Windows Job Object so a hard kill cannot orphan them | S2 | M | test: force-kill the parent, assert the child is gone |

### Wave 4 — the weight and the hygiene

| Doc ID | Suggested title | Sev | Size | Suggested check |
|---|---|---|---|---|
| DS-21 | Chunk the UI bundle and drop `framer-motion` + the markdown stack from the boot path | S2 | M | `npm run build` in `src-ui` + a chunk-size assertion in CI |
| DS-14 | One native health snapshot, one interval, one caller | S2 | M | test: only one health command is invoked per polling cycle |
| DS-27 | Install the self-log tee before the module graph, not after | S2 | S | test: the self-log contains the startup banner |
| DS-28 | Record `console.warn` at level WARN in the self-log | S2 | S | test: a warning lands in the self-log at level WARN |
| DS-19 | One session-list command and one shared boot cache | S3 | S | test: the Sessions page issues one session-list read on mount |
| DS-20 | Deduplicate `useCronJobs`/`GoalCronPage` and `ActionsPage`/`TrustedActionsPage` | S3 | M | one implementation per capability |
| DS-11 | Version-gate the migrations | S3 | M | test: second boot performs no DDL (**note: only ~10 ms today**) |
| DS-12 | Remove the hardcoded developer path from `find_jarvis_server` | S3 | S | test: the lookup never returns a hardcoded dev path |
| DS-22 | Give the companion store the in-flight guard the build-provenance store already has | S3 | S | test: one boot read under StrictMode |

---

## 7. File map — where the startup path lives

| Concern | File |
|---|---|
| Process entry, boot order, Bun spawn | `src-tauri/src/lib.rs` |
| DB open + migrations + skill seeding | `src-tauri/src/db/mod.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/commands/skills.rs` |
| WSL helpers (home, run, port probe) | `src-tauri/src/wsl.rs` |
| Managed child processes | `src-tauri/src/process_lifecycle.rs` |
| Watchdog | `src-tauri/src/supervisor.rs` |
| Health / status / build info | `src-tauri/src/commands/system.rs`, `src-tauri/src/jarvis/runner.rs`, `src-tauri/src/commands/jarvis_commands.rs` |
| Cron scheduler | `src-tauri/src/cron_scheduler.rs` |
| UI entry and shell | `src-ui/src/main.tsx`, `src-ui/src/App.tsx`, `src-ui/src/shell/Shell.tsx`, `src-ui/src/shell/Rail.tsx` |
| Health surfaces (the two that disagree) | `src-ui/src/features/system/HealthBanner.tsx`, `src-ui/src/features/system/health-derivation.ts`, `src-ui/src/features/system/SystemStatusBar.tsx`, `src-ui/src/domain/system-telemetry-state.ts` |
| Polling hook | `src-ui/src/hooks/usePolling.ts` |
| UI → Bun base URL | `src-ui/src/features/sessions/useSessionTurn.ts` and the feature modules that hardcode `http://127.0.0.1:19877` |
| Bun server entry + bind | `server-jarvis/src/index.ts` (6 803 lines, 116 imports, `serve()` at :6764) |
| Bun server startup work | `server-jarvis/src/config.ts`, `server-jarvis/src/tokens.ts`, `server-jarvis/src/self-log.ts`, `server-jarvis/src/self-tuning/store.ts` |
| Bun server request paths | `server-jarvis/src/claude-cli.ts`, `server-jarvis/src/agent-lifecycle.ts`, `server-jarvis/src/tuning-routes.ts` |
| Cold-start probe | `scripts/probe-cold-start.ps1`, `scripts/lib/probe-bounded-queries.ps1` |
| Existing backlog | `C:\Projects\ops\backlogs\daedalus.md` (item **DD-023**) |

---

## 8. Evidence appendix

### A. Commands run on the dev box (2026-10-21 / 2026-10-22 UTC)

| Measurement | Command | Result |
|---|---|---|
| Python discovery cost | `py -3 --version` / `python --version` / `python -c "print(1)"` | **932 ms** / 22 ms / 70 ms |
| WSL port probe cost | `wsl.exe -- python3 -c "<socket probe>"` | **119 ms**, exit `-1`, `ACCESS_DENIED` on the distro VHDX |
| WSL command cost | `wsl.exe -- bash -lc "openclaw which bun"` | **53 ms**, exit `-1` (same WSL failure) |
| DB boot cost | `bun run measure-db-boot.ts <copy of jarvis.db>` | open 0.5 ms, pragmas 8.4 ms, DDL sweep 0.1 ms, schema probes 1.6 ms |
| Bun child start (app-like spawn) | `powershell -File measure-child-start.ps1 -Port 19899 -Runs 2` | spawn returned 92 ms / 6 ms; **health OK at 1 918 ms / 1 912 ms** |
| Server's own boot | `server-jarvis.self.log` timestamps | first log line → `Listening` = **212 ms** |
| Cold `bun.exe` exec | `bun --version` (first run of the session) | **2 665 ms**; warm re-runs 15–23 ms |
| Log content | `Get-Content %LOCALAPPDATA%\com.jarvis.desktop\logs\Jarvis.log` | 14 362 bytes, 100 % `reqwest` TRACE/DEBUG, **0** `jarvis::startup` lines |
| Probe cadence | same file, timestamps | `127.0.0.1:19877` probes at 22:19:05 / :09 / :14 / :20 / :35 / :51, 22:20:07 / :20 → ~15 s apart |
| Port :19877 occupant | `Get-CimInstance Win32_Process -Filter "ProcessId = 2192"` | `bun.exe "…\OneDrive\Desktop\index.js"`, parent `cmd.exe /c tsx scripts/smoke.ts RoomNew-Wide` (gone) |
| Listener identity | `Invoke-RestMethod http://127.0.0.1:19877/health` | `git_sha a670ffa…`, `built_at 2026-10-21T18:11:14-04:00`, uptime 17 799 s |
| Orphaned child | `Get-Process -Id 21184` | `llama-server`, started 18:15:52, still running with no app process alive |
| App log size | `Get-ChildItem %LOCALAPPDATA%\com.jarvis.desktop\logs` | `Jarvis.log` 14 KB; `server-jarvis.self.log` **6.8 MB**; `server-jarvis.log` 1.7 MB; `claude-proxy.log` 434 KB |
| UI bundle | `src-ui/dist` | 1.99 MB total; entry 448 KB + shared markdown 327 KB + SessionsPage 157 KB; **no manual chunking** in `vite.config.ts` |
| DB size | `%USERPROFILE%\.local\share\com.jarvis.desktop\jarvis.db` | 3 112 960 bytes, 26 real tables |
| Server bundle | `server-jarvis/dist/index.js` | **4 685 354 B**, 47 508 lines; 129 transitive modules / 2.34 MB of source; **116 top-level imports**; 179 top-level statements, 0 top-level `await` |
| Tokenizer share of the bundle | bytes of `dist/index.js:7172-10431` | **2 942 494 B = 63 %** of the bundle (`gpt-tokenizer` `o200k_base` BPE table) |
| Unhandled rejection kills the server | `bun -e "Promise.reject(new Error('boom-unhandled')); setTimeout(...)"` | `error: boom-unhandled`, **exit code 1**, the `setTimeout` never ran |
| `serve()` on a taken port | `Bun.serve` on an occupied port (Bun 1.3.12) | **throws synchronously**: `code= EADDRINUSE`, `msg= Failed to start server. Is port … in use?` |
| Self-log records WARN as INFO | inline harness reproducing `index.ts:338-348` | `2026-10-22T03:11:20.178Z INFO FMT-WARN this is a WARNING` |
| Server startup footprint | `server-jarvis/src/**` read | **5 files** touched at startup, **0** directory scans, **0** network calls before the bind; up to **2 400** `model_attributions` rows in the scorecard seed |

### B. Grep confirmations

| Claim | Command | Result |
|---|---|---|
| No schema version gate | `rg "user_version" src-tauri/src` | **0 hits** |
| Migration statement volume | counts in `db/migrations.rs` | 50 `CREATE TABLE`, 65 `add_column_if_missing`, 58 `execute_batch` |
| WSL probe on local ports | `lib.rs:1350-1368` | `is_port_listening` → `is_wsl_port_listening` unconditionally |
| Broken `openclaw` prefix | `wsl.rs:256` | `format!("openclaw {joined}")` |
| Two `wsl_home()` | `lib.rs:36`, `wsl.rs:218` | `lib.rs` cached (15 s), `wsl.rs` **uncached** (5 s) |
| Log plugin defaults | `tauri-plugin-log-2.8.0/src/lib.rs:46-52` | `DEFAULT_MAX_FILE_SIZE = 40000`, `KeepOne`, `UseUtc`, no level filter → `Trace` |
| Two commands, one SQL | `commands/sessions.rs:817`, `commands/jarvis_commands.rs:1051` | both call `list_session_rows(&db)` |
| Startup grace asymmetry | `health-derivation.ts:52-56` | grace on `bun_server_running`, **not** on `backendOk` |
| Footer "stopped" rule | `domain/system-telemetry-state.ts:417-418` | `bun`/`bridge` are `ALWAYS_REQUIRED` ⇒ `stopped` |
| No retry loops | inventory of `setTimeout` in `src-ui/src/**` | 0 retry loops; only toast/scroll/turn timers |
| Import-time `cmd.exe` spawn | `server-jarvis/src/config.ts:538-551, 564` | `execSync("cmd.exe /c echo %USERPROFILE%")` inside a module-level `const` initializer |
| Self-log installed after the imports | `server-jarvis/src/index.ts:8-12` | `installSelfLog()` is a statement, not an import — ESM hoisting runs the 129 modules first |
| `console.warn` → INFO tee | `server-jarvis/src/index.ts:346`, `self-log.ts:75-76` | the warn tee is replaced and never called |
| No rejection handler | grep `process.on("unhandledRejection"` in `server-jarvis/src/**` | **1 hit, in a test file** — none in production |
| `serve()` unguarded | `server-jarvis/src/index.ts:6764-6775` | no `try/catch`, no `error` handler, no retry |
| `/health` errors suppressed | `server-jarvis/src/index.ts:6327, 6754-6758` | `isNoisy` includes `/health` and `/status` |
| Config never cached on failure | `server-jarvis/src/config.ts:1018-1036` | the error path returns `defaultConfig()` without writing the cache |
| Per-request SQLite churn | `server-jarvis/src/self-tuning/store.ts:737-739` | `getDb()` opens a new `Database` and never caches the production connection |
| `/status` spawns a child | `server-jarvis/src/index.ts:6224-6230` → `claude-cli.ts:92-103, 422-439` | `execSync("where claude")` + `spawn("claude", ["--version"])` per request |
| Agents root rescanned per request | `server-jarvis/src/agent-lifecycle.ts:191-202` | `readdirSync` + per-agent `soul.md` parse, no cache |
| `total_requests` counts turns | `server-jarvis/src/index.ts:1822` vs `:6305` | incremented inside `streamJarvis`, reported as request count |

### C. Not done (deliberately)

- The packaged app was **not** launched for this document; no new packaged cold-start numbers are claimed beyond what DD-023 already recorded.
- The ≈10 s packaged child-start gap was **not** re-measured — only narrowed (§4).
- The `probe-cold-start.ps1` hang is **not** fixed here.
- The lingering `bun.exe` (PID 2192) and `llama-server` (PID 21184) on this box were **not** killed — they are the evidence for DS-23 and DS-24.
- No source file was modified.

### D. Reproduction scripts

Both scripts were run on the dev box on 2026-10-21 and are the basis for the MEASURED rows above. They are throwaway and were kept out of the repo; paste them into a scratch directory to re-run.

**D.1 — DB boot cost** (used for DS-11). Run against a **copy** of `jarvis.db`, never the live file.

```ts
// measure-db-boot.ts  →  bun run measure-db-boot.ts <path-to-copy-of-jarvis.db>
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

const dbPath = process.argv[2];
if (!existsSync(dbPath)) { console.log("MISSING_DB"); process.exit(0); }

const t0 = performance.now();
const db = new Database(dbPath);
const t1 = performance.now();

db.exec(
  "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 30000000000; PRAGMA cache_size = -20000;",
);
const t2 = performance.now();

const tables = (
  db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
).filter(
  ({ name }) =>
    !name.startsWith("sqlite_") &&
    !/(_fts_|_data$|_idx$|_docsize$|_config$|_content$)/.test(name),
);
const t3 = performance.now();

const ddlStart = performance.now();
for (const { name } of tables) db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (x)`);
const ddlEnd = performance.now();

const probeStart = performance.now();
for (const { name } of tables)
  db.query(`SELECT COUNT(*) FROM pragma_table_info('${name.replace(/'/g, "''")}')`).get();
const probeEnd = performance.now();

console.log(JSON.stringify({
  db_bytes: statSync(dbPath).size,
  table_count: tables.length,
  open_ms: +(t1 - t0).toFixed(1),
  pragmas_ms: +(t2 - t1).toFixed(1),
  list_tables_ms: +(t3 - t2).toFixed(1),
  noop_ddl_sweep_ms: +(ddlEnd - ddlStart).toFixed(1),
  pragma_probe_sweep_ms: +(probeEnd - probeStart).toFixed(1),
}, null, 2));
db.close();
```

**D.2 — Bun child start under the app's spawn conditions** (used for §4 and DS-25). Uses a non-default port so it never collides with the app.

```powershell
# measure-child-start.ps1  →  powershell -File measure-child-start.ps1 -Port 19899 -Runs 2
param([int]$Port = 19899, [int]$Runs = 2)
$ErrorActionPreference = 'Stop'
$bundle = 'C:\Projects\home-base-recovered\server-jarvis\dist\index.js'
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"

for ($run = 1; $run -le $Runs; $run++) {
    $dir = Join-Path $env:TEMP "daedalus-childstart-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $entry = Join-Path $dir 'index.js'
    Copy-Item $bundle $entry -Force
    $out = Join-Path $dir 'server-jarvis.log'
    $err = Join-Path $dir 'server-jarvis.err.log'
    New-Item -ItemType File -Path $out -Force | Out-Null
    New-Item -ItemType File -Path $err -Force | Out-Null

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $bun
    $psi.Arguments = "`"$entry`""
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['JARVIS_SERVER_PORT'] = "$Port"
    $proc = [Diagnostics.Process]::Start($psi)

    $outStream = [IO.File]::AppendAllText
    $proc.add_OutputDataReceived({ param($s, $e) if ($e.Data -ne $null) { $outStream.Invoke($out, $e.Data + "`n") } })
    $proc.add_ErrorDataReceived({ param($s, $e) if ($e.Data -ne $null) { $outStream.Invoke($err, $e.Data + "`n") } })
    $proc.BeginOutputReadLine(); $proc.BeginErrorReadLine()
    $spawnReturned = $sw.ElapsedMilliseconds

    $firstLogAt = $null; $healthyAt = $null
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq $firstLogAt -and (Test-Path $out) -and (Get-Item $out).Length -gt 0) {
            $firstLogAt = $sw.ElapsedMilliseconds
        }
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $healthyAt = $sw.ElapsedMilliseconds; break }
        } catch { }
        Start-Sleep -Milliseconds 100
    }

    Write-Output ("run {0}: spawn_returned={1}ms first_child_log={2}ms health_ok={3}ms" -f `
        $run, $spawnReturned, $(if ($null -eq $firstLogAt) { 'n/a' } else { $firstLogAt }), `
        $(if ($null -eq $healthyAt) { 'TIMEOUT' } else { $healthyAt }))

    try { $proc.Kill() } catch { }
    Start-Sleep -Milliseconds 400
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}
```
- No source file was modified.
