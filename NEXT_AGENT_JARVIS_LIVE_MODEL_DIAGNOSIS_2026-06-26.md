# Jarvis Live Model Diagnosis - 2026-06-26

## Scope

This report is based on the real Windows desktop runtime:

- Desktop app launched from `C:\Users\ethan\OneDrive\Desktop\Jarvis.exe`
- Live Bun server script at `C:\Users\ethan\OneDrive\Desktop\index.js`
- Repo under inspection: `C:\Projects\home-base-recovered`
- Local persistence: `%USERPROFILE%\.local\share\com.jarvis.desktop\jarvis.db`
- Desktop logs:
  - `C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\server-jarvis.log`
  - `C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\server-jarvis.err.log`
  - `C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\Jarvis.log`

## Real Runtime Facts

- `Jarvis.exe` was running while this audit was performed.
- The server health endpoint was confirmed at `http://127.0.0.1:19877/health`.
- The desktop runtime really was using `bun.exe` against `C:\Users\ethan\OneDrive\Desktop\index.js`.
- During the investigation, the Bun process disappeared once and had to be relaunched manually.

## What Was Reproduced

### 1. Coordinator failures were common

`server-jarvis.log` repeatedly showed:

- `Coordinator: Routing parse failed, using default route`

Before the fix in this session, that default route was:

- `planner -> executor -> synthesizer`

That meant a coordinator failure immediately shoved the user into the noisiest and least reliable path.

### 2. Internal planner content leaked into the user-visible transcript

Direct `/chat/stream` probing showed `agent_activity` frames like:

- `### Task 1: Inspect workspace ...`

Those frames were being streamed before a real user answer existed. In the desktop UI this manifested as:

- `Jarvis is running planner...`
- `STREAM RELAY running...`
- internal planning text appearing in the live transcript area

### 3. Stage-model reliability is poor right now

The logs showed several recurring failures:

- Coordinator model `deepseek-v4-flash-free` often returned unparseable output
- Planner and synthesizer model `nemotron-3-ultra-free` hit first-token timeouts
- Executor model chains hit many provider errors before falling all the way to `openrouter/free`

Observed examples from `server-jarvis.log`:

- `First-token timeout (30s) on stage=planner model=nemotron-3-ultra-free`
- `First-token timeout (30s) on stage=synthesizer model=nemotron-3-ultra-free`
- many `HTTP 400` provider failures
- some `HTTP 403` OpenRouter key-limit failures on specific paid/non-free routes

### 4. Response quality is still badly grounded even when the stream completes

After the runtime fix below, Jarvis did answer more reliably, but the content still hallucinated the repo as:

- an Expo / React Native mobile application
- with files like `app.json`
- and even a made-up runtime entry point like `jarvis/orchestrator.py`

That means response transport improved, but repo grounding is still weak.

### 5. The Bun server can vanish independently of the desktop shell

At one point:

- `Jarvis.exe` remained open
- `bun.exe` was gone
- `127.0.0.1:19877` refused connections

This should be treated as a separate supervision / lifecycle reliability issue.

## High-Impact Fix Implemented In This Session

### Change

When the coordinator returns unparseable output, Jarvis now falls back straight to:

- `["synthesizer"]`

instead of:

- `["planner", "executor", "synthesizer"]`

Files changed:

- `server-jarvis/src/orchestration/coordinator.ts`
- `server-jarvis/src/orchestration/coordinator.test.ts`

### Why this fix was chosen

This was the highest-confidence, highest-leverage change because:

1. coordinator parse failures were happening repeatedly
2. the old fallback route forced the user into the most failure-prone stages
3. that route produced the planner leak, long waits, bad retries, and empty/fallback answers
4. this change is narrow and low-risk compared with rewriting the whole provider stack

## Validation Performed

### Automated

- `bun test server-jarvis/src/orchestration/coordinator.test.ts`
- result: `4 pass`

### Runtime deployment

- rebuilt: `bun build ./server-jarvis/src/index.ts --outdir ./server-jarvis/dist --target bun`
- copied new bundle to: `C:\Users\ethan\OneDrive\Desktop\index.js`
- SHA-256 confirmed identical between repo bundle and desktop runtime bundle
- relaunched Bun manually from the desktop runtime path
- `/health` returned healthy again

### Direct stream verification after the fix

A fresh `/chat/stream` probe for:

- `Give me a two-sentence summary of this repo, then name one file you would inspect first to understand the runtime path.`

showed:

- only `synthesizer` stage events
- no planner/executor stage events
- no `agent_activity` leak
- a completed `result`

### Desktop UI verification after the fix

A real prompt was sent in the actual `Jarvis.exe` window:

- `Answer in one sentence: what kind of repo is this?`

Observed behavior:

- the live stage label switched to `synthesizer`
- planner leakage did not reappear for that turn
- the UI streamed answer text instead of exposing planner task text first

## What Is Better Now

- A coordinator parse failure no longer drags the user through planner/executor by default
- The live stream is cleaner on that failure path
- The desktop UI now shows `synthesizer`-only behavior for this class of degraded turn
- The server bundle on the real desktop runtime path is up to date with the fix

## What Is Still Broken

### Priority 1

Coordinator stage model reliability is still bad.

Likely next files:

- `server-jarvis/src/orchestration/agent-pool.ts`
- `server-jarvis/src/index.ts`
- `server-jarvis/src/orchestration/coordinator.ts`

### Priority 2

Planner / synthesizer model defaults still suffer first-token timeouts.

Likely next files:

- `server-jarvis/src/orchestration/agent-pool.ts`
- `server-jarvis/src/config.ts`

### Priority 3

Executor/provider compatibility is unstable and produces malformed-tool-message failures during fallback.

Likely next files:

- `server-jarvis/src/index.ts`
- `server-jarvis/src/tool-runtime.ts`
- provider routing / request-shaping code touched by `chatCompletionWithFallback`

### Priority 4

Repo grounding is weak even when a response succeeds.

The model still hallucinates the repo identity and entry files. That suggests either:

- poor prompt constraints
- bad session carryover
- degraded tool usage after routing fallback
- or model/provider mismatch for grounded coding tasks

### Priority 5

Desktop Bun lifecycle supervision is not trustworthy yet.

The app shell can survive while the local server dies.

## Suggested Next Investigation Order

1. Reproduce a coordinator parse failure with current logs open
2. Audit `agent-pool.ts` defaults against the models that are actually succeeding today
3. Decide whether coordinator/planner/synth should stay on the current OpenCode defaults
4. Inspect why executor fallbacks are generating malformed message/tool payloads
5. Add or improve Bun child-process supervision so the desktop app relaunches the server cleanly

## Bottom Line

The biggest immediate improvement landed here is not "Jarvis is now smart" — it is "when the coordinator degrades, Jarvis now fails into a direct answer path instead of spiraling through the broken orchestration stages first."

That meaningfully improves live behavior, but the next agent should assume the provider/model-selection layer still needs serious attention.
