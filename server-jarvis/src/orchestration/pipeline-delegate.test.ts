import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { ExecutorStageOutput } from "./stage-output";
import { PipelineExecutor } from "./pipeline";
import { runPipelineWithReplanning } from "./replan-loop";
import { Coordinator, type CoordinatorResult } from "./coordinator";
import { SessionOutcomeCollector, SelfTuningStore } from "../self-tuning/mod";
import {
  DelegateHealth,
  runClaudeDelegate,
  type DelegateRootSnapshot,
} from "./claude-delegate";

function verifiedDelegateOutput(): ExecutorStageOutput {
  return {
    ok: true,
    narrative: "Implemented and verified by the Claude delegate.",
    terminalStatus: "completed",
    toolCalls: [
      {
        name: "write_file",
        arguments: { path: "result.txt" },
        output: "Wrote result.txt",
        is_error: false,
        duration_ms: 12,
      },
      {
        name: "git_metadata",
        arguments: { roots: [process.cwd()] },
        output: "result.txt | 1 +",
        is_error: false,
        duration_ms: 0,
      },
    ],
  };
}

describe("executor delegate pipeline integration", () => {
  test("delegate-first returns a verified delegated write without entering the native executor", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-first",
      workspace_path: config.jarvis_path,
    });
    const stageRows: any[] = [];
    const attributions: any[] = [];
    const collector = {
      recordStageRun: (row: any) => stageRows.push(row),
      recordModelAttribution: (row: any) => attributions.push(row),
    };
    let nativeCalls = 0;
    let delegateCalls = 0;
    const delegateRuntime = {
      availability: { isAvailable: async () => true },
      run: async () => {
        delegateCalls += 1;
        return verifiedDelegateOutput();
      },
    };
    const executor = new (PipelineExecutor as any)(
      async () => {
        nativeCalls += 1;
        return { content: "native should not run" };
      },
      createToolRuntime(),
      ctx,
      collector,
      delegateRuntime,
    ) as PipelineExecutor;

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-first",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
      },
    );

    expect(delegateCalls).toBe(1);
    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toEqual(verifiedDelegateOutput());
    expect(stageRows).toHaveLength(1);
    expect(stageRows[0]).toMatchObject({
      mode_id: "executor",
      was_successful: 1,
      had_error: 0,
    });
    expect(JSON.parse(stageRows[0].tool_calls_json).map((call: any) => call.name))
      .toEqual(["write_file", "git_metadata"]);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      provider: "claude_cli",
      was_successful: 1,
      had_error: 0,
      fallback_used: 0,
    });
  });

  test("verified delegate writes are authoritative even when the delegate reports a later timeout", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-write-before-timeout",
      workspace_path: config.jarvis_path,
    });
    let nativeCalls = 0;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not duplicate a verified mutation", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        run: async () => ({
          ok: false,
          narrative: "The write completed before the delegate timed out.",
          terminalStatus: "timed_out",
          errorCode: "delegate_timeout",
          toolCalls: verifiedDelegateOutput().toolCalls,
        }),
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-write-before-timeout",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
      },
    );

    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toMatchObject({
      ok: true,
      terminalStatus: "completed",
    });
  });

  test("real delegate core verifies a write after timeout and pipeline never enters native fallback", async () => {
    const config = defaultConfig();
    const root = process.cwd();
    const claimedPath = `${root}\\claimed.ts`.toLowerCase();
    config.jarvis_path = root;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-real-core-write-timeout",
      workspace_path: config.jarvis_path,
    });
    const before: DelegateRootSnapshot = {
      root,
      kind: "git",
      status: "",
      diffStat: "",
      fingerprint: "before",
      files: { [claimedPath]: "100:10" },
    };
    const after: DelegateRootSnapshot = {
      ...before,
      status: " M claimed.ts",
      diffStat: " claimed.ts | 2 ++",
      fingerprint: "after",
      files: { [claimedPath]: "200:12" },
    };
    let captures = 0;
    let nativeCalls = 0;
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const health = new DelegateHealth();
    const snapshotFactory = {
      capture: async () => {
        captures += 1;
        return captures === 1 ? [before] : [after];
      },
    };
    const processFactory = async () => ({
      events: (async function* () {
        yield { type: "assistant", message: { content: [{
          type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
        }] } };
        yield { type: "user", message: { content: [{
          type: "tool_result", tool_use_id: "write-1", content: "claimed write",
        }] } };
        await new Promise(() => {});
      })(),
      exit,
      kill: (signal?: NodeJS.Signals) => {
        if (signal === "SIGKILL") finish({ code: null, signal });
      },
    });
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not duplicate the verified write", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        health,
        run: (input) => runClaudeDelegate({
          ...input,
          health,
          snapshotFactory,
          processFactory,
          terminationGraceMs: 1,
          cleanupTimeoutMs: 20,
          verificationTimeoutMs: 30,
        }),
      },
    );

    const segment = await executor.executeSegment(
      "Change claimed.ts",
      ["executor"],
      "run-real-core-write-timeout",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change claimed.ts",
        turnRequirement: "full_execution",
        turnBudget: {
          stageRemainingMs: () => 15,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(captures).toBe(2);
    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toMatchObject({ ok: true, terminalStatus: "completed" });
    expect(segment.state.executor?.toolCalls).toContainEqual(expect.objectContaining({
      name: "write_file",
      is_error: false,
    }));
  }, 250);

  test("unconfirmed delegate cleanup after a claimed write is terminal and never launches native", async () => {
    const config = defaultConfig();
    const root = process.cwd();
    const claimedPath = `${root}\\claimed.ts`.toLowerCase();
    config.jarvis_path = root;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-unsafe-cleanup",
      workspace_path: root,
    });
    const snapshot: DelegateRootSnapshot = {
      root, kind: "git", status: "", diffStat: "", fingerprint: "before",
      files: { [claimedPath]: "100:10" },
    };
    let nativeCalls = 0;
    const health = new DelegateHealth();
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not run while delegate process state is unsafe", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        health,
        run: (input) => runClaudeDelegate({
          ...input,
          health,
          terminationGraceMs: 1,
          cleanupTimeoutMs: 10,
          verificationTimeoutMs: 30,
          treeKiller: { signalTree: async () => {} },
          snapshotFactory: { capture: async () => [snapshot] },
          processFactory: async () => ({
            events: (async function* () {
              yield { type: "assistant", message: { content: [{
                type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
              }] } };
              yield { type: "user", message: { content: [{
                type: "tool_result", tool_use_id: "write-1", content: "claimed write",
              }] } };
              await new Promise(() => {});
            })(),
            exit: new Promise(() => {}),
            kill: () => {},
          }),
        }),
      },
    );

    const segment = await executor.executeSegment(
      "Change claimed.ts",
      ["executor", "reviewer", "synthesizer"],
      "run-unsafe-cleanup",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change claimed.ts",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 15,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toMatchObject({
      ok: false,
      terminalStatus: "failed",
      errorCode: "delegate_cleanup_unconfirmed",
    });
    expect(health.snapshot().lastReason).toBe("termination_unconfirmed");
  }, 300);

  test("late-factory cleanup uncertainty is terminal across the full replan wrapper", async () => {
    const config = defaultConfig();
    const root = process.cwd();
    config.jarvis_path = root;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-late-factory-unsafe",
      workspace_path: root,
    });
    const snapshot: DelegateRootSnapshot = {
      root, kind: "git", status: "", diffStat: "", fingerprint: "before", files: {},
    };
    let modelCalls = 0;
    let replanCalls = 0;
    const health = new DelegateHealth();
    const executor = new PipelineExecutor(
      async () => {
        modelCalls += 1;
        return { content: "no native or downstream model may run", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        health,
        run: (input) => runClaudeDelegate({
          ...input,
          health,
          terminationGraceMs: 1,
          cleanupTimeoutMs: 10,
          snapshotFactory: { capture: async () => [snapshot] },
          processFactory: async () => new Promise(() => {}),
        }),
      },
    );
    const coordinator = new Coordinator(async () => ({ content: "unused" }));
    coordinator.route = async () => {
      replanCalls += 1;
      throw new Error("unsafe cleanup must not replan");
    };
    const initialDecision: CoordinatorResult = {
      task_type: "debug",
      pipeline: ["executor", "reviewer", "synthesizer"],
      topology: "linear",
      context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
      coordinator_rationale: "Late factory cleanup fixture.",
    };

    const result = await runPipelineWithReplanning({
      contextMessage: "Change claimed.ts",
      initialDecision,
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "session-late-factory-unsafe" },
      executor,
      agentRunId: "run-late-factory-unsafe",
      onStateChange: () => {},
      baseOptions: {
        executionProfile: "full",
        rawMessage: "Change claimed.ts",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 5,
          extendStageOnProgress: () => 0,
          canStart: () => true,
        } as any,
      },
      maxReplans: 1,
    });

    expect(modelCalls).toBe(0);
    expect(replanCalls).toBe(0);
    expect(result).toMatchObject({
      outcome: "failed",
      error_code: "delegate_cleanup_unconfirmed",
    });
  }, 300);

  test("aborted late-factory cleanup uncertainty is failed rather than routine cancellation", async () => {
    const config = defaultConfig();
    const root = process.cwd();
    config.jarvis_path = root;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-abort-late-factory-unsafe",
      workspace_path: root,
    });
    const turnAbort = new AbortController();
    const snapshot: DelegateRootSnapshot = {
      root, kind: "git", status: "", diffStat: "", fingerprint: "before", files: {},
    };
    let modelCalls = 0;
    const health = new DelegateHealth();
    const executor = new PipelineExecutor(
      async () => {
        modelCalls += 1;
        return { content: "downstream model must not run", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        health,
        run: (input) => runClaudeDelegate({
          ...input,
          health,
          terminationGraceMs: 1,
          cleanupTimeoutMs: 10,
          snapshotFactory: { capture: async () => [snapshot] },
          processFactory: async () => {
            queueMicrotask(() => turnAbort.abort("user_stop"));
            return new Promise(() => {});
          },
        }),
      },
    );
    const coordinator = new Coordinator(async () => ({ content: "unused" }));
    coordinator.route = async () => { throw new Error("unsafe cleanup must not replan"); };
    const result = await runPipelineWithReplanning({
      contextMessage: "Change claimed.ts",
      initialDecision: {
        task_type: "debug",
        pipeline: ["executor", "reviewer", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "Abort late factory fixture.",
      },
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "session-abort-late-factory-unsafe" },
      executor,
      agentRunId: "run-abort-late-factory-unsafe",
      onStateChange: () => {},
      baseOptions: {
        executionProfile: "full",
        rawMessage: "Change claimed.ts",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnAbort: turnAbort.signal,
      },
      maxReplans: 1,
    });

    expect(modelCalls).toBe(0);
    expect(result.cancelled).toBeUndefined();
    expect(result).toMatchObject({
      outcome: "failed",
      error_code: "delegate_cleanup_unconfirmed",
    });
  }, 300);

  test("escalation invokes the delegate only after a native executor pass produces no write", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "escalation";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-escalation",
      workspace_path: config.jarvis_path,
    });
    const order: string[] = [];
    const delegateRuntime = {
      availability: { isAvailable: async () => true },
      run: async (input: any) => {
        order.push(`delegate:${input.nativeNoWrite}`);
        return verifiedDelegateOutput();
      },
    };
    const executor = new PipelineExecutor(
      async () => {
        order.push("native");
        return { content: "I could not apply the requested change.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      delegateRuntime,
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-escalation",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(order).toEqual(["native", "delegate:true"]);
    expect(segment.state.executor?.ok).toBe(true);
    expect(segment.state.executor?.toolCalls.some((call) => call.name === "write_file" && !call.is_error)).toBe(true);
  });

  test("delegate-first zero-write preserves delegate evidence and falls through to native exactly once", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-zero-write",
      workspace_path: config.jarvis_path,
    });
    const rows: any[] = [];
    let delegateCalls = 0;
    let nativeCalls = 0;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "Native executor made its one bounded attempt.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: (row) => rows.push(row) },
      {
        availability: { isAvailable: async () => true },
        run: async () => {
          delegateCalls += 1;
          return {
            ok: true,
            narrative: "Delegate inspected the workspace but wrote nothing.",
            terminalStatus: "completed",
            toolCalls: [{
              name: "read_file",
              arguments: { path: "README.md" },
              output: "read evidence",
              is_error: false,
              duration_ms: 3,
            }],
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-zero-write",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(delegateCalls).toBe(1);
    expect(nativeCalls).toBe(1);
    expect(segment.state.executor?.toolCalls).toContainEqual(expect.objectContaining({
      name: "read_file",
      output: "read evidence",
    }));
    const delegateRows = rows.filter((row) => row.partial_error_code === "delegate_no_write");
    expect(delegateRows).toHaveLength(1);
    expect(JSON.parse(delegateRows[0].tool_calls_json)[0].name).toBe("read_file");
  });

  test("executor abort registry cancels the delegate without launching native fallback", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-abort",
      workspace_path: config.jarvis_path,
    });
    let nativeCalls = 0;
    let delegateSignal: AbortSignal | undefined;
    const bus = {
      registerAbortHandle: (stage: string, controller: AbortController) => {
        if (stage === "executor") queueMicrotask(() => controller.abort());
      },
      publishThrottled: () => {},
      resolveAbort: () => {},
    };
    const live = { afterStage: async () => ({ type: "continue" }) };
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not start after cancellation", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { bus, live, collector: { recordStageRun: () => {} } } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          delegateSignal = input.signal;
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) resolve();
            else input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            ok: false,
            narrative: "Delegate cancelled.",
            terminalStatus: "cancelled",
            errorCode: "delegate_aborted",
            toolCalls: [{
              name: "delegate_cleanup",
              arguments: {},
              output: "Process tree terminated.",
              is_error: false,
              duration_ms: 0,
            }],
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-abort",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
      },
    );

    expect(delegateSignal?.aborted).toBe(true);
    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toMatchObject({
      ok: false,
      terminalStatus: "cancelled",
      errorCode: "delegate_aborted",
    });
  });

  test("request-wide abort cancels the delegate without conductor wiring or native fallback", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-request-abort",
      workspace_path: config.jarvis_path,
    });
    const turnAbort = new AbortController();
    let nativeCalls = 0;
    let delegateSignal: AbortSignal | undefined;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not start after request cancellation", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          delegateSignal = input.signal;
          queueMicrotask(() => turnAbort.abort("user_stop"));
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) resolve();
            else input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            ok: false,
            narrative: "Delegate cancelled by request.",
            terminalStatus: "cancelled",
            errorCode: "delegate_aborted",
            toolCalls: [],
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-request-abort",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        turnAbort: turnAbort.signal,
      },
    );

    expect(delegateSignal?.aborted).toBe(true);
    expect(nativeCalls).toBe(0);
    expect(segment.state.executor?.terminalStatus).toBe("cancelled");
  });

  for (const verifiedWrite of [false, true]) {
    test(`request cancellation propagates through the full replan wrapper ${verifiedWrite ? "after a verified write" : "with zero writes"}`, async () => {
      const config = defaultConfig();
      config.jarvis_path = process.cwd();
      config.claude_cli.delegate.policy = "delegate_first";
      const ctx = makeExecutionContext("agent", config, {
        session_id: `session-full-cancel-${verifiedWrite ? "write" : "zero"}`,
        workspace_path: config.jarvis_path,
      });
      const turnAbort = new AbortController();
      const modelStages: string[] = [];
      const states: any[] = [];
      const executor = new PipelineExecutor(
        async (_messages, options) => {
          modelStages.push(options?.stageLabel ?? "unknown");
          return { content: "downstream model work must not run" };
        },
        createToolRuntime(),
        ctx,
        { recordStageRun: () => {} },
        {
          availability: { isAvailable: async () => true },
          run: async () => {
            turnAbort.abort("user_stop");
            return {
              ok: false,
              narrative: "Delegate stopped at the request boundary.",
              terminalStatus: "cancelled",
              errorCode: "delegate_aborted",
              toolCalls: verifiedWrite ? verifiedDelegateOutput().toolCalls : [],
            };
          },
        },
      );
      const coordinator = new Coordinator(async () => ({ content: "unused" }));
      coordinator.route = async () => {
        throw new Error("cancelled runs must not replan");
      };
      const initialDecision: CoordinatorResult = {
        task_type: "debug",
        pipeline: ["executor", "reviewer", "synthesizer"],
        topology: "linear",
        context: {
          needs_workspace_inspection: true,
          needs_memory: false,
          estimated_complexity: "medium",
        },
        coordinator_rationale: "Cancellation propagation fixture.",
      };

      const result = await runPipelineWithReplanning({
        contextMessage: "Change result.txt",
        initialDecision,
        turnRequirement: "full_execution",
        coordinator,
        routeOptions: { sessionId: `session-full-cancel-${verifiedWrite ? "write" : "zero"}` },
        executor,
        agentRunId: `run-full-cancel-${verifiedWrite ? "write" : "zero"}`,
        onStateChange: (state) => states.push(state),
        baseOptions: {
          executionProfile: "full",
          rawMessage: "Change result.txt",
          turnRequirement: "full_execution",
          maxReviewRepairRounds: 0,
          turnAbort: turnAbort.signal,
        },
        maxReplans: 1,
      });

      expect(result.cancelled).toBe(true);
      expect(result.error_code).toBe("delegate_aborted");
      expect(result.toolCalls?.some((call) => call.name === "write_file" && !call.is_error))
        .toBe(verifiedWrite);
      expect(modelStages).toEqual([]);
      expect(states.some((state) => ["reviewer", "rewriter", "synthesizer", "conductor_replan"].includes(state.stage)))
        .toBe(false);
    });
  }

  test("a conductor replan never delegates again after the first attempt falls back to native", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-replan-latch",
      workspace_path: config.jarvis_path,
    });
    let delegateCalls = 0;
    let nativeExecutorCalls = 0;
    const executor = new PipelineExecutor(
      async (_messages, options) => {
        if (options?.stageLabel === "executor") nativeExecutorCalls += 1;
        if (options?.stageLabel === "synthesizer") return { content: "Honest final answer." };
        return { content: "Native bounded attempt.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        run: async () => {
          delegateCalls += 1;
          return {
            ok: false,
            narrative: "No verified write.",
            terminalStatus: "failed",
            errorCode: "delegate_no_write",
            toolCalls: [],
          };
        },
      },
    );
    const coordinator = new Coordinator(async () => ({ content: "unused" }));
    coordinator.route = async () => ({
      task_type: "debug",
      pipeline: ["executor", "synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: true,
        needs_memory: false,
        estimated_complexity: "medium",
      },
      coordinator_rationale: "Re-enter executor once.",
    });
    const initialDecision: CoordinatorResult = {
      task_type: "debug",
      pipeline: ["executor", "conductor_replan", "synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: true,
        needs_memory: false,
        estimated_complexity: "medium",
      },
      coordinator_rationale: "Exercise the replan boundary.",
    };

    await runPipelineWithReplanning({
      contextMessage: "Change result.txt",
      initialDecision,
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "session-delegate-replan-latch" },
      executor,
      agentRunId: "run-delegate-replan-latch",
      onStateChange: () => {},
      baseOptions: {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
      maxReplans: 1,
    });

    expect(delegateCalls).toBe(1);
    expect(nativeExecutorCalls).toBeGreaterThanOrEqual(2);
  });

  test("escalation still delegates after a native executor exception", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "escalation";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-exception-escalation",
      workspace_path: config.jarvis_path,
    });
    const order: string[] = [];
    const executor = new PipelineExecutor(
      async () => {
        order.push("native");
        throw new Error("native provider failed");
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        run: async () => {
          order.push("delegate");
          return verifiedDelegateOutput();
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-exception-escalation",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(order).toEqual(["native", "delegate"]);
    expect(segment.state.executor?.ok).toBe(true);
  });

  test("delegate integration rejection records a downgrade and falls back to native once", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-rejection",
      workspace_path: config.jarvis_path,
    });
    const rows: any[] = [];
    let nativeCalls = 0;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "Native fallback ran.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      { recordStageRun: (row) => rows.push(row) },
      {
        availability: { isAvailable: async () => true },
        run: async () => { throw new Error("delegate process spawn failed"); },
      },
    );

    await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-rejection",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(nativeCalls).toBe(1);
    expect(rows).toContainEqual(expect.objectContaining({
      partial_error_code: "delegate_integration_error",
      was_successful: 0,
      had_error: 1,
    }));
  });

  test("delegate streams through standard executor SSE hooks and persists stage/model attribution", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    config.claude_cli.delegate.model = "sonnet";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-sse-db",
      workspace_path: config.jarvis_path,
    });
    const store = new SelfTuningStore(":memory:");
    const collector = new SessionOutcomeCollector(store);
    const stageTokens: any[] = [];
    const states: any[] = [];
    const bus = {
      registerAbortHandle: () => {},
      publishThrottled: (event: any) => stageTokens.push(event),
      resolveAbort: () => {},
    };
    const live = { afterStage: async () => ({ type: "continue" }) };
    const output = verifiedDelegateOutput();
    const executor = new PipelineExecutor(
      async () => { throw new Error("native should not run"); },
      createToolRuntime(),
      ctx,
      { bus, live, collector } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          input.onTextDelta?.("delegated delta");
          input.onToolUse?.(output.toolCalls[0]);
          return output;
        },
      },
    );

    await executor.executeSegment(
        "Change result.txt",
        ["executor"],
        "run-delegate-sse-db",
        (state) => states.push(state),
        {
          executionProfile: "full",
          rawMessage: "Change result.txt",
          turnRequirement: "full_execution",
          maxReviewRepairRounds: 0,
        },
    );

    expect(states).toContainEqual(expect.objectContaining({
        stage: "executor",
        status: "running",
        output: "delegated delta",
    }));
    expect(states).toContainEqual(expect.objectContaining({
        stage: "executor",
        detail: "tool:write_file",
    }));
    expect(stageTokens).toContainEqual(expect.objectContaining({
        type: "stage_token",
        stage: "executor",
        textDelta: "delegated delta",
    }));

    const rows = store.getStageRuns("run-delegate-sse-db");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode_id: "executor", was_successful: 1, had_error: 0 });
    expect(JSON.parse(rows[0].tool_calls_json ?? "[]")[0].name).toBe("write_file");
    const attributions = store.getModelAttributions("run-delegate-sse-db");
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      provider: "claude_cli",
      model_id: "sonnet",
      was_successful: 1,
      had_error: 0,
    });
  });

  test("unverified escalation is downgraded and never bounces back to native", async () => {
    const config = defaultConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "escalation";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-no-bounce",
      workspace_path: config.jarvis_path,
    });
    const rows: any[] = [];
    const attributions: any[] = [];
    const order: string[] = [];
    const executor = new PipelineExecutor(
      async () => {
        order.push("native");
        return { content: "Native produced no write.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        recordStageRun: (row) => rows.push(row),
        recordModelAttribution: (row) => attributions.push(row),
      },
      {
        availability: { isAvailable: async () => true },
        run: async () => {
          order.push("delegate");
          return {
            ok: false,
            narrative: "Delegate claimed a write but verification found no change.",
            terminalStatus: "failed",
            errorCode: "delegate_write_unverified",
            toolCalls: [{
              name: "write_file",
              arguments: { path: "result.txt" },
              output: "delegate_write_unverified: no matching filesystem change was observed.",
              is_error: true,
              error_code: "delegate_write_unverified",
              duration_ms: 4,
            }],
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-no-bounce",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 7_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(order).toEqual(["native", "delegate"]);
    expect(segment.state.executor?.toolCalls).toContainEqual(expect.objectContaining({
      name: "write_file",
      error_code: "delegate_write_unverified",
      is_error: true,
    }));
    expect(rows.filter((row) => row.partial_error_code === "delegate_write_unverified")).toHaveLength(1);
    expect(attributions).toContainEqual(expect.objectContaining({
      provider: "claude_cli",
      was_successful: 0,
      had_error: 1,
      fallback_used: 1,
    }));
  });
});
