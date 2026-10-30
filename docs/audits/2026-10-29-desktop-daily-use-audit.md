# Desktop inference and daily-use walkthrough — 2026-10-29

## Scope and provenance

Interactive Windows computer-use walkthrough of the newest existing executable found in this checkout: `src-tauri/target/release/home-base.exe`, built 2026-10-21 18:11 EDT from `a670ffa099c0334a17930ac3c4189e6d6be43525` according to its own provenance display. SHA-256 `98c25126f39f25c8dc5630d75dabad88ded939c574133ef451929974ee6908b1`. Repository HEAD was `74b756ebe` and the app explicitly reported stale build provenance. The paired release `index.js` SHA-256 was `bdc30b37eaba98dc05bd5a8d17d1841dc9463dfab582578e1b629f8aadd7da15`; its source revision was not independently established. These are packaged-build observations, not proof of current-source behavior. No rebuild, installation, configuration change, approval, or scheduled job execution was performed.

Starting the application launched its Bun server and local llama-server. The walkthrough created two test Sessions; it left those records and the app running. Launch also displayed existing missed jobs and registry notifications; no job or action was manually dispatched. Time below is UTC as recorded in `C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\server-jarvis.self.log`.

## Findings

1. **High — selected local backend does not describe the actual route while a turn is running.** Settings described llama.cpp as the engine answering new Sessions; the Session header and streaming footer showed `llama_cpp` and `Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf`. For two simple prompts, the log instead selected OpenCode Zen's `deepseek-v4-flash-free`, received HTTP 400 model unavailable, tried `nemotron-3-ultra-free` with the same result, and fell back to `openrouter/free`. The second Session updated its header and footer to OpenRouter **after** termination, so final attribution was visible but the live label and local-backend selection did not disclose the actual provider before or during routing. Settings does mention provider keys are used by a fallback cascade; it does not make the per-turn route clear at submission. Session `6d9f0a4d-e04a-4233-aeab-73b7ab94f04a`, log 02:05:51–02:06:00. This test contained only nonsensitive text. Verify current build and clarify local-only control and pre-send disclosure before relying on privacy or model selection.

2. **High — trivial inference finished partial after a long stream.** In a new Session, send `What is 2 plus 2? Reply briefly.` The answer `4` appeared after roughly 11 seconds; the UI still showed receiving/streaming after 26.8 seconds and later ended as `PARTIAL inference_partial`, with a recorded partial run. A correct one-character response is useful, but this is not a clean completed turn. The run used the fallback route above; the specific reason for the partial state was not established. Logs show 1,733 tokens in the UI and model `openrouter/free`. Test local direct inference and reliable terminal-state delivery separately.

3. **High — contradictory readiness and obsolete bridge dependency.** Health simultaneously displayed `READY / All systems ready` and a stopped Bridge marked `Required by the active Inference backend`; the footer reported `SYS STOPPED` on that basis. Gateway explicitly says port 19876 is a legacy probe and Session turns do not pass through it. A recovery announcement also said all services required by llama_cpp were running while the footer marked the bridge down. Determine authoritative requirements and compute a consistent readiness verdict. Bun status also fluctuated during this run; at one point it restarted (PID 20568 replaced by 24568, new log startup 02:02:32), but the cause and whether automatic restart is expected were not determined.

4. **High — resource and inference telemetry unavailable, with contradictory claims.** Overview showed memory `Not measured` and disk `? of ?`; footer showed `MEM —`, `DSK —`, `INF UNAVAILABLE` yet its stopped verdict claimed memory and disk use were high. Health displayed `0%` and `0 / 0 MB` while the other surface said memory could not be measured. This can lead operators to act on an invented measurement. The inference telemetry Retry control was present; its recovery was not tested.

5. **High — Agent discovery unavailable.** Agents showed `DISCOVER failed`, `The Agents root could not be scanned`, and `Agent discovery is unavailable`; validation, projection and activation remained pending. One separate persisted Agent card was visible and enabled. The UI did not provide a specific root path or error cause. No conclusion that the existing Agent cannot answer follows from this alone.

6. **High — alert delivery is degraded.** Persistent banner: `Some Action registry alerts cannot reach you right now`, specifically new registry alerts and missed-cron warnings. Channel delivery telemetry also reported unavailable. Their common cause, if any, was not established. Alert ledger itself loaded, so distinguish stored alerts from live delivery.

