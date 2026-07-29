# Orchestrator Latency & Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut wasted wall-clock from misrouted turns and first-token queueing, and stop a 7-task phase from completing after one edit.

**Architecture:** Three ordered phases against the live evidence in `~/.openclaw/jarvis/self-tuning.db`. Phase A fixes two symmetric turn-classifier edges (deterministic, unit-testable, no live dependency) so measurement of everything after it is clean. Phase B attacks latency where the data says it lives — 65–97% of every stage is time-to-first-token on one free provider — via a delegate model-routing fix, first-token racing across the two healthy lanes, and a local lane for cheap stages. Phase C then raises the completion bar from "one write landed" to "plan ledger drained", which is only safe once B has bought budget headroom.

**Tech Stack:** TypeScript / Bun (`server-jarvis`), bun:test, SQLite (`self-tuning.db`) for evidence.

---

## Evidence Base

All figures from `~/.openclaw/jarvis/self-tuning.db`, sessions `dd3df41c` (2026-07-29 02:03–02:12) and `650a4f48` (2026-07-28 12:28–12:36).

| Fact | Value |
|---|---|
| First-token share of stage latency | executor 76%, synthesizer 65%, planner 72%, reviewer 81%, rewriter 97% |
| Model concentration since deploy | 44 of 51 calls to `deepseek-v4-flash-free` |
| `deepseek-v4-flash-free` health | n=1483, **6.9% error**, ftt 7,342ms |
| `north-mini-code-free` health | n=250, **3.2% error**, ftt 8,594ms |
| `qwythos9b-conductor` (local) health | n=31, **0.0% error**, avg 6,038ms |
| `gemma4:e2b` (conductor fallback **default** in `config.ts:596`; overridden live) | n=67, **85.1% error** |
| Misrouted question cost | `"what was your reasoning…"` → full_execution → 120s, 0 tools, degraded |
| Misrouted order cost | `"Complete the execution of all…"` → answer_only → synthesizer-only, 0 tools |
| Verification coverage on real work | `runtime_check` on **1 of 426** real runs (0.2%) |
| Correctness floor | `successfulWrites > 0` — 1 of 7 phase tasks ends the turn |

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server-jarvis/src/orchestration/turn-requirements.ts` | Turn classification, write intent | Modify — add retrospective guard, widen commencement nouns, verify-work-item route |
| `server-jarvis/src/orchestration/turn-requirements.test.ts` | Classifier pins | Modify — new cases |
| `server-jarvis/src/orchestration/delegate-model-select.ts` | Picks the model handed to the claude_cli proxy | Modify — restrict to proxy-serviceable providers |
| `server-jarvis/src/orchestration/delegate-model-select.test.ts` | Selector pins | Modify |
| `server-jarvis/src/orchestration/first-token-race.ts` | **New** — races N candidate launches, returns first to yield a token, aborts losers | Create |
| `server-jarvis/src/orchestration/first-token-race.test.ts` | **New** — race semantics | Create |
| `server-jarvis/src/orchestration/agent-pool.ts` | Stage→agent resolution, cascade chain | Modify — expose `raceCandidates(stage, taskType)` |
| `server-jarvis/src/orchestration/agent-pool.test.ts` | Pool pins | Modify |
| `server-jarvis/src/orchestration/mid-loop-intervention.ts` | Reflexes, correctness floor | Modify — plan-aware floor |
| `server-jarvis/src/orchestration/mid-loop-intervention.test.ts` | Reflex pins | Modify |
| `server-jarvis/src/orchestration/pipeline.ts` | Stage driver | Modify — feed plan remainder into the mid-loop signal |
| `~/.openclaw/jarvis/config.json` | Runtime config | Modify — conductor `fallback_model` |

---

## Phase A — Turn classifier edges

Fixes the two symmetric misroutes. Deterministic and offline-testable. Do this first so Phase B latency measurements are not polluted by 120-second question turns.

### Task A1: Retrospective questions must never be `full_execution`

A question about work already done (`"what was your reasoning for implementing 1.6 first before 1.1"`) hits `MUTATION_VERB` on "implementing", so `classifyTurnRequirements` returns `full_execution` at the `hasMutation` branch. The route normalizer then expands the coordinator's `["planner"]` into the full four-stage pipeline. Measured cost: 120s, zero tool calls, `degraded`.

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-requirements.ts`
- Test: `server-jarvis/src/orchestration/turn-requirements.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server-jarvis/src/orchestration/turn-requirements.test.ts`:

```typescript
describe("retrospective questions are not execution orders", () => {
  test.each([
    "what was your reasoning for implementing 1.6 first before 1.1",
    "what did you change",
    "why did you do 1.6 before 1.1",
    "how did you implement the smoothing",
    "which files did you edit",
    "what have you completed so far",
  ])("%p does not classify as full_execution", (message) => {
    expect(classifyTurnRequirements(message).requirement).not.toBe("full_execution");
  });

  test.each([
    "Begin full execution of phase 1",
    "implement the fixes",
    "fix the bug in PluginProcessor.cpp",
    "what needs fixing? then fix it",
  ])("%p is still an execution order", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts -t "retrospective"
```

Expected: FAIL — `expected "full_execution" not to be "full_execution"` on the first six cases.

- [ ] **Step 3: Add the guard constant**

In `server-jarvis/src/orchestration/turn-requirements.ts`, immediately after the `WEAK_WORKSPACE` definition (around line 381), add:

```typescript
// A question ABOUT work already done is never an order to do more work.
// 2026-07-29 (session dd3df41c): "what was your reasoning for implementing
// 1.6 first before 1.1" matched MUTATION_VERB on "implementing", classified
// full_execution, and the route normalizer expanded the coordinator's
// single-stage route into planner+executor+reviewer+synthesizer — 120s of
// wall clock, zero tool calls, outcome degraded. The trailing "?" is what
// normally saves these; punctuation must not be load-bearing.
//
// Deliberately narrow: an interrogative opener is NOT enough on its own
// ("what needs fixing? then fix it" is a real order). The message must also
// refer back to an actor/subject with an auxiliary verb — "did you", "was
// your", "have you" — which is the shape of asking about the past.
const RETROSPECTIVE_QUESTION =
  /^(?:so|and|but|ok|okay|hey|hmm|wait|also|quick\s+q(?:uestion)?)?[,.!\s]*\b(?:what|why|how|when|which|who|whose)\b[^.?!]{0,140}?\b(?:did|do|does|are|were|was|is|have|has|had|would|should|could)\s+(?:you|your|we|our|it|that|this|the)\b/i;
```

- [ ] **Step 4: Check the guard before the mutation branch**

In `classifyTurnRequirements`, the `hasDeepReadIntent` early return is followed by the `hasMutation` branch. Insert the guard between them — after the deep-read return, before `if (hasMutation)`:

```typescript
  // Retrospective questions are answered, not executed. Checked before the
  // mutation branch because their verb ("implementing", "change") is exactly
  // what would otherwise grant execution authority.
  if (RETROSPECTIVE_QUESTION.test(intentText)) {
    signals.push("retrospective_question");
    return {
      requirement: pathSignal || hasStrongWorkspace ? "workspace_read" : "answer_only",
      signals,
    };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 6: Run the full suite for regressions**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail. If `pipeline-telemetry` or `claude-delegate` wall-clock tests fail, re-run once — those are known load-sensitive flakes.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/orchestration/turn-requirements.ts server-jarvis/src/orchestration/turn-requirements.test.ts
git commit -m "fix(routing): retrospective questions no longer classify as full_execution"
```

---

### Task A2: `execution` is a work-commencement noun

