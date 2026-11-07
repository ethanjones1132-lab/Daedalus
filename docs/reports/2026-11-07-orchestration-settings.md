# Orchestration Settings source review and landing

Date: 2026-11-07. Source checkpoint: `202e558` on `codex/orchestration-settings-landing`, based on the comparison landing `e35a3d3`.

Ethan requested the same review and landing as the comparison implementation, **without live testing and verification**. This landing uses source review and compilation/build checks only. No test suite, model, application, diagnostic request, or packaged acceptance run was executed for it. Installed configuration and the original author worktree were not changed.

## Delivered source

- Settings controls for Direct/Orchestrated mode, six stage primaries, ordered per-stage fallback lists, Automatic reset, and cloud helpers (absent means off). Explicit policies apply to Orchestrated turns; the UI retains them in Direct mode.
- Validated explicit stage routing through the shared target transport, closed custom chains, local/cloud checks, and protection against resident-coordinator/executor-delegate bypasses of explicit policy.
- An owned-Native, bounded, fixed-prompt draft route diagnostic. It returns attempts and rejections without creating a Session or invoking the Tool runtime, memory capture, or learning lifecycle.
- Canonical SQLite save/readback, Bun projection and bounded routing-fingerprint acknowledgement. UI distinguishes persistence from confirmed Bun synchronization and preserves submitted edits when readback is unconfirmed.
- Prior comparison-generation controls, tool evidence, Direct attribution, and local-routing repairs remain in the candidate.

## Provenance and review repairs

Imported original settings commits `a441f6a`, `65c050e`, `6af3abf`, and `acf0110` as `2501720`, `ac2b631`, `9df5ebe`, and `94a25e0`. The two `index.ts` cherry-pick conflicts retained the comparison imports and the extended forced-target attempt signature.

The eleven UI files were copied from the uncommitted author worktree at `C:/astra-wt/daedalus-routing`, whose HEAD was `acf0110065d5498b99ec8326d7f8b24166675045`. A SHA-256 manifest is retained outside the repository at `C:/Users/ethan/.agent-router/runs/daedalus-settings-landing-20261107/ui-source-snapshot.json`. The source snapshot was checked for drift; the author worktree was left untouched. Landing repairs are recorded in `202e558`.

Independent Sol source review initially held the landing and then returned **LAND**, with no remaining concrete landing blockers, after these repairs:

1. Native save now retains the projection-success boolean. A committed SQLite save with failed Bun file projection reports `bun_config_projection_failed`, skips the stale reload acknowledgement, and cannot claim runtime sync.
2. Diagnostic cancellation records a bounded, expiring marker when Cancel arrives before registration. A later request with that ID makes zero inference attempts during the marker window; unrelated active probes are unaffected. Cancellation acceptance does not itself prove an inference request has settled.
3. A failed forced Ollama attempt starts with local Ollama attribution rather than inheriting a cloud label.
4. An unconfirmed authoritative Native readback no longer lets the UI fetch old cached state and discard submitted edits.
5. A stale llama.cpp alias is displayed honestly, with an explicit repair action; cloud-blocked warnings match the local-backend boundary rather than mislabeling an already selected cloud backend.

Luna implemented the scoped Native projection and diagnostic cancellation repairs; the driver inspected their diffs and integrated them. Regression test source covers projection failure, pre-registration cancellation and bounds, failed readback, alias repair, and cloud warning behavior. **Those tests were not executed for this landing.** No successful cross-vendor review verdict is claimed; an earlier Grok attempt during the preceding comparison landing did not return a verdict and was not repeated here.

## Checks executed

All commands below completed with exit code 0 on the final production-source candidate before the documentation commit. These are compilation/build checks, not behavioral acceptance.

| Surface | Command | Result |
|---|---|---|
| Bun server | `bun run typecheck` | PASS |
| Bun server | `bun run build` | PASS; 221 modules bundled |
| React UI | `bun run build` | PASS; TypeScript and Vite, 2,879 modules |
| Rust/Tauri | `cargo check --tests --offline` | PASS; test targets compiled, tests not run |
| Source whitespace | `git diff --check` | PASS |

Rust emitted four existing warnings: an unused memory-engine `HashMap` import and unused assignments in `trusted_acceptance`. Development bundles were built; no installer was built, installed, or launched.

## Open acceptance and limitations

- Settings tests, Native contract tests, full regression suites, desktop/narrow rendering and focus inspection, actual Native diagnostic forwarding, save/reload persistence in a running app, failure/cancellation behavior, and cloud/model routes remain **NOT RUN** for this landing.
- The existing singleton `PersistentConductor(loadConfig)` still reads global configuration. A save may therefore affect an in-flight conductor path. The plan's complete per-turn snapshot invariant remains open; this landing does not certify it.
- A source-level route diagnostic cannot establish answer quality, end-to-end Session performance, packaged behavior, or the usefulness of orchestration. The real-model paired comparison remains open under the separate comparison plan.
- Priority #3 remains active/incomplete, and all earlier roadmap runtime, real-task, and empirical acceptance gates stay open. The plan's compound runtime/test checkboxes are not closed by source delivery.

The user authorized source landing and push separately from these pending acceptance steps. The managed landing worktree is retained for inspection.
