import { describe, expect, test } from "bun:test";
import {
  buildEmptyAdvanceNudge,
  runEmptyCompletionCascade,
  withEmptyAdvanceNudge,
  type CascadeMessage,
  type EmptyAdvanceResult,
  type EmptyCascadeDeps,
} from "./empty-cascade-advance";
import { StageAbortedError, settleStageAttempt } from "./stage-abort-link";

/**
 * The bounded empty-completion cascade-advance is the only loop that spends an
 * EXTRA provider call for a stage, so it is the only place a stage the Conductor
 * had already ordered to stop could have kept working. These tests run the real
 * loop, not a copy of it.
 */

interface RecordedHealth {
  successes: Array<{ provider: string; modelId: string; stage: string }>;
  failures: Array<{ provider: string; modelId: string; stage: string; kind: string }>;
}

interface Harness {
  deps: EmptyCascadeDeps<EmptyAdvanceResult>;
  /** The prompts actually sent to each extra attempt, in order. */
  calls: CascadeMessage[][];
  health: RecordedHealth;
  excluded: Set<string>;
  stageAbort: AbortController;
  turnAbort: AbortController;
  warns: string[];
  /** The result the caller already had; the loop never re-issues this call. */
  first: EmptyAdvanceResult;
  budgetExhausted: boolean;
}

function harness(options: {
  /** `results[0]` is `first`; each later entry answers the next advance. */
  results: EmptyAdvanceResult[];
  surfaceAsAnswer?: boolean;
  maxAdvances?: number;
  /** Runs inside the Nth extra attempt (1-based), before its result returns. */
  onAttempt?: (attempt: number) => void;
  budgetExhausted?: boolean;
}): Harness {
  const stageAbort = new AbortController();
  const turnAbort = new AbortController();
  const excluded = new Set<string>();
  const calls: CascadeMessage[][] = [];
  const health: RecordedHealth = { successes: [], failures: [] };
  const warns: string[] = [];
  const first = options.results[0] ?? { content: "" };
  const h = {
    deps: undefined as unknown as EmptyCascadeDeps<EmptyAdvanceResult>,
    calls,
    health,
    excluded,
    stageAbort,
    turnAbort,
    warns,
    first,
    budgetExhausted: options.budgetExhausted ?? false,
  };

  h.deps = {
    messages: [
      { role: "system", content: "baseline contract" },
      { role: "user", content: "do the thing" },
    ],
    surfaceAsAnswer: options.surfaceAsAnswer ?? true,
    stage: "synthesizer",
    exclude: excluded,
    maxAdvances: options.maxAdvances ?? 3,
    attempt: async (messages) => {
      const advance = calls.length + 1;
      calls.push(messages);
      options.onAttempt?.(advance);
      return options.results[Math.min(advance, options.results.length - 1)];
    },
    stageHealth: {
      recordSuccess: (input) => health.successes.push(input),
      recordFailure: (failure) => health.failures.push(failure),
    },
    settlement: () => settleStageAttempt({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal }).settlement,
    budgetExhausted: () => h.budgetExhausted,
    warn: (message) => warns.push(message),
  };

  return h;
}

const empty = (provider?: string, model?: string): EmptyAdvanceResult => ({
  content: "",
  ...(provider ? { _provider: provider } : {}),
  ...(model ? { _modelUsed: model } : {}),
});

const prose = (provider: string, model: string, text: string): EmptyAdvanceResult => ({
  content: text,
  _provider: provider,
  _modelUsed: model,
});