7. **Medium — stale approval alert presented as current.** The Action Registry alert ledger and persistent toast said the WallSlayer diagnostic requires user approval; the corresponding action card showed `APPROVED` and registry summary showed zero pending approvals. The ledger entries were dated 2026-06-21, so they may be historical, but the toast does not convey that distinction. Do not infer current approval state from this notification without authoritative readback.

8. **Medium — Cron cannot be relied on without reconciliation.** Cron listed three enabled jobs, all with missed occurrences 101–111 days overdue, alongside `No enabled job is scheduled to run in the next 24 hours`. The page explicitly says missed runs await trigger or dismissal. This is a currently blocked operational state rather than proof the scheduler is broken; no triggers or dismissals were attempted. Determine whether next-run timeline should explain the unresolved missed-run dependency.

9. **Medium — skill lifecycle status unavailable.** Skills listed 71 installed and 20 enabled; many distilled entries displayed `Lifecycle observation unavailable`, with no toggle. The bundled skills list itself loaded. Candidate promotion and lifecycle authority were not exercised.

10. **Medium — model and profile identity confusing.** New Sessions called the local backend `Gemma 4 · llama.cpp` while the actual configured local model alias was Qwen. Inference displayed `owl-alpha` OpenRouter as `ACTIVE PROFILE` while Settings selected llama.cpp and the Session displayed Qwen. The Inference page notes that backends are chosen separately in Settings, and Agents explicitly says its card model does not drive orchestrator routing. The relationship between active profile, backend, Agent field, and actual per-stage model remains hard to infer from the initial flow.

11. **Medium — Project Steward unusable with existing selection state.** It reported no persisted Session with an enabled Agent and validated project workspace; task and criterion inputs and Create Goal were disabled. It instructs the user to open Chat, choose an Agent and bind a workspace. This is a prerequisite, not evidence the feature is broken. No binding or Goal was created. A separately logged default active workspace on a test turn is not evidence of the required native binding.

12. **Low — stored memory quality is poor.** Memory Overview showed five old hot records, including content `!` with confidence 0.98, fragments such as `plan in the folder`, and a test record. This is evidence of the displayed historical data, not proof that these records are injected into current scoped turns. Both test turns reported `Memory: no matches`; the log recorded an empty envelope. Cross-Session recall, correction, isolation and persistence were not tested.

## Surface inventory and limits

| Surface | Observation |
| --- | --- |
| Sessions | Two test Sessions created; one partial answer; see findings. First test was abandoned by navigating away, followed by a generic `undefined` stream error at 02:01:53. Navigation confounds its cause. Reopening showed only the user message. |
| Overview | Loaded counts and recent Sessions; reported Bun and Ollama running, Bridge offline, resource values unmeasured. |
| Learning | Loaded research form. Requires a persisted Session, exact completed Agent run and question; Tier-1 host allowlist and bounded retrieval disclosed. No research run attempted. |
| Agents, Skills, Memory, Inference | Loaded; limitations above. No lifecycle mutations, profile activation, recall searches, or memory changes attempted. |
| Goals | Zero records; create form available, page says completion requires verified evidence and is not available yet. No Goal created or acceptance exercised. |
| Cron, Actions | Existing records loaded; limitations above. No dispatch, sync, run, dismissal, or approval performed. |
| Hooks, Commitments | Loaded empty lists and creation controls; registration and execution untested. |
| Approvals | Explicitly identified as a legacy store, not the live Session tool approval gate; zero in last read. Live approvals untested. |
| Channels | Zero configured; delivery telemetry unavailable. No Discord delivery tested. |
| Plugins, MCP | No plugins or MCP servers shown; integration behavior untested. |
| Devices, Nodes | Zero records. UI says device status is recorded rather than live, and nodes are not pinged. Pairing, connectivity and distributed inference untested. |
| Health, Settings | Loaded; health inconsistencies above. Settings exposed backend, keys (masked), model and orchestration controls; none changed. |
| Gateway, Hermes | Legacy Gateway reported stopped and says Session turns do not use it. Legacy Hermes Bridge reported unavailable. Neither was operated. |

The companion was visible; its detailed interactions, subordinate tabs and dialogs, mutations, restart persistence, real workflows, tool execution, cloud-provider configuration, and current-source build were not comprehensively tested. This inventory is an exploratory baseline, not exhaustive acceptance. Priority #1 and #2 runtime acceptance, #3 empirical learning campaign, and #4 real-task acceptance remain open as specified by the roadmap.
