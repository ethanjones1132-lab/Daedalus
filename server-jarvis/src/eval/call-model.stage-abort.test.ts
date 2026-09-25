import { describe, expect, test } from "bun:test";
import { isStageAbortedError } from "../orchestration/stage-abort-link";
import { makeCallModel, stageAbortGuard } from "./call-model";
import type { JarvisConfig } from "../config";

const emptyConfig = { orchestrator: { agents: [] } } as unknown as JarvisConfig;

describe("stageAbortGuard", () => {
  test("an already-aborted stage fails closed with its own stable code", () => {
    const stageAbort = new AbortController();
    stageAbort.abort("Conductor ordered the reviewer to stop");

    const err = stageAbortGuard({ stage: "reviewer", stageAbort: stageAbort.signal });

    expect(err).not.toBeNull();
    expect(isStageAbortedError(err)).toBe(true);
    expect(err!.code).toBe("stage_aborted");
    expect(err!.stage).toBe("reviewer");
  });

  test("the executed stage label wins over the adapter's fixed stage", () => {
    const stageAbort = new AbortController();
    stageAbort.abort("stop");

    expect(stageAbortGuard({ stage: "agent", stageLabel: "synthesizer", stageAbort: stageAbort.signal })!.stage)
      .toBe("synthesizer");
  });

  test("a live or absent stage signal is inert", () => {
    expect(stageAbortGuard({ stage: "planner" })).toBeNull();
    expect(stageAbortGuard({ stage: "planner", stageAbort: new AbortController().signal })).toBeNull();
  });
});

describe("makeCallModel stage abort", () => {
  test("a pre-aborted stage rejects before any provider request is attempted", async () => {
    const stageAbort = new AbortController();
    stageAbort.abort("executor stopped");
    const callModel = makeCallModel(emptyConfig, "executor");

    const err = await callModel([{ role: "user", content: "hi" }], { stageAbort: stageAbort.signal }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isStageAbortedError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("stage_aborted");
    expect((err as Error).message).not.toContain("hi");
  });
});
