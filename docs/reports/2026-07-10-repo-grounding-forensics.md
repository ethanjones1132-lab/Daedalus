# Repo-grounding hallucination forensics — 2026-07-10

## Corrected incident record

The 2026-06-26 diagnosis combined two different sessions and therefore overstated one symptom.

The persisted desktop session `be1252e0-487e-4f4f-a354-f76391ba91f4` explicitly targeted `C:\Users\ethan\Versutus`. Before its Expo answer, the assistant reported a successful directory enumeration containing `app.json`, `eas.json`, `src/`, `assets/`, and Expo/TypeScript files. Its later Expo/app.json answer was a continuation of that Versutus session, not a hallucination about home-base.

The actual ungrounded home-base failure is the separate direct-probe session `28dba50f-a2cf-4cfb-83ea-78412f739185`, run `run_25dee282-c5d3-4747-98ed-85c50ca4ca0c`, created at `2026-06-26T05:20:00.393Z`:

- request: “Give me a two-sentence summary of this repo, then name one file you would inspect first to understand the runtime path.”
- canonical pipeline: `["synthesizer"]`
- tool calls: 0
- only stage: synthesizer, 15,398 ms
- fabricated output: `jarvis/orchestrator.py`

That is a clean reproduction artifact: repository claims were synthesized with no workspace evidence.

## Root cause

Three runtime gaps combined:

1. A coordinator parse fallback could collapse a repository-inspection request to a synthesizer-only pipeline.
2. `PipelineExecutor` treated plausible executor/synthesizer prose as success even when no read-only workspace tool had succeeded.
3. Shared context and session-memory hints were not consistently provenance-bounded to the active workspace; retrieved context could also be omitted when no custom worker instruction was present.

The failure was therefore not merely “the model needs a disclaimer.” The activation boundary allowed unverified prose to become the final answer.

## Fix

- The raw-turn requirement is passed into `PipelineExecutor`.
- A `workspace_read` turn must contain at least one successful `read_file`, `list_directory`, `glob`, or `grep` result.
- If the first executor response contains only prose, Jarvis sends one bounded tool-use nudge. If the retry still produces no evidence, the run fails with `error_code=missing_workspace_evidence` and synthesis is not called.
- Workspace-read turns do not use speculative paths that could synthesize before evidence is authoritative.
- Session tool results and discovered facts carry a normalized workspace root and are excluded when the active root differs.
- The active filesystem workspace root is sent to the Coordinator and worker shared context.
- Retrieved shared context is injected even when a stage has no custom instruction or distilled skill.
- Replan slices preserve the same requirement, so recursive/replan paths cannot bypass the fence.

## Verification

Regression tests reproduce the exact `jarvis/orchestrator.py` fabrication and prove that it receives one bounded retry, then fails without calling synthesis. Companion tests prove successful read evidence reaches synthesis, an executor-only route cannot bypass the fence, answer-only turns are unaffected, workspace roots are normalized/scoped, and context is injected without custom instructions.

The full Bun suite passes: 725 tests, 0 failures across 71 files. A live source turn read `CONTEXT.md` and returned the exact first heading `# Jarvis (home-base)`.

Docs and evidence diverge here: `NEXT_AGENT_JARVIS_LIVE_MODEL_DIAGNOSIS_2026-06-26.md` lines 64–72 should no longer be read as one incident. The `jarvis/orchestrator.py` probe was real; the Expo/Versutus answer belonged to a correctly targeted different workspace.

