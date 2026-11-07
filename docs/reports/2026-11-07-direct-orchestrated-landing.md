# Direct versus Orchestrated: implementation review and landing

Date: 2026-11-07. Reviewed code: `da8559b` on
`codex/direct-orchestration-landing`, based on `master` at `f681841`.

## Scope

Land the comparison implementation from Astra's shared branch through
`fcb32ac`, its prerequisite routing/cloud-boundary/tool-wire fixes, and the
Direct-attribution portion of `65c050e`. The unfinished Orchestration settings,
stage-selection policy, private diagnostic endpoints, and Native-surface work
were excluded. No Rust files changed in this landing candidate.

The comparison contains four frozen tasks, three alternating warm pairs per
task (24 observations), two process-cold observations, and two warm-ups. It
retains raw SSE, provenance, outcomes, independent acceptance, and failures.
The real-model experiment has **NOT RUN**.

## Review findings resolved

1. `/config` returns a bare configuration, not a health envelope. Readiness now
   validates endpoint-specific response shapes and checks the intended mode,
   model alias, endpoint, and resident-conductor settings.
2. Bun could autoload repository dotenv files after the environment allowlist.
   Isolated launches use `--no-env-file` and `--no-install`; credentials,
   proxies, and implicit dependency downloads cannot be introduced that way.
3. The runner could not start against the existing broad default bind. Bun now
   accepts `JARVIS_SERVER_HOST` without changing its normal default. Dedicated
   children use loopback, and health reports the same target passed to
   `serve()`. Static and runtime checks precede capture.
4. A generation-only POST config reset both modes to server defaults because
   the server normalizes overrides independently of its loaded configuration.
   Every capture now supplies its complete validated mode-specific snapshot
   through the required capture-worker `--config-json` input.
5. Background conductor warming contaminated process-cold observations. Both
   modes point the conductor at the dedicated model and disable background
   warming, API fallback, and session/KV persistence. On-demand routing remains
   available; the ordinary keep-warm default is unchanged.
6. Native stage samplers and local token floors overrode the requested task
   settings. An optional `comparison_generation` policy applies final request
   values to Direct, orchestration stages, and the resident conductor. It is
   absent from normal defaults. The frozen corpus uses 4,096 completion tokens
   per model invocation, temperature 0, and top-p 1; the per-turn wall cap is
   120 seconds. The policy is persisted identically in both isolated modes.
7. Orchestrated tool activity lacked canonical SSE receipts. The pipeline now
   publishes attempted calls and results, including cache, suppression, and
   denial branches. The diagnostic hook preserves the distinction between a
   cached result and Native memory's actual-runtime evidence. Metrics reporting
   more calls than captured receipts cause the campaign to stop.
8. Parsing a missing tool-call ID twice created two identities. Dispatch now
   passes the already normalized call into execution, keeping the trace,
   runtime result, and Native callback IDs consistent.
9. Extra llama arguments could replace the hashed artifact or network target.
   A validated local tuning allowlist preserves supported hardware options
   while excluding alternate artifacts, model URLs, RPC, and bind overrides.

## Verification

| Check | Result |
| --- | --- |
| Python harness unittest suite | 68 passed |
| Python compileall | Passed |
| Targeted Bun config/conductor/generation/tool-trace/runtime tests | 151 passed |
| Full Bun suite | 3,901 passed, one existing Windows platform skip, zero failures |
| Full UI suite | 1,961 passed across 194 files |
| Server typecheck and production bundle build | Passed |
| UI typecheck and production build | Passed |
| Full candidate diff whitespace check | Passed |

The full Bun run used clean verification checkout
`C:/astra-wt/daedalus-comparison-verify-4ca2407` at `906ae5d`.
Its complete `server-jarvis` Git tree is identical to `da8559b`:
`ee9d7a3646ab83e7232337dcb4ef9fee66dadae0`.
The UI run used `4ca2407`; its complete UI tree also matches `da8559b`:
`fb370950e065adabfa3e2045c16a78898374d270`.
The Python suite ran against `da8559b`.

Earlier attempts are not counted as green: an old bind wiring assertion was
updated with the intentional host override; the tokenizer packaging test
requires an ancestor tree without `node_modules`, so the full verification
checkout was placed outside the user's directory containing global modules;
an unchanged Windows shell-startup timing test failed once and passed alone.
The final full server run passed without weakening or skipping that test.

Real owned Bun processes with a deterministic loopback HTTP fixture verified
Direct success, HTTP failure, cancellation, and Orchestrated success, including
actual route attribution and effective 16/0/1 request settings in the small
regression fixture. A separate end-to-end Python-capture smoke confirmed
`agent_loop` for Direct and `synthesizer` for Orchestrated, with the same local
fixture alias and no cloud hop. The Direct-attribution regression was also
observed failing when its implementation was removed, then passing when
restored. These are controlled runtime checks, not model-quality measurements.

Local logs, synthetic captures, and the review record are retained under
`C:/Users/ethan/.agent-router/runs/daedalus-comparison-landing-20261107/`.
Development bundles report `git_sha=dev`; no installed-build provenance is
claimed.

## Independent review

Sol reviewed the implementation and identified the readiness, environment,
generation, and tool-evidence gaps. After the fixes it reviewed `da8559b` and
returned **LAND**, with no remaining concrete landing blocker. The driver
independently reran checks and inspected the changes.

One text-only Grok review was attempted at medium effort. It produced no
verdict within the bounded run and was terminated using its exact owned
process. It is not counted as a successful review and was not retried.

## Acceptance boundaries

This lands source and its verification. No actual GGUF/model performance run,
packaged application test, production configuration change, installation, or
cloud-path test was performed. The experiment still requires explicit hashed
model/server artifacts and its recorded independent acceptance results.

Attempt counts in reports mean emitted route records. Resident-conductor calls
without per-attempt SSE are not invented or counted as a complete inference
total; elapsed wall time includes their work. Missing token fields remain
unknown. The small corpus cannot establish general superiority.

Roadmap priority #3 remains active. Memory, Goal execution, learning transfer,
and real-workflow acceptance gates remain open. This supporting reliability
interruption does not satisfy them.