`"Complete the execution of all partial and incomplete phases"` classified `answer_only` and got a synthesizer-only pipeline — the runtime replied *"Nothing was executed in this turn… Please re-send your request."* `WORK_COMMENCEMENT_RE` has `implementation` but not `execution`, and its four-word verb→noun gap cannot span "the execution of all partial and incomplete".

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-requirements.ts`
- Test: `server-jarvis/src/orchestration/turn-requirements.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server-jarvis/src/orchestration/turn-requirements.test.ts`:

```typescript
describe("execution is a commencement noun", () => {
  test.each([
    "Complete the execution of all partial and incomplete phases",
    "Begin full execution of phase 1",
    "finish the remaining execution",
    "resume execution of the plan",
  ])("%p is full_execution", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });

  test("commencing an abstract deliverable is still not write intent", () => {
    expect(hasWriteIntent("complete the plan")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts -t "commencement noun"
```

Expected: FAIL — `"Complete the execution of all partial and incomplete phases"` returns `answer_only`.

- [ ] **Step 3: Add `execution` and widen the gap**

In `server-jarvis/src/orchestration/turn-requirements.ts`, replace the `WORK_COMMENCEMENT_RE` definition with:

```typescript
// 2026-07-29: `execution` was missing, and the {0,4} gap could not span
// "the execution of all partial and incomplete". "Complete the execution of
// all partial and incomplete phases" — the most explicit order in session
// 650a4f48 — classified answer_only and got a tool-less synthesizer.
const WORK_COMMENCEMENT_RE =
  /\b(begin|start|commence|complete|finish|resume|continue|execute|perform|tackle|carry\s+out|kick\s+off|wrap\s+up|knock\s+out|proceed\s+with|move\s+on\s+to)(?!\s+(?:you|we|they|i)\b)\s+(?:[\w'’-]+\s+){0,5}?((?:phase|task|step|item|part|stage|milestone|plan|implementation|execution|migration|integration|deployment|rollout|remainder|rest|work|fixe?|change|edit|feature|functionality)s?)\b/gi;
```

Then add `execution` to the anchored `WORK_START_COMMAND` in `server-jarvis/src/orchestration/turn-triage.ts` so the two lists stay in sync — replace its noun group `(phase|task|step|item|part|stage|plan|milestone|next|implementation|migration|...` with the same list including `execution`:

```typescript
export const WORK_START_COMMAND =
  /^(?:now |ok |okay |please |actually |just |alright |and |then )*(begin|start|complete|finish|resume|continue|execute|launch|perform|implement|tackle|kick off|wrap up|carry out|proceed with|do)(?!\s+(?:you|we|they|i)\b)\s+(?:[\w'’-]+\s+){0,5}?(phase|task|step|item|part|stage|plan|milestone|next|implementation|execution|migration|integration|deployment|rollout|remainder|rest|work|fixe?|change|edit|feature|functionality)s?\b/i;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts src/orchestration/turn-triage.test.ts
```

Expected: PASS. `"complete the plan"` still returns `false` from `hasWriteIntent` because `ABSTRACT_DELIVERABLE` filters the `plan` object.

- [ ] **Step 5: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/turn-requirements.ts server-jarvis/src/orchestration/turn-triage.ts server-jarvis/src/orchestration/turn-requirements.test.ts
git commit -m "fix(routing): treat 'execution' as a work-commencement noun"
```

---

### Task A3: Verifying a work item requires workspace inspection

`"Verify phase 4 was acutally put into code"` classified `answer_only`, routed synthesizer-only, and died on a 45-second turn deadline with **zero output**. `verify` is in `READ_VERB`, but "into code" carries no determiner so `WEAK_WORKSPACE` misses and no workspace signal is produced.

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-requirements.ts`
- Test: `server-jarvis/src/orchestration/turn-requirements.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server-jarvis/src/orchestration/turn-requirements.test.ts`:

```typescript
describe("verifying a work item reads the workspace", () => {
  test.each([
    "Verify phase 4 was acutally put into code",
    "confirm task 1.3 is implemented",
    "check that phase 2 landed",
  ])("%p is workspace_read", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("workspace_read");
  });

  test.each([
    "verify my understanding of TCP",
    "check the weather",
  ])("%p stays answer_only", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("answer_only");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts -t "verifying a work item"
```

Expected: FAIL — the three positives return `answer_only`.

- [ ] **Step 3: Add the pattern**

In `server-jarvis/src/orchestration/turn-requirements.ts`, after the `WEAK_WORKSPACE` definition, add:

```typescript
// Verifying a named work item is a claim about the CODE, so it needs reads.
// 2026-07-28: "Verify phase 4 was acutally put into code" classified
// answer_only, routed synthesizer-only, and burned its whole 45s turn budget
// producing no output at all. The abstract-concept case ("verify my
// understanding of TCP") is excluded by requiring a work-item noun.
const VERIFY_WORK_ITEM =
  /\b(?:verif(?:y|ies|ying)|validat(?:e|ing)|confirm(?:ing)?|check|audit|review)\b[^.?!]{0,60}?\b(?:phase|task|step|item|milestone|implementation|feature)s?\b/i;
```

- [ ] **Step 4: Use it in the workspace branch**

In `classifyTurnRequirements`, replace the workspace-inspection condition:

```typescript
  if (pathSignal || hasStrongWorkspace || (hasReadVerb && hasWeakWorkspace)) {
    return { requirement: "workspace_read", signals };
  }
```

with:

```typescript
  if (VERIFY_WORK_ITEM.test(intentText)) signals.push("verify_work_item");
  if (
    pathSignal ||
    hasStrongWorkspace ||
    (hasReadVerb && hasWeakWorkspace) ||
    VERIFY_WORK_ITEM.test(intentText)
  ) {
    return { requirement: "workspace_read", signals };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/orchestration/turn-requirements.ts server-jarvis/src/orchestration/turn-requirements.test.ts
git commit -m "fix(routing): verifying a named work item routes to workspace_read"
```

---

## Phase B — Latency

Attacks the 65–97% first-token tax. B1 is a pure-win bug fix; B2 is the main lever; B3 adds the local lane; B4 is a one-line config change.

### Task B1: The delegate must not pick a model its proxy cannot serve

Every write-intent run opens with a failed `git_metadata` call recorded as `delegate_exit_nonzero`. Root cause from `claude-proxy.log` (2026-07-28 22:07:05):

```
Bilateral proxying deepseek-v4-flash-free request to http://127.0.0.1:11434/v1/chat/completions [ollama]
Upstream API Error: {"error":{"message":"model 'deepseek-v4-flash-free' not found","type":"not_found_error"}}
"POST /v1/messages?beta=true HTTP/1.1" 404 -
```

The proxy routes by **model-id shape**, not by a provider field (`scripts/claude_cli_proxy.py::resolve_upstream`, ~line 292). It is actually THREE rules, not two — verified 2026-07-29 by reading the full function, correcting the original two-rule diagnosis:

```
1. Known OpenCode Go OpenAI-format model id + Go key -> opencode_go (direct)
2. Namespaced "vendor/model[:tag]" + OpenRouter key   -> openrouter
3. Bare Ollama ids / claude-* placeholders            -> ollama
```

Rule 1 matters: `DELEGATE_GO_OPENAI_MODELS` (`"deepseek-v4-flash"`, `"mimo-v2.5"`) are BARE ids with no `/`, but they ARE proxy-resolvable — via rule 1, not rules 2/3 — as long as an OpenCode Go key is configured. `resolve_upstream` checks membership against `get_opencode_go_openai_models()`, whose source of truth is `scripts/opencode_go_openai_models.json` (synced from `OPENCODE_GO_COST_RANKS` in `server-jarvis/src/orchestration/live-model-catalog.ts`). A naive "bare id = unreachable" rule would wrongly flag these two as unresolvable.

`DELEGATE_FREE_FIRST_MODELS` is `["deepseek-v4-flash-free", "north-mini-code-free", "mimo-v2.5-free", "nemotron-3-ultra-free"]` — **all four are bare OpenCode Zen ids, and none of them appear in the OpenCode Go OpenAI-models list** (they're Zen, not Go — different catalogs, confirmed by the `-free` suffix and provider field in `config.json`'s `orchestrator.agents`). So rule 1 does not apply to them either; every one falls through to rule 3, is sent to Ollama, and 404s. The entire free-first delegate pool is unreachable through the proxy; the first pick just happens to be the one in the logs.

The fix mirrors the proxy's own rule in TypeScript so the two cannot drift, and re-points the free list at ids the proxy can actually resolve.

**Files:**
- Modify: `server-jarvis/src/orchestration/delegate-model-select.ts`
- Test: `server-jarvis/src/orchestration/delegate-model-select.test.ts`

- [ ] **Step 1: Confirm the proxy's routing rules first-hand**

```bash
sed -n '285,340p' scripts/claude_cli_proxy.py
```

Confirm all THREE rules before encoding them: rule 1 (bare id in `get_opencode_go_openai_models()` + Go key → `opencode_go`), rule 2 (contains `/` → OpenRouter), rule 3 (bare id / `claude-*` → Ollama). If the rules have changed, encode what you read, not what this plan says.

- [ ] **Step 2: Write the failing test**

Append to `server-jarvis/src/orchestration/delegate-model-select.test.ts`:

```typescript
import { isProxyResolvable, DELEGATE_FREE_FIRST_MODELS, DELEGATE_GO_OPENAI_MODELS } from "./delegate-model-select";

describe("delegate only selects models the claude_cli proxy can resolve", () => {
  const installed = ["qwythos9b-conductor:latest", "qwen3.5:4b", "qwen3:8b"];
  const goOpenaiModels = ["deepseek-v4-flash", "mimo-v2.5"];

  test("a namespaced id routes to OpenRouter and is resolvable", () => {
    expect(isProxyResolvable("cohere/north-mini-code:free", installed, goOpenaiModels)).toBe(true);
    expect(isProxyResolvable("deepseek/deepseek-v4-flash", installed, goOpenaiModels)).toBe(true);
  });

  test("a bare OpenCode Go OpenAI-format id resolves via rule 1, not Ollama", () => {
    // deepseek-v4-flash / mimo-v2.5 have no "/" and are not installed in
    // Ollama, but the proxy routes them directly to opencode_go — this is
    // rule 1, discovered during Task B1 planning, distinct from rules 2/3.
    for (const model of DELEGATE_GO_OPENAI_MODELS) {
      expect(isProxyResolvable(model, [], goOpenaiModels)).toBe(true);
    }
  });

  test("a bare id NOT in the Go OpenAI list is only resolvable when installed in Ollama", () => {
    expect(isProxyResolvable("qwen3:8b", installed, goOpenaiModels)).toBe(true);
    // The exact 404 seen in claude-proxy.log 2026-07-28 22:07:05:
    // "model 'deepseek-v4-flash-free' not found"
    expect(isProxyResolvable("deepseek-v4-flash-free", installed, goOpenaiModels)).toBe(false);
  });

  test("claude-* placeholders fall back to the proxy default model", () => {
    expect(isProxyResolvable("claude-sonnet-4", installed, goOpenaiModels)).toBe(true);
  });

  test("every default free-first model is namespaced", () => {
    // A bare OpenCode Zen id here is unreachable by construction: it isn't a
    // Go OpenAI-format id (rule 1), it can't be namespaced-routed (rule 2),
    // and it is not an Ollama model (rule 3).
    for (const model of DELEGATE_FREE_FIRST_MODELS) {
      expect({ model, namespaced: model.includes("/") })
        .toEqual({ model, namespaced: true });
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/delegate-model-select.test.ts -t "proxy can resolve"
```

Expected: FAIL — `isProxyResolvable is not a function`, and all four current free-first ids are bare.

- [ ] **Step 4: Add the resolvability predicate**

At the top of `server-jarvis/src/orchestration/delegate-model-select.ts`, add:

```typescript
/**
 * Mirror of the claude_cli proxy's own model routing
 * (claude_cli_proxy.py::resolve_upstream, verified 2026-07-29):
 *
 *   1. Bare id in get_opencode_go_openai_models() + Go key -> opencode_go (direct)
 *   2. Namespaced "vendor/model[:tag]" + OpenRouter key     -> openrouter
 *   3. Bare Ollama ids / claude-* placeholders              -> ollama
 *
 * Rule 1 matters: DELEGATE_GO_OPENAI_MODELS ("deepseek-v4-flash", "mimo-v2.5")
 * are bare ids that resolve WITHOUT being installed in Ollama, via a
 * different mechanism than rule 3. A bare id that matches neither rule 1 nor
 * an installed Ollama model is unreachable: the proxy sends it to :11434 and
 * gets `{"error":{"message":"model '<id>' not found"}}`, the delegate exits
 * nonzero, and the turn opens with a failed git_metadata call. Through
 * 2026-07-29 every id in DELEGATE_FREE_FIRST_MODELS was a bare OpenCode ZEN
 * id (a different catalog than OpenCode Go) matching neither rule 1 nor any
 * installed Ollama model, so the whole free-first pool 404'd on every write run.
 */
export function isProxyResolvable(
  model: string,
  installedOllamaModels: readonly string[],
  goOpenaiModels: readonly string[] = DELEGATE_GO_OPENAI_MODELS,
): boolean {
  const id = model.trim();
  if (id.length === 0) return false;
  if (goOpenaiModels.includes(id)) return true; // rule 1 — OpenCode Go direct
  if (id.includes("/")) return true;            // rule 2 — OpenRouter
  if (id.startsWith("claude-")) return true;    // rule 3 — proxy default model
  return installedOllamaModels.includes(id);    // rule 3 — must be installed
}
```

- [ ] **Step 5: Re-point the free-first list at resolvable ids**

Replace `DELEGATE_FREE_FIRST_MODELS` with the OpenRouter-namespaced equivalents that are already enabled in `~/.openclaw/jarvis/config.json`, healthiest first by `model_attributions` error rate:

```typescript
/**
 * Free-tier delegate models, healthiest first.
 *
 * These MUST be namespaced (`vendor/model`) so the proxy routes them to
 * OpenRouter. Bare OpenCode Zen ids are unreachable — see isProxyResolvable.
 */
export const DELEGATE_FREE_FIRST_MODELS = [
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-31b-it:free",
] as const;
```

- [ ] **Step 6: Filter selection through the predicate**

In `selectDelegateModel`, accept the installed-model list and filter before picking. Add to the input type:

```typescript
  /** Ollama tags, for resolving bare model ids. Empty means "none installed". */
  installedOllamaModels?: readonly string[];
```

and immediately after `const free = input.freeModels ?? DELEGATE_FREE_FIRST_MODELS;` add:

```typescript
  const installed = input.installedOllamaModels ?? [];
  const resolvableFree = free.filter((model) => isProxyResolvable(model, installed));
```

then use `resolvableFree` wherever `free` was consumed for the free pool.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/delegate-model-select.test.ts
```

Expected: PASS. Existing tests that assert `deepseek-v4-flash-free` is chosen encode the bug — update them to the new first entry.

- [ ] **Step 8: Confirm the caller degrades to native execution**

```bash
cd server-jarvis && grep -n "selectDelegateModel\|delegateEligibility" src/orchestration/pipeline.ts | head
```

Confirm an empty free pool makes the pipeline skip the delegate and run the native executor, rather than failing the stage. If it does not, make that skip explicit at the call site.

- [ ] **Step 9: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail.

- [ ] **Step 10: Commit**

```bash
git add server-jarvis/src/orchestration/delegate-model-select.ts server-jarvis/src/orchestration/delegate-model-select.test.ts
git commit -m "fix(delegate): only select models the claude_cli proxy can resolve"
```

- [ ] **Step 11: Verify the 404 is gone on a live run**

After deploying, send one write-intent turn, then:

```bash
grep -a "not found\|404" ~/AppData/Local/com.jarvis.desktop/logs/claude-proxy.log | tail -5
```

Expected: no new `model '<id>' not found` entries after the deploy timestamp.

---

### Task B2: Race the first token across two healthy lanes

The main lever. Stages are a data-dependency chain (planner → executor → reviewer → synthesizer), so they cannot be parallelised — but a single stage's *first token* can be raced across providers. With `deepseek-v4-flash-free` (6.9% err, ftt 7.3s) and `north-mini-code-free` (3.2% err, ftt 8.6s) on different providers, racing yields `min(ftt)` instead of one provider's tail, and a provider hiccup costs nothing instead of a full timeout-then-cascade.

**Files:**
- Create: `server-jarvis/src/orchestration/first-token-race.ts`
- Create: `server-jarvis/src/orchestration/first-token-race.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/orchestration/first-token-race.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { raceFirstToken } from "./first-token-race";

function launcher(id: string, firstTokenMs: number, opts: { fail?: boolean } = {}) {
  return (signal: AbortSignal) =>
    new Promise<{ id: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (opts.fail) reject(new Error(`${id} failed`));
        else resolve({ id });
      }, firstTokenMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
}

describe("raceFirstToken", () => {
  test("returns the fastest candidate", async () => {
    const result = await raceFirstToken([
      { id: "slow", launch: launcher("slow", 60) },
      { id: "fast", launch: launcher("fast", 10) },
    ]);
    expect(result.winnerId).toBe("fast");
    expect(result.value).toEqual({ id: "fast" });
  });

  test("aborts the losers", async () => {
    const aborted: string[] = [];
    await raceFirstToken([
      { id: "fast", launch: launcher("fast", 10) },
      {
        id: "slow",
        launch: (signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted.push("slow");
              reject(new Error("aborted"));
            });
          }),
      },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toEqual(["slow"]);
  });

  test("a failing candidate does not sink the race", async () => {
    const result = await raceFirstToken([
      { id: "broken", launch: launcher("broken", 5, { fail: true }) },
      { id: "good", launch: launcher("good", 40) },
    ]);
    expect(result.winnerId).toBe("good");
  });

  test("rejects only when every candidate fails", async () => {
    await expect(
      raceFirstToken([
        { id: "a", launch: launcher("a", 5, { fail: true }) },
        { id: "b", launch: launcher("b", 10, { fail: true }) },
      ]),
    ).rejects.toThrow();
  });

  test("a single candidate is passed through without racing overhead", async () => {
    const result = await raceFirstToken([{ id: "only", launch: launcher("only", 5) }]);
    expect(result.winnerId).toBe("only");
    expect(result.raced).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/first-token-race.test.ts
```

Expected: FAIL — module `./first-token-race` not found.

- [ ] **Step 3: Implement the racer**

Create `server-jarvis/src/orchestration/first-token-race.ts`:

```typescript
/**
 * Race a stage across several model lanes and keep the first one to produce a
 * token; abort the rest.
 *
 * 2026-07-29 evidence (self-tuning.db): time-to-first-token is 65–97% of every
 * stage's wall clock, and 44 of 51 calls went to a single free-tier lane. The
 * generation itself is not slow — provider queueing is. Racing two healthy
 * lanes converts that into min(ftt) and makes a provider hiccup free instead
 * of costing a full timeout-then-cascade.
 *
 * Only lanes with independently good health should be passed in; racing onto a
 * high-error model would trade latency for failure. See `AgentPool.raceCandidates`.
 */
export interface RaceCandidate<T> {
  id: string;
  launch: (signal: AbortSignal) => Promise<T>;
}

export interface RaceResult<T> {
  winnerId: string;
  value: T;
  /** False when only one candidate was supplied (no race was run). */
  raced: boolean;
}

export async function raceFirstToken<T>(
  candidates: readonly RaceCandidate<T>[],
): Promise<RaceResult<T>> {
  if (candidates.length === 0) throw new Error("raceFirstToken: no candidates");
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const controller = new AbortController();
    return { winnerId: only.id, value: await only.launch(controller.signal), raced: false };
  }

  const controllers = candidates.map(() => new AbortController());
  let settled = false;
  const failures: Error[] = [];

  return new Promise<RaceResult<T>>((resolve, reject) => {
    candidates.forEach((candidate, index) => {
      candidate
        .launch(controllers[index]!.signal)
        .then((value) => {
          if (settled) return;
          settled = true;
          // Abort every other lane; the winner's controller is left alone so
          // its stream can continue to completion.
          controllers.forEach((controller, other) => {
            if (other !== index) controller.abort();
          });
          resolve({ winnerId: candidate.id, value, raced: true });
        })
        .catch((error: unknown) => {
          if (settled) return;
          failures.push(error instanceof Error ? error : new Error(String(error)));
          if (failures.length === candidates.length) {
            settled = true;
            reject(
              new Error(
                `all ${candidates.length} race candidates failed: ` +
                  failures.map((f) => f.message).join("; "),
              ),
            );
          }
        });
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/first-token-race.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the racer**

```bash
git add server-jarvis/src/orchestration/first-token-race.ts server-jarvis/src/orchestration/first-token-race.test.ts
git commit -m "feat(latency): add first-token racer for multi-lane stage dispatch"
```

- [ ] **Step 6: Write the failing test for pool candidate selection**

Append to `server-jarvis/src/orchestration/agent-pool.test.ts`:

```typescript
describe("raceCandidates", () => {
  test("returns at most two healthy lanes on distinct providers", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const candidates = pool.raceCandidates("planner", "refactor");
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(2);
    const providers = candidates.map((agent) => agent.provider);
    expect(new Set(providers).size).toBe(providers.length);
  });

  test("never races onto a disabled agent", () => {
    const pool = new AgentPool(
      DEFAULT_ORCHESTRATOR_AGENTS.map((agent) => ({ ...agent, enabled: false })),
    );
    expect(pool.raceCandidates("planner", "refactor")).toEqual([]);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/agent-pool.test.ts -t "raceCandidates"
```

Expected: FAIL — `pool.raceCandidates is not a function`.

- [ ] **Step 8: Implement `raceCandidates`**

In `server-jarvis/src/orchestration/agent-pool.ts`, add a method to `AgentPool` next to `cascadeChain`:

```typescript
  /**
   * Up to two lanes to race for one stage, on DISTINCT providers.
   *
   * Distinct providers is the point: two lanes behind the same queue share the
   * same first-token tail, so racing them buys nothing. Bounded at two so the
   * free-tier request budget is not multiplied further.
   */
  raceCandidates(stage: string, taskType: TaskType | string): OrchestratorAgent[] {
    const chain = this.cascadeChain(stage, taskType);
    const picked: OrchestratorAgent[] = [];
    const seenProviders = new Set<string>();
    for (const agent of chain) {
      if (agent.enabled === false) continue;
      if (seenProviders.has(agent.provider)) continue;
      seenProviders.add(agent.provider);
      picked.push(agent);
      if (picked.length === 2) break;
    }
    return picked;
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/agent-pool.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail.

- [ ] **Step 11: Commit**

```bash
git add server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/orchestration/agent-pool.test.ts
git commit -m "feat(latency): AgentPool.raceCandidates picks two lanes on distinct providers"
```

> **Wiring note for the executing agent:** wire `raceFirstToken` into the stage dispatch in `pipeline.ts` behind a config flag `orchestrator.race_first_token` defaulting to `false`, enable it for `planner` and `synthesizer` only (the two highest first-token stages at 72% and 65%), then measure with a live turn before widening. Do **not** enable it for `executor` in this pass — executor turns carry tool state, and racing a stateful loop is out of scope here. Record the wiring as its own commit.

---

### Task B3: Give the local conductor real stage work

`qwythos9b-conductor:latest` has **0.0% error over 31 calls** and runs locally — no provider queue, no rate limit. It currently only supervises. The reviewer stage is the cheapest quality bar in the pipeline (it emitted `empty_completion` twice on free lanes in the last two sessions) and is the natural first candidate.

**Files:**
- Modify: `~/.openclaw/jarvis/config.json`
- Test: manual live verification

- [ ] **Step 1: Back up the live config**

```bash
cp ~/.openclaw/jarvis/config.json ~/.openclaw/jarvis/config.json.bak-pre-local-lane
```

- [ ] **Step 2: Add the local agent to the pool**

`OrchestratorAgent` declares stage preference via **`default_for: string[]`** (confirmed in `agent-pool.ts`), and `provider` is the union `"openrouter" | "ollama" | "claude_cli" | "opencode_zen" | "opencode_go"`. `capabilities` and `enabled` are required. Add to `orchestrator.agents` in `~/.openclaw/jarvis/config.json`:

```json
{
  "id": "local-qwythos-reviewer",
  "provider": "ollama",
  "model_id": "qwythos9b-conductor:latest",
  "enabled": true,
  "default_for": ["reviewer"],
  "capabilities": { "quality": 0.7, "speed": 0.9 }
}
```

Confirm the `capabilities` keys against the `AgentCapabilities` interface before saving:

```bash
cd server-jarvis && awk '/export interface AgentCapabilities/,/^}/' src/orchestration/agent-pool.ts
```

- [ ] **Step 4: Restart and confirm the pool sees it**

```bash
powershell -ExecutionPolicy Bypass -File scripts/build-and-deploy.ps1 -RestartServer
```

Then:

```bash
curl -s http://127.0.0.1:19877/health
```

Expected: `"ok": true`.

- [ ] **Step 5: Verify a live turn resolves the local lane**

Send one reviewer-bearing turn through the UI, then:

```bash
grep -a "Pool resolved model" ~/AppData/Local/com.jarvis.desktop/logs/server-jarvis.log | tail -10
```

Expected: at least one `stage=reviewer` line naming `qwythos9b-conductor:latest`. If none appears, the pool is not consulting the new entry — revisit Step 2 rather than forcing it.

- [ ] **Step 6: Commit the config change record**

Config lives outside the repo, so record the change:

```bash
git add docs/superpowers/plans/2026-07-29-orchestrator-latency-and-completion.md
git commit -m "docs(plan): record local-lane config change for reviewer stage"
```

---

### Task B4: Replace the 85%-error conductor fallback default

`gemma4:e2b` shows **85.1% error across 67 calls** in `model_attributions`, and it is the hard-coded `fallback_model` default at **`server-jarvis/src/config.ts:596`** — the comment above it selected the model for latency (~1.8s vs ~4.4s) with no error-rate input.

The live `~/.openclaw/jarvis/config.json` currently overrides this to `qwen3.5:4b`, so the bad default is **latent, not active** — it applies to any fresh install or any config that drops the override. Fix the default; the live config needs no change.

**Files:**
- Modify: `server-jarvis/src/config.ts:596`
- Test: `server-jarvis/src/config.test.ts`

- [ ] **Step 1: Read the current default and its rationale**

```bash
cd server-jarvis && sed -n '585,600p' src/config.ts
```

- [ ] **Step 2: Confirm which local models are actually installed**

```bash
curl -s http://127.0.0.1:11434/api/tags
```

At the time of writing: `qwythos9b-conductor:latest`, `qwen3.5:4b`, `moondream:latest`, `llama3.2-vision:11b`, `gemma4:e2b`, `qwen3:8b`, `qwen3:4b`.

- [ ] **Step 3: Write the failing test**

Append to `server-jarvis/src/config.test.ts`:

```typescript
test("the conductor fallback default is not the 85%-error model", () => {
  // model_attributions 2026-07-29: gemma4:e2b n=67, 85.1% error. It was
  // picked at config.ts:596 on latency alone (~1.8s vs ~4.4s) with no
  // error-rate input. A fallback that fails 85% of the time is not a fallback.
  const cfg = resolveConfig({});
  expect(cfg.orchestrator.conductor.fallback_model).not.toBe("gemma4:e2b");
});
```

- [ ] **Step 4: Run to verify it fails**

```bash
cd server-jarvis && bun test src/config.test.ts -t "85%-error model"
```

Expected: FAIL — default is `gemma4:e2b`.

- [ ] **Step 5: Change the default**

In `server-jarvis/src/config.ts`, change line 596 to `fallback_model: "qwen3.5:4b"` — the value the live config already uses in practice, so this makes the default match proven behaviour. Update the adjacent comment to record that error rate, not just latency, now governs the choice.

- [ ] **Step 6: Run to verify it passes, then the full suite**

```bash
cd server-jarvis && bun test src/config.test.ts && bun test
```

Expected: 0 fail. Tests in `ollama.test.ts` / `conductor-metrics.test.ts` that reference `gemma4:e2b` as *sample data* are unaffected; only a test asserting it as the resolved default needs updating.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/config.test.ts
git commit -m "fix(config): conductor fallback default is no longer the 85%-error model"
```

---

## Phase C — Plan-aware completion

Only safe after Phase B. `assessCorrectnessFloor` is currently `successfulWrites > 0`, so the first successful edit satisfies a seven-task phase and the quality gate accepts. Raising the bar without latency headroom converts "1 task, honest" into "0 tasks, timed out".

### Task C1: The correctness floor consults the plan ledger

**Files:**
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts`
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`:

```typescript
describe("correctness floor is plan-aware", () => {
  const base = {
    writeIntent: true,
    successfulWrites: 1,
    verification: undefined,
  };

  test("one write does not satisfy a seven-item plan", () => {
    expect(assessCorrectnessFloor({
      ...base,
      planItemsTotal: 7,
      planItemsRemaining: 6,
    })).toBe(false);
  });

  test("floor is met when no plan items remain", () => {
    expect(assessCorrectnessFloor({
      ...base,
      planItemsTotal: 7,
      planItemsRemaining: 0,
    })).toBe(true);
  });

  test("with no ledger the legacy one-write floor still applies", () => {
    expect(assessCorrectnessFloor(base)).toBe(true);
  });

  test("zero writes never meets the floor regardless of ledger", () => {
    expect(assessCorrectnessFloor({
      ...base,
      successfulWrites: 0,
      planItemsTotal: 7,
      planItemsRemaining: 0,
    })).toBe(false);
  });

  test("a red verification still fails the floor", () => {
    expect(assessCorrectnessFloor({
      ...base,
      planItemsTotal: 1,
      planItemsRemaining: 0,
      verification: { tier: "builtin", ran: true, passed: false },
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts -t "plan-aware"
```

Expected: FAIL — the seven-item case returns `true`.

- [ ] **Step 3: Add the ledger fields to the signal**

In `server-jarvis/src/orchestration/mid-loop-intervention.ts`, add to `MidLoopSignal`:

```typescript
  /** Total items in the active TaskPlan ledger, when one exists. */
  planItemsTotal?: number;
  /** Items not yet `verified` in the active TaskPlan ledger. */
  planItemsRemaining?: number;
```

- [ ] **Step 4: Make the floor plan-aware**

Replace `assessCorrectnessFloor` with:

```typescript
export function assessCorrectnessFloor(signal: Pick<
  MidLoopSignal,
  "writeIntent" | "successfulWrites" | "verification" | "planItemsTotal" | "planItemsRemaining"
>): boolean {
  if (!signal.writeIntent) return true;
  if (signal.successfulWrites <= 0) return false;
  if (signal.verification?.ran === true && signal.verification.passed === false) {
    return false;
  }
  // 2026-07-29: the floor was `successfulWrites > 0` alone, so the first edit
  // of a seven-task phase satisfied it, the quality gate accepted, and the
  // turn ended 1/7 done (run_7e6b590f). When a TaskPlan ledger exists it is
  // the authority on "done" — a write is progress, not completion.
  if (
    signal.planItemsTotal !== undefined &&
    signal.planItemsTotal > 0 &&
    (signal.planItemsRemaining ?? 0) > 0
  ) {
    return false;
  }
  return true;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail. Tests that assumed one write ends the turn will need updating — that assumption was the bug.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts
git commit -m "fix(conductor): correctness floor consults the TaskPlan ledger, not just write count"
```

---

### Task C2: Feed the ledger into the signal, and exit honestly when the budget cannot cover the remainder

Without this the new fields are always `undefined` and C1 is inert. The budget guard is what keeps C1 from converting partial success into a timeout.

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts`
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`

- [ ] **Step 1: Write the failing test for the budget guard**

`mid-loop-intervention.test.ts` imports only values, not the `MidLoopSignal` type. Add it to the existing import block first:

```typescript
import type { MidLoopSignal } from "./mid-loop-intervention";
```

Then append to `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`:

```typescript
describe("plan remainder respects the stage budget", () => {
  const spiral = {
    writeIntent: true,
    successfulWrites: 2,
    distinctSuccessfulReads: 3,
    turnCount: 6,
    maxTurns: 14,
    deadToolSuppressed: false,
    planItemsTotal: 7,
    planItemsRemaining: 5,
  } as MidLoopSignal;

  test("plenty of budget left keeps pushing for the remaining items", () => {
    const decision = decideMidLoopIntervention({ ...spiral, stageRemainingMs: 400_000 });
    expect(decision.kind).not.toBe("abort");
  });

  test("budget too low for the remainder ends with an honest partial", () => {
    const decision = decideMidLoopIntervention({ ...spiral, stageRemainingMs: 20_000 });
    expect(decision.kind).toBe("abort");
    expect((decision as { reason: string }).reason).toContain("5");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts -t "respects the stage budget"
```

Expected: FAIL — the low-budget case does not abort (writes landed, so the existing spiral branch does not apply).

- [ ] **Step 3: Add the guard**

In `decideMidLoopIntervention`, immediately before the final `return { kind: "continue" };`, add:

```typescript
  // A plan remainder we cannot possibly finish should end as a NAMED partial,
  // not run to the stage timeout. Pairs with the plan-aware correctness floor:
  // raising the completion bar must not convert partial success into a timeout.
  if (
    signal.writeIntent &&
    (signal.planItemsRemaining ?? 0) > 0 &&
    signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS
  ) {
    return {
      kind: "abort",
      reason:
        `${signal.planItemsRemaining} plan item(s) still unverified with only ` +
        `${Math.round(signal.stageRemainingMs / 1000)}s of stage budget left - ` +
        "ending with a clean partial that names the remaining work instead of " +
        "running to the timeout.",
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts
```

Expected: PASS.

- [ ] **Step 5: Populate the fields from the live contract**

In `server-jarvis/src/orchestration/pipeline.ts`, in the `base: MidLoopSignal` object literal (the one that already carries `forceWriteNudgesSent`), add:

```typescript
              // TaskPlan ledger drives the plan-aware correctness floor.
              planItemsTotal: options.taskRunContract?.plan?.items.length,
              planItemsRemaining: options.taskRunContract?.plan?.items.filter(
                (item) => item.status !== "verified",
              ).length,
```

- [ ] **Step 6: Typecheck**

```bash
cd server-jarvis && bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 7: Run the full suite**

```bash
cd server-jarvis && bun test
```

Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts
git commit -m "feat(conductor): feed TaskPlan remainder into mid-loop signal with budget guard"
```

---

## Verification

After all phases, replay the two live sessions through the classifier and confirm the measured regressions are closed.

- [ ] **Step 1: Replay the misrouted turns**

Create `server-jarvis/verify-phase-abc.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { classifyTurnRequirements } from "./src/orchestration/turn-requirements";

test("2026-07-28/29 misroutes are closed", () => {
  // Was full_execution -> 4 stages, 120s, 0 tools, degraded.
  expect(classifyTurnRequirements(
    "what was your reasoning for implementing 1.6 first before 1.1",
  ).requirement).not.toBe("full_execution");

  // Was answer_only -> synthesizer-only, 0 tools, "please re-send".
  expect(classifyTurnRequirements(
    "Complete the execution of all partial and incomplete phases",
  ).requirement).toBe("full_execution");

  // Was answer_only -> synthesizer-only, 45s turn_deadline, no output.
  expect(classifyTurnRequirements(
    "Verify phase 4 was acutally put into code",
  ).requirement).toBe("workspace_read");

  // Must still work.
  expect(classifyTurnRequirements("Begin full execution of phase 1").requirement)
    .toBe("full_execution");
});
```

```bash
cd server-jarvis && bun test verify-phase-abc.test.ts && rm verify-phase-abc.test.ts
```

Expected: PASS.

- [ ] **Step 2: Deploy and confirm the running build**

```bash
powershell -ExecutionPolicy Bypass -File scripts/build-and-deploy.ps1 -RestartServer
```

```bash
curl -s http://127.0.0.1:19877/health
```

Expected: `git_sha` matches `git rev-parse HEAD`.

- [ ] **Step 3: Run one live implementation turn and measure**

Send `"Begin full execution of phase 1"` against the Perihelion workspace, then:

```bash
python -c "
import sqlite3
c=sqlite3.connect(r'C:/Users/ethan/.openclaw/jarvis/self-tuning.db'); c.row_factory=sqlite3.Row
r=list(c.execute('select * from agent_runs order by created_at desc limit 1'))[0]
print('outcome', r['outcome'], 'tools', r['tool_calls_count'], 'ms', r['duration_ms'])
for s in c.execute('select mode_id,duration_ms,tool_calls_json from stage_runs where agent_run_id=?',(r['id'],)):
    print(' ', s['mode_id'], s['duration_ms'], (s['tool_calls_json'] or '')[:80])
"
```

Compare against the 2026-07-29 baseline: 186,036ms, 10 tool calls, **1** `edit_file`, outcome `partial`. Success is more than one `edit_file` per turn; equal-or-lower wall clock is the Phase B target.

- [ ] **Step 4: Record the pass in PRIORITIES.md**

```bash
git add PRIORITIES.md
git commit -m "docs(priorities): record 2026-07-29 orchestrator latency + completion pass"
```

---

## Out of Scope (deliberately)

- **Executor-stage racing.** Executor turns carry tool state; racing a stateful loop needs a different design than `raceFirstToken`.
- **A C++ check tier for Perihelion.** Real verification coverage on the user's actual project is the largest remaining thoroughness gap (`runtime_check` fires on 0.2% of real runs) but it is a separate build-integration workstream, not a latency or routing fix.
- **Synthesizer runaway.** A 96.5s `length` stop plus a 52.6s continuation was observed on 2026-07-28; capping synthesis length is its own change.