describe("runEmptyCompletionCascade", () => {
  test("a first empty completion advances exactly one model and stops at prose", async () => {
    const h = harness({ results: [empty("openrouter", "model-a"), prose("openrouter", "model-b", "done")] });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(1);
    expect(result.content).toBe("done");
    expect(h.excluded.has("openrouter:model-a")).toBe(true);
    expect(h.health.failures).toEqual([
      { provider: "openrouter", modelId: "model-a", stage: "synthesizer", kind: "empty_completion" },
    ]);
    expect(h.health.successes).toEqual([{ provider: "openrouter", modelId: "model-b", stage: "synthesizer" }]);
  });

  test("a stage stopped before the loop gets no extra call and no attribution", async () => {
    const h = harness({ results: [empty("openrouter", "model-a"), prose("openrouter", "model-b", "late")] });
    h.stageAbort.abort("conductor stopped the synthesizer");

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(0);
    expect(result.content).toBe("");
    expect(h.excluded.size).toBe(0);
    expect(h.health.failures).toEqual([]);
    expect(h.health.successes).toEqual([]);
    expect(h.warns.some((w) => w.includes("stage_aborted"))).toBe(true);
  });

  test("a stage abort that lands while an advance is in flight settles before the next one", async () => {
    const h = harness({
      results: [empty("openrouter", "model-a"), prose("openrouter", "model-b", "late")],
      onAttempt: () => h.stageAbort.abort("conductor stopped the synthesizer"),
    });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    // The first advance was already in flight when the Conductor stopped the
    // stage; the loop must not spend a second one, and must not accept the late
    // prose as this stage's answer.
    expect(h.calls.length).toBe(1);
    expect(result.content).toBe("late");
    expect(h.health.successes).toEqual([]);
  });

  test("a turn cancellation stops the cascade without blaming a model", async () => {
    const h = harness({
      results: [empty("openrouter", "model-a"), prose("openrouter", "model-b", "late")],
      onAttempt: () => h.turnAbort.abort("user pressed Stop"),
    });

    await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(1);
    expect(h.health.successes).toEqual([]);
    expect(h.warns.some((w) => w.includes("turn_cancelled"))).toBe(true);
  });

  test("a stage stopped after prose arrived still records nothing against the model", async () => {
    const h = harness({ results: [prose("openrouter", "model-a", "answer")] });
    h.stageAbort.abort("conductor stopped the stage after the answer landed");

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(result.content).toBe("answer");
    expect(h.calls.length).toBe(0);
    expect(h.health.successes).toEqual([]);
    expect(h.health.failures).toEqual([]);
  });

  test("ordinary empty completions from a live stage stay fallback-eligible", async () => {
    const h = harness({
      results: [
        empty("openrouter", "model-a"),
        empty("openrouter", "model-b"),
        prose("openrouter", "model-c", "finally"),
      ],
      maxAdvances: 3,
    });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(2);
    expect(result.content).toBe("finally");
    expect(h.excluded.has("openrouter:model-a")).toBe(true);
    expect(h.excluded.has("openrouter:model-b")).toBe(true);
    expect(h.health.failures).toHaveLength(2);
  });

  test("a model-only stage is done on tool calls, not prose", async () => {
    const toolCall = { name: "read_file" };
    const h = harness({
      results: [{ content: "", tool_calls: [toolCall], _provider: "openrouter", _modelUsed: "model-a" }],
      surfaceAsAnswer: false,
    });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(result.tool_calls).toEqual([toolCall]);
    expect(h.calls.length).toBe(0);
    expect(h.health.successes).toEqual([{ provider: "openrouter", modelId: "model-a", stage: "synthesizer" }]);
  });

  test("an answer stage does not accept tool calls as an answer", async () => {
    const h = harness({
      results: [
        { content: "", tool_calls: [{ name: "read_file" }], _provider: "openrouter", _modelUsed: "model-a" },
        prose("openrouter", "model-b", "prose"),
      ],
    });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(1);
    expect(result.content).toBe("prose");
  });

  test("the cascade stops when the pool has no model left to advance to", async () => {
    const h = harness({ results: [empty("openrouter", "model-a")] });
    h.excluded.add("openrouter:model-a");

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(0);
    expect(result.content).toBe("");
    expect(h.warns.some((w) => w.includes("no different model left in pool"))).toBe(true);
  });

  test("the cascade stops on the turn-budget wall rather than starting an unbudgeted call", async () => {
    const h = harness({ results: [empty("openrouter", "model-a")], budgetExhausted: true });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(0);
    expect(result.content).toBe("");
    expect(h.health.failures).toEqual([
      { provider: "openrouter", modelId: "model-a", stage: "synthesizer", kind: "empty_completion" },
    ]);
    expect(h.warns.some((w) => w.includes("turn budget remaining"))).toBe(true);
  });

  test("a result with no model identity stops instead of looping forever", async () => {
    const h = harness({ results: [empty()], maxAdvances: 3 });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(0);
    expect(result.content).toBe("");
  });

  test("the cascade returns the last result it actually obtained", async () => {
    const h = harness({ results: [empty("openrouter", "model-a"), empty("openrouter", "model-b")], maxAdvances: 3 });

    const result = await runEmptyCompletionCascade(h.deps, h.first);

    expect(result._modelUsed).toBe("model-b");
    expect(h.excluded.has("openrouter:model-b")).toBe(true);
  });

  test("the advance bound caps the extra provider calls", async () => {
    const h = harness({
      results: [
        empty("openrouter", "model-a"),
        empty("openrouter", "model-b"),
        empty("openrouter", "model-c"),
        empty("openrouter", "model-d"),
      ],
      maxAdvances: 2,
    });

    await runEmptyCompletionCascade(h.deps, h.first);

    expect(h.calls.length).toBe(2);
  });

  test("a StageAbortedError escaping an advance is not converted into a further attempt", async () => {
    const h = harness({ results: [empty("openrouter", "model-a")] });
    h.deps.attempt = async () => {
      throw new StageAbortedError("synthesizer");
    };

    // The transport settles a stopped stage by throwing. The loop must let that
    // reach the pipeline rather than turning it into an empty completion and
    // spending another provider call. The one strike that exists is for the
    // pre-abort empty completion, which was a real observation.
    await expect(runEmptyCompletionCascade(h.deps, h.first)).rejects.toThrow("Stage aborted: synthesizer");
    expect(h.health.failures).toHaveLength(1);
    expect(h.health.successes).toEqual([]);
  });
});

