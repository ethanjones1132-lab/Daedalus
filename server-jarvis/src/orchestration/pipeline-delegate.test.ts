import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { ExecutorStageOutput } from "./stage-output";
import {
  MAX_DELEGATE_LAUNCHES_PER_RUN,
  PipelineExecutor,
  shouldBenchDelegateForRun,
} from "./pipeline";
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

/** Default delegate model is Anthropic-native (minimax-m3); eligibility requires a Go key. */
function delegateTestConfig() {
  const config = defaultConfig();
  config.opencode_go.api_key = "go-test-key";
  return config;
}

describe("executor delegate pipeline integration", () => {
  test("delegate-first returns a verified delegated write without entering the native executor", async () => {
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const rows: any[] = [];
    const attributions: any[] = [];
    const health = new DelegateHealth();
    const executor = new PipelineExecutor(
      async () => {
        modelCalls += 1;
        return { content: "no native or downstream model may run", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        recordStageRun: (row) => rows.push(row),
        recordModelAttribution: (row) => attributions.push(row),
      },
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
    expect(rows).toContainEqual(expect.objectContaining({
      stop_reason: "failed",
      partial_error_code: "delegate_cleanup_unconfirmed",
      was_successful: 0,
      had_error: 1,
    }));
    expect(attributions).toContainEqual(expect.objectContaining({
      provider: "claude_cli",
      was_successful: 0,
      had_error: 1,
      fallback_used: 0,
    }));
  }, 300);

  test("aborted late-factory cleanup uncertainty is failed rather than routine cancellation", async () => {
    const config = delegateTestConfig();
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
    const rows: any[] = [];
    const attributions: any[] = [];
    const health = new DelegateHealth();
    const executor = new PipelineExecutor(
      async () => {
        modelCalls += 1;
        return { content: "downstream model must not run", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        recordStageRun: (row) => rows.push(row),
        recordModelAttribution: (row) => attributions.push(row),
      },
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
    expect(rows).toContainEqual(expect.objectContaining({
      stop_reason: "failed",
      partial_error_code: "delegate_cleanup_unconfirmed",
      was_successful: 0,
      had_error: 1,
    }));
    expect(attributions).toContainEqual(expect.objectContaining({
      provider: "claude_cli",
      was_successful: 0,
      had_error: 1,
      fallback_used: 0,
    }));
  }, 300);

  test("escalation invokes the delegate only after a native executor pass produces no write", async () => {
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-zero-write",
      workspace_path: config.jarvis_path,
    });
    const rows: any[] = [];
    const attributions: any[] = [];
    let delegateCalls = 0;
    let nativeCalls = 0;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "Native executor made its one bounded attempt.", tool_calls: [] };
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
    expect(attributions).toContainEqual(expect.objectContaining({
      provider: "claude_cli",
      fallback_used: 1,
    }));
  });

  test("executor abort registry cancels the delegate without launching native fallback", async () => {
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
      const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
    const config = delegateTestConfig();
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
      stage_id: "executor",
      was_successful: 1,
      had_error: 0,
    });
  });

  test("delegate_first mid-loop defers force_write during exploration so the write can land", async () => {
    // Wall-clock budget: this test exercises the full delegate mid-loop deferral
    // path (45s exploration limit, two read_file calls, mid-loop force_write
    // directive, deferred-but-still-applied write) and consistently runs >5s
    // under full-suite load (observed 5016ms on a clean rerun while the 2467
    // sibling tests share the worker). The behavior under test is orthogonal
    // to wall-clock precision, so the 5s default budget is measuring the wrong
    // thing. 15_000ms follows the established pin pattern (claude-delegate
    // 2026-07-20 4pm, mcp-tools 2026-07-20 overnight, pipeline-telemetry
    // 2026-07-27 1pm/4pm, persistent-conductor 2026-07-21 4pm, session-authority
    // 2026-07-19 1pm, SkillsView 2026-07-21 4pm).
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    config.claude_cli.delegate.exploration_limit_ms = 45_000;
    config.claude_cli.delegate.native_fallback_reserve_ms = 30_000;
    config.orchestrator.conductor.in_turn_driver.enabled = true;
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-mid-loop",
      workspace_path: config.jarvis_path,
    });
    const store = new SelfTuningStore(":memory:");
    const collector = new SessionOutcomeCollector(store);
    collector.startAgentRun(
      "run-delegate-mid-loop",
      "session-delegate-mid-loop",
      "Change result.txt",
      "general",
      ["executor"],
    );

    const midLoopSignals: any[] = [];
    let nativeCalls = 0;
    const reads = [
      {
        name: "read_file",
        arguments: { path: "result.txt" },
        output: "old content",
        is_error: false,
        duration_ms: 4,
      },
      {
        name: "read_file",
        arguments: { path: "other.txt" },
        output: "other",
        is_error: false,
        duration_ms: 3,
      },
    ];
    const writeCall = {
      name: "write_file",
      arguments: { path: "result.txt", content: "new content" },
      output: "wrote result.txt",
      is_error: false,
      duration_ms: 5,
    };

    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "Native must not take over during productive exploration.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        bus: { registerAbortHandle: () => {}, publishThrottled: () => {}, resolveAbort: () => {} },
        collector,
        live: {
          onToolResult: () => {},
          checkMidLoop: async (signal: any) => {
            midLoopSignals.push(signal);
            // After two reads with zero writes, apply write pressure — but
            // exploration window is still open so the host must defer, not hand off.
            if (signal.distinctSuccessfulReads >= 2 && signal.successfulWrites === 0) {
              return {
                kind: "force_write",
                note: "Apply the change now (delegate mid-loop).",
                decisionSource: "deterministic_reflex",
              };
            }
            return { kind: "continue", decisionSource: "no_signal" };
          },
          afterStage: async () => ({ type: "continue" }),
        },
      } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          const toolCalls: any[] = [];
          for (const call of reads) {
            input.onToolUse?.(call);
            await input.onToolResult?.(call);
            toolCalls.push(call);
            // force_write after the second read must NOT abort during exploration.
            if (input.signal?.aborted) {
              return {
                ok: false,
                narrative: "Delegate aborted unexpectedly during exploration.",
                terminalStatus: "cancelled",
                errorCode: "delegate_aborted",
                toolCalls: [...toolCalls],
              };
            }
          }
          // Delegate continues after deferred force_write and lands the write.
          input.onToolUse?.(writeCall);
          await input.onToolResult?.(writeCall);
          toolCalls.push(writeCall);
          return {
            ok: true,
            narrative: "Delegate applied the change after exploration.",
            terminalStatus: "completed",
            toolCalls,
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-mid-loop",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        taskRunWriteIntent: true,
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 120_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(midLoopSignals.length).toBeGreaterThanOrEqual(2);
    expect(midLoopSignals.some((s) => s.taskObjective?.includes("Change result.txt"))).toBe(true);
    expect(midLoopSignals.some((s) => (s.recentReadTargets ?? []).includes("result.txt"))).toBe(true);

    const allDirectives = store.getConductorDirectives("run-delegate-mid-loop");
    const midLoopDirectives = allDirectives
      .filter((row) => row.directive_type.startsWith("mid_loop_"));
    expect(midLoopDirectives.length).toBeGreaterThanOrEqual(1);
    expect(midLoopDirectives.some((row) => row.directive_type === "mid_loop_force_write")).toBe(true);
    expect(allDirectives.some((row) => row.directive_type === "delegate_intervention_deferred")).toBe(true);

    // Productive exploration + deferred force_write → verified write, no native fallback.
    expect(nativeCalls).toBe(0);
    expect(segment.state.executor?.ok).toBe(true);
    expect(segment.state.executor?.toolCalls).toContainEqual(expect.objectContaining({
      name: "write_file",
      is_error: false,
    }));
  }, 15_000);

  test("delegate_first mid-loop hands off after exploration deadline", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    // Negative limit: any elapsed_ms > limit → force_write becomes handoff
    // (0 is flaky when the fake delegate finishes in the same millisecond).
    config.claude_cli.delegate.exploration_limit_ms = -1;
    config.claude_cli.delegate.native_fallback_reserve_ms = 30_000;
    config.orchestrator.conductor.in_turn_driver.enabled = true;
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-deadline-handoff",
      workspace_path: config.jarvis_path,
    });
    let nativeCalls = 0;
    const reads = [
      {
        name: "read_file",
        arguments: { path: "result.txt" },
        output: "old",
        is_error: false,
        duration_ms: 2,
      },
      {
        name: "read_file",
        arguments: { path: "other.txt" },
        output: "other",
        is_error: false,
        duration_ms: 2,
      },
    ];

    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return {
          content: "Native completed after exploration deadline handoff.",
          tool_calls: [{
            id: "n1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "result.txt", content: "native" }),
            },
          }],
        };
      },
      createToolRuntime(),
      ctx,
      {
        bus: { registerAbortHandle: () => {}, publishThrottled: () => {}, resolveAbort: () => {} },
        collector: { recordStageRun: () => {}, recordDirective: () => {}, recordModelAttribution: () => {} },
        live: {
          onToolResult: () => {},
          checkMidLoop: async (signal: any) => {
            if (signal.distinctSuccessfulReads >= 2 && signal.successfulWrites === 0) {
              return {
                kind: "force_write",
                note: "Exploration expired; write now.",
                decisionSource: "deterministic_reflex",
              };
            }
            return { kind: "continue", decisionSource: "no_signal" };
          },
          afterStage: async () => ({ type: "continue" }),
        },
      } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          for (const call of reads) {
            input.onToolUse?.(call);
            await input.onToolResult?.(call);
            if (input.signal?.aborted) {
              return {
                ok: false,
                narrative: "Delegate aborted by exploration deadline handoff.",
                terminalStatus: "cancelled",
                errorCode: "delegate_aborted",
                toolCalls: [...reads],
              };
            }
          }
          return {
            ok: false,
            narrative: "Delegate finished without a write.",
            terminalStatus: "completed",
            errorCode: "delegate_no_write",
            toolCalls: [...reads],
          };
        },
      },
    );

    await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-deadline-handoff",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        taskRunWriteIntent: true,
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 120_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(nativeCalls).toBeGreaterThanOrEqual(1);
  });

  test("delegate_first mid-loop hands off after policy denial", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    config.claude_cli.delegate.exploration_limit_ms = 45_000;
    config.orchestrator.conductor.in_turn_driver.enabled = true;
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-policy-handoff",
      workspace_path: config.jarvis_path,
    });
    let nativeCalls = 0;
    const deniedWrite = {
      name: "write_file",
      arguments: { path: "result.txt", content: "x" },
      output: "policy denied",
      is_error: true,
      error_code: "policy_denied",
      duration_ms: 3,
    };

    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "Native took over after policy denial.", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        bus: { registerAbortHandle: () => {}, publishThrottled: () => {}, resolveAbort: () => {} },
        collector: { recordStageRun: () => {}, recordDirective: () => {}, recordModelAttribution: () => {} },
        live: {
          onToolResult: () => {},
          checkMidLoop: async () => ({
            kind: "force_write",
            note: "Write was denied; hand off.",
            decisionSource: "deterministic_reflex",
          }),
          afterStage: async () => ({ type: "continue" }),
        },
      } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          input.onToolUse?.(deniedWrite);
          await input.onToolResult?.(deniedWrite);
          if (input.signal?.aborted) {
            return {
              ok: false,
              narrative: "Delegate aborted by policy-denial handoff.",
              terminalStatus: "cancelled",
              errorCode: "delegate_aborted",
              toolCalls: [deniedWrite],
            };
          }
          return {
            ok: false,
            narrative: "Delegate finished after denial without handoff.",
            terminalStatus: "completed",
            errorCode: "delegate_no_write",
            toolCalls: [deniedWrite],
          };
        },
      },
    );

    await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-policy-handoff",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        taskRunWriteIntent: true,
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 120_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(nativeCalls).toBeGreaterThanOrEqual(1);
  });

  test("delegate_first mid-loop abort returns a clean partial without native fallback", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    config.orchestrator.conductor.in_turn_driver.enabled = true;
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-mid-abort",
      workspace_path: config.jarvis_path,
    });
    let nativeCalls = 0;
    const executor = new PipelineExecutor(
      async () => {
        nativeCalls += 1;
        return { content: "native must not run after mid-loop abort", tool_calls: [] };
      },
      createToolRuntime(),
      ctx,
      {
        bus: { registerAbortHandle: () => {}, publishThrottled: () => {}, resolveAbort: () => {} },
        collector: { recordStageRun: () => {}, recordDirective: () => {} },
        live: {
          onToolResult: () => {},
          checkMidLoop: async () => ({
            kind: "abort",
            reason: "budget too low to recover",
            decisionSource: "deterministic_reflex",
          }),
          afterStage: async () => ({ type: "continue" }),
        },
      } as any,
      {
        availability: { isAvailable: async () => true },
        run: async (input) => {
          const call = {
            name: "read_file",
            arguments: { path: "result.txt" },
            output: "content",
            is_error: false,
            duration_ms: 2,
          };
          input.onToolUse?.(call);
          await input.onToolResult?.(call);
          return {
            ok: false,
            narrative: "aborted",
            terminalStatus: "cancelled",
            errorCode: "delegate_aborted",
            toolCalls: [call],
          };
        },
      },
    );

    const segment = await executor.executeSegment(
      "Change result.txt",
      ["executor"],
      "run-delegate-mid-abort",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        taskRunWriteIntent: true,
        maxReviewRepairRounds: 0,
        turnBudget: {
          stageRemainingMs: () => 5_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(nativeCalls).toBe(0);
    expect(segment.state.executor).toMatchObject({
      ok: false,
      errorCode: "mid_loop_abort",
      terminalStatus: "partial",
    });
    expect(segment.state.executor?.narrative).toContain("budget too low");
  });

  test("unverified escalation is downgraded and never bounces back to native", async () => {
    const config = delegateTestConfig();
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

  // 2026-08-02: the delegate is the committed executor architecture for
  // write-intent turns. Measured over the fresh post-deploy window it does 7
  // tool calls per launch against the native loop's 1.4, and the budget is
  // ~100% model round-trip: 138s of turns carrying 91ms of actual file I/O
  // (a 1522x ratio). Round-trip COUNT is the only lever that moves that, and
  // the delegate is ~5x better on it.
  //
  // Previously `delegateAttemptedRuns` was a boolean Set — one launch per
  // agent run forever — so every re-entered segment fell back to the native
  // one-call-per-turn loop. That is what produced 17 reads / 0 writes in
  // run_8e930248.
  //
  // The original "one delegate process per logical agent run" invariant was
  // adopted for idempotency. It is safe to relax now for two reasons that did
  // not hold then: the delegate prompt carries a path-level evidence
  // checkpoint (`buildEvidenceCheckpoint`), so a re-entry does not rediscover;
  // and a re-applied edit is naturally idempotent (`edit_file` fails on a
  // stale old_string, `write_file` is last-write-wins). The cap below keeps a
  // failing delegate from spawning unbounded subprocesses, and DelegateHealth
  // cooldown remains the second guard.
  test("the delegate serves re-entered segments up to a bounded launch cap", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-reentry",
      workspace_path: config.jarvis_path,
    });
    const collector = { recordStageRun: () => {}, recordModelAttribution: () => {} };
    let delegateCalls = 0;
    const delegateRuntime = {
      availability: { isAvailable: async () => true },
      run: async () => {
        delegateCalls += 1;
        return verifiedDelegateOutput();
      },
    };
    const executor = new (PipelineExecutor as any)(
      async () => ({ content: "native fallback" }),
      createToolRuntime(),
      ctx,
      collector,
      delegateRuntime,
    ) as PipelineExecutor;

    const runOnce = () =>
      executor.executeSegment("Change result.txt", ["executor"], "run-delegate-reentry", () => {}, {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
      });

    // Same agentRunId across segments — this is exactly the re-entry the old
    // boolean gate blocked after the first launch.
    await runOnce();
    await runOnce();
    expect(delegateCalls).toBe(2);
  });

  test("the launch cap stops the delegate from spawning unbounded subprocesses", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-cap",
      workspace_path: config.jarvis_path,
    });
    const collector = { recordStageRun: () => {}, recordModelAttribution: () => {} };
    let delegateCalls = 0;
    const delegateRuntime = {
      availability: { isAvailable: async () => true },
      run: async () => {
        delegateCalls += 1;
        return verifiedDelegateOutput();
      },
    };
    const executor = new (PipelineExecutor as any)(
      async () => ({ content: "native fallback" }),
      createToolRuntime(),
      ctx,
      collector,
      delegateRuntime,
    ) as PipelineExecutor;

    for (let i = 0; i < MAX_DELEGATE_LAUNCHES_PER_RUN + 3; i++) {
      await executor.executeSegment("Change result.txt", ["executor"], "run-delegate-cap", () => {}, {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
      });
    }
    expect(delegateCalls).toBe(MAX_DELEGATE_LAUNCHES_PER_RUN);
  });

  test("separate agent runs each get their own launch budget", async () => {
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-delegate-budgets",
      workspace_path: config.jarvis_path,
    });
    const collector = { recordStageRun: () => {}, recordModelAttribution: () => {} };
    let delegateCalls = 0;
    const delegateRuntime = {
      availability: { isAvailable: async () => true },
      run: async () => {
        delegateCalls += 1;
        return verifiedDelegateOutput();
      },
    };
    const executor = new (PipelineExecutor as any)(
      async () => ({ content: "native fallback" }),
      createToolRuntime(),
      ctx,
      collector,
      delegateRuntime,
    ) as PipelineExecutor;

    for (const runId of ["run-budget-a", "run-budget-b"]) {
      await executor.executeSegment("Change result.txt", ["executor"], runId, () => {}, {
        executionProfile: "full",
        rawMessage: "Change result.txt",
        turnRequirement: "full_execution",
        maxReviewRepairRounds: 0,
      });
    }
    expect(delegateCalls).toBe(2);
  });

  test("B3: full_execution requirement arms write contract even without write-intent message", async () => {
    // 2026-08-04 (run_94cdcfdf): "continue please" had turnRequirement full_execution
    // but hasWriteIntent was false and contract writeIntent false → write_not_required.
    const config = delegateTestConfig();
    config.jarvis_path = process.cwd();
    config.claude_cli.delegate.policy = "delegate_first";
    const ctx = makeExecutionContext("agent", config, {
      session_id: "session-b3-full-execution-arms",
      workspace_path: config.jarvis_path,
    });
    let delegateCalls = 0;
    const executor = new (PipelineExecutor as any)(
      async () => ({ content: "native should not be primary" }),
      createToolRuntime(),
      ctx,
      { recordStageRun: () => {} },
      {
        availability: { isAvailable: async () => true },
        run: async () => {
          delegateCalls += 1;
          return verifiedDelegateOutput();
        },
      },
    ) as PipelineExecutor;

    await executor.executeSegment(
      "continue please",
      ["executor"],
      "run-b3-full-execution-arms",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "continue please",
        turnRequirement: "full_execution",
        taskRunWriteIntent: false,
        maxReviewRepairRounds: 0,
      },
    );

    expect(delegateCalls).toBe(1);
  });
});

describe("delegate benching distinguishes infrastructure from capability", () => {
  test("a pre-launch snapshot failure does not bench the delegate for the run", () => {
    expect(shouldBenchDelegateForRun("delegate_snapshot_error")).toBe(false);
    expect(shouldBenchDelegateForRun("delegate_integration_error")).toBe(false);
    expect(shouldBenchDelegateForRun("delegate_aborted")).toBe(false);
    expect(shouldBenchDelegateForRun("delegate_no_events")).toBe(false);
  });

  test("a model that ran and produced no write is still benched", () => {
    expect(shouldBenchDelegateForRun("delegate_no_write")).toBe(true);
    expect(shouldBenchDelegateForRun("mid_loop_handoff")).toBe(true);
    expect(shouldBenchDelegateForRun(undefined)).toBe(true);
  });
});