describe("empty-advance prompt nudge", () => {
  test("an answer stage is nudged toward prose, a tool stage toward a tool call", () => {
    expect(buildEmptyAdvanceNudge(true)).toContain("no tools available");
    expect(buildEmptyAdvanceNudge(false)).toContain("emit a valid tool call");
  });

  test("the nudge is spliced into the leading system message so it stays in the system prompt", () => {
    const messages: CascadeMessage[] = [
      { role: "system", content: "baseline" },
      { role: "user", content: "hi" },
    ];

    const nudged = withEmptyAdvanceNudge(messages, "NUDGE");

    expect(nudged[0]).toEqual({ role: "system", content: "baseline\n\nNUDGE" });
    expect(nudged[1]).toEqual({ role: "user", content: "hi" });
    expect(messages[0]).toEqual({ role: "system", content: "baseline" });
  });

  test("a stage with no leading system message still receives the nudge as a system message", () => {
    const nudged = withEmptyAdvanceNudge([{ role: "user", content: "hi" }], "NUDGE");

    expect(nudged[0]).toEqual({ role: "system", content: "NUDGE" });
  });

  test("the cascade sends the nudged prompt, keeping the stage baseline intact", async () => {
    const h = harness({ results: [empty("openrouter", "model-a"), prose("openrouter", "model-b", "done")] });

    await runEmptyCompletionCascade(h.deps, h.first);

    const retried = h.calls[0];
    expect(String(retried[0].content)).toContain("no tools available");
    expect(String(retried[0].content)).toContain("baseline contract");
    expect(retried[1]).toEqual({ role: "user", content: "do the thing" });
  });
});
