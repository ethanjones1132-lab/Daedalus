import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import { getToolsForMode } from "../../orchestration/modes";
import { defaultConfig } from "../../config";
import { makeExecutionContext } from "../../tool-runtime";
import type { CallModelFn } from "../../orchestration/coordinator";
import { loadTrainingTasks } from "./fixture-tasks";
import {
  buildFixtureRolloutRequest,
  buildRolloutRuntime,
  runGradedFixtureCheck,
  runOneRollout,
} from "./rollout-runner";

const hiddenFileTask = loadTrainingTasks().find((t) => t.name === "pkg_discount")!;

/**
 * These use a scripted CallModelFn rather than a live model: the point is to
 * prove the rollout PLUMBING (θ scoping, workspace seeding, write-effect
 * capture, reward computation, cleanup), which must hold regardless of which
 * model runs. A live-Ollama smoke test is a separate, slower check.
 */

const task = loadTrainingTasks().find((t) => t.name === "merge_intervals")!;

/**
 * Phase-D fixtures are test-driven: the graded oracle lives at `_t.py`.
 * Naming it in the request closes the dominant failure mode (models that
 * never discover or run the test). This is a deliberate semantic shift from
 * blind-fix to "fix and verify against the seeded oracle."
 */
describe("buildFixtureRolloutRequest", () => {
  test("names the graded test and requires running it before success", () => {
    const request = buildFixtureRolloutRequest(task);
    expect(request).toContain(task.spec);
    expect(request).toContain(task.entry);
    expect(request).toContain("_t.py");
    expect(request.toLowerCase()).toContain("run");
    expect(request.toLowerCase()).toMatch(/do not (edit|delete)/);
  });

  test("runOneRollout surfaces that request text to the model", async () => {
    const seenUser: string[] = [];
    const spy: CallModelFn = async (messages) => {
      for (const m of messages) {
        if (m.role === "user" && typeof m.content === "string") {
          seenUser.push(m.content);
        }
      }
      return { content: "I have considered it." };
    };
    await runOneRollout({ theta: BASELINE_THETA, task, seed: 9 }, spy);
    const joined = seenUser.join("\n");
    expect(joined).toContain("_t.py");
    expect(joined).toContain(task.entry);
  });
});

describe("rollout tool boundary", () => {
  test("registers only filesystem capabilities and rejects escape tools", async () => {
    const runtime = buildRolloutRuntime();
    const tools = runtime.listTools();
    const names = tools.map((tool) => tool.function.name);
    const filesystemTools = [
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "apply_patch",
      "glob",
      "grep",
      "list_directory",
    ];

    expect(new Set(names)).toEqual(new Set(filesystemTools));
    expect(
      tools.every((tool) =>
        tool.capability !== undefined &&
        ["read", "list", "write"].includes(tool.capability.class),
      ),
    ).toBe(true);

    const context = makeExecutionContext("chat", defaultConfig(), {
      workspace_path: process.cwd(),
    });
    const forbiddenTools = [
      "bash",
      "powershell",
      "agent",
      "run_background_command",
      "task_create",
      "task_list",
      "task_get",
      "task_output",
      "task_stop",
      "todo_write",
      "todo_list",
      "tools_enum",
      "web_search",
      "web_fetch",
      "mcp_list_tools",
      "mcp_call_tool",
      "mcp_read_resource",
      "git_metadata",
      "ask_user_question",
    ];

    for (const name of forbiddenTools) {
      const result = await runtime.execute(
        { id: `forbidden-${name}`, name, arguments: {} },
        context,
      );
      expect(result.is_error).toBe(true);
      expect(result.error_code).toBe("unknown_tool");
    }
  });

  test("exposes only filesystem tools to the executor and read tools to the reviewer", () => {
    const tools = buildRolloutRuntime().listTools();
    const namesFor = (mode: string) =>
      new Set(getToolsForMode(mode, tools).map((tool) => tool.function.name));

    expect(namesFor("planner")).toEqual(new Set());
    expect(namesFor("executor")).toEqual(new Set([
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "apply_patch",
      "glob",
      "grep",
      "list_directory",
    ]));
    expect(namesFor("reviewer")).toEqual(new Set([
      "read_file",
      "glob",
      "grep",
      "list_directory",
    ]));
    expect(namesFor("synthesizer")).toEqual(new Set());
  });
});

/** Model that edits the entry file with a correct fix. */
const fixingModel: CallModelFn = async (_messages, options) => {
  if (options?.stageLabel === "executor") {
    return {
      content: "applying the fix",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: task.entry,
              content:
                "def merge_intervals(intervals):\n" +
                "    if not intervals:\n" +
                "        return []\n" +
                "    ordered = sorted(intervals)\n" +
                "    merged = [ordered[0]]\n" +
                "    for start, end in ordered[1:]:\n" +
                "        last_start, last_end = merged[-1]\n" +
                "        if start <= last_end:\n" +
                "            merged[-1] = (last_start, max(last_end, end))\n" +
                "        else:\n" +
                "            merged.append((start, end))\n" +
                "    return merged\n",
            }),
          },
        } as never,
      ],
    };
  }
  return { content: "done" };
};

/** Model that never calls a tool — the no-write case. */
const inertModel: CallModelFn = async () => ({ content: "I have considered it." });

describe("runOneRollout", () => {
  test("injects RolloutSpec.seed into every model call", async () => {
    const seedsSeen: Array<number | undefined> = [];
    const spyModel: CallModelFn = async (_messages, options) => {
      seedsSeen.push(options?.seed);
      return { content: "I have considered it." };
    };

    await runOneRollout({ theta: BASELINE_THETA, task, seed: 7 }, spyModel);

    expect(seedsSeen.length).toBeGreaterThan(0);
    expect(seedsSeen.every((s) => s === 7)).toBe(true);
  });

  test("refuses to run without the NODE_ENV=test DB guard", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        runOneRollout({ theta: BASELINE_THETA, task, seed: 1 }, inertModel),
      ).rejects.toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test("a no-write rollout scores zero rather than crashing", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 1 },
      inertModel,
    );
    expect(outcome.task).toBe(task.name);
    expect(outcome.reward).toBeLessThanOrEqual(0);
    expect(outcome.breakdown.creditedWritePaths).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a rollout that lands a real write credits the entry path", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 2 },
      fixingModel,
    );
    // The write must be credited via real before/after content fingerprints,
    // not tool-call success — a no-op edit would earn nothing here.
    expect(
      outcome.breakdown.creditedWritePaths.some((p) => p.includes(task.entry)),
      `expected ${task.entry} in credited paths, got ${JSON.stringify(outcome.breakdown.creditedWritePaths)}`,
    ).toBe(true);
    expect(outcome.breakdown.terms.writes).toBeGreaterThan(0);
  });

  // Regression: rollout-runner previously hardcoded targetPaths to only
  // [task.entry], so a category-B rollout that correctly fixes the seeded
  // bug in hiddenFile (the realistic outcome for these fixtures — the entry
  // file is a thin wrapper, the bug lives in the dependency) scored zero on
  // the writes term. That would train CMA-ES to avoid touching hidden files
  // even when that is the only correct fix location.
  test("a rollout that lands a real write in hiddenFile credits it too", async () => {
    expect(hiddenFileTask.hiddenFile).toBeTruthy();
    const hiddenFile = hiddenFileTask.hiddenFile!;
    const fixesHiddenFile: CallModelFn = async (_messages, options) => {
      if (options?.stageLabel === "executor") {
        return {
          content: "the bug is in the dependency, fixing it there",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: hiddenFile,
                  content: `# fixed\n${hiddenFileTask.files[hiddenFile]}\n# end\n`,
                }),
              },
            } as never,
          ],
        };
      }
      return { content: "done" };
    };
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task: hiddenFileTask, seed: 4 },
      fixesHiddenFile,
    );
    expect(
      outcome.breakdown.creditedWritePaths.some((p) => p.includes(hiddenFile)),
      `expected ${hiddenFile} in credited paths, got ${JSON.stringify(outcome.breakdown.creditedWritePaths)}`,
    ).toBe(true);
    expect(outcome.breakdown.terms.writes).toBeGreaterThan(0);
  });

  test("a model that throws yields a scored non-positive outcome, not a crash", async () => {
    // The pipeline absorbs model transport failures itself and returns a
    // `failed` result, so this lands on the normal reward path (B2 hard-zero:
    // write-required turn, nothing written, no passing check) rather than the
    // runner's own catch. Either way the campaign must keep running and the
    // candidate must not be rewarded — that is what this asserts.
    const explodingModel: CallModelFn = async () => {
      throw new Error("simulated model transport failure");
    };
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 3 },
      explodingModel,
    );
    expect(outcome.reward).toBeLessThanOrEqual(0);
    expect(outcome.breakdown.creditedWritePaths).toEqual([]);
    expect(outcome.task).toBe(task.name);
  });

  // Anti-gaming wiring: without re-seeding authenticTest, a model that
  // neuters `_t.py` to `assert True` after a wrong edit would farm check=1
  // and a near-full reward. Production always re-seeds from fixture.test.
  test("a model that neuters _t.py cannot farm a passing check for a wrong fix", async () => {
    const tamperingModel: CallModelFn = async (_messages, options) => {
      if (options?.stageLabel === "executor") {
        return {
          content: "fixed and verified",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: task.entry,
                  // Intentionally broken — would fail the real oracle.
                  content: "def merge_intervals(intervals):\n    return intervals\n",
                }),
              },
            } as never,
            {
              id: "call_2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "_t.py",
                  content: "assert True\n",
                }),
              },
            } as never,
          ],
        };
      }
      return { content: "success" };
    };
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 5 },
      tamperingModel,
    );
    expect(outcome.breakdown.terms.check).toBe(0);
    // Full success requires a real independent check pass; oracle sabotage
    // must not unlock the top of the score range.
    expect(outcome.reward).toBeLessThan(1);
  });
});

/**
 * The graded `_t.py` is the fixture suite's ground-truth oracle. Scoring must
 * consult it directly rather than depending on whether the pipeline happened
 * to run a verification pass — a correct fix scored a B2 hard zero whenever
 * the run terminated through a route that skips the executor-completion check.
 */
describe("runGradedFixtureCheck", () => {
  function workspaceWith(testSource: string): string {
    const root = mkdtempSync(join(tmpdir(), "graded-check-test-"));
    writeFileSync(join(root, "_t.py"), testSource, "utf8");
    return root;
  }

  test("reports an independent pass when the graded test succeeds", async () => {
    const root = workspaceWith("assert 1 + 1 == 2\n");
    try {
      const check = await runGradedFixtureCheck(root);
      expect(check?.tier).toBe("existing");
      expect(check?.ran).toBe(true);
      expect(check?.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a failure with detail when the graded test fails", async () => {
    const root = workspaceWith("assert False, 'boom'\n");
    try {
      const check = await runGradedFixtureCheck(root);
      expect(check?.ran).toBe(true);
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("boom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stays bounded when the graded test never terminates", async () => {
    // A fixture suite exists to make models fix buggy code, so non-terminating
    // submissions are expected output, not an edge case. One unbounded child
    // stalled a whole campaign for 65 minutes.
    const root = workspaceWith("while True:\n    pass\n");
    try {
      const startedAt = Date.now();
      const check = await runGradedFixtureCheck(root, { timeoutMs: 2_000 });
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(check?.passed).not.toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("returns null when the workspace carries no graded test", async () => {
    const root = mkdtempSync(join(tmpdir(), "graded-check-test-"));
    try {
      expect(await runGradedFixtureCheck(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Phase-D anti-gaming: CMA-ES optimizes the graded-check scalar. A model that
   * neuters or deletes `_t.py` would otherwise farm reward for a wrong (or
   * empty) fix. Re-seed from the fixture definition before every check.
   */
  test("rejects a neutered graded test when authenticTest is supplied", async () => {
    const authentic = "assert False, 'real oracle still fails'\n";
    const root = workspaceWith(authentic);
    try {
      // Model tampering: replace the oracle with a always-pass stub.
      writeFileSync(join(root, "_t.py"), "assert True\n", "utf8");
      const check = await runGradedFixtureCheck(root, { authenticTest: authentic });
      expect(check?.ran).toBe(true);
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("real oracle still fails");
      // Disk must also carry the restored oracle, not the neutered stub.
      expect(readFileSync(join(root, "_t.py"), "utf8")).toBe(authentic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restores a deleted graded test when authenticTest is supplied", async () => {
    const authentic = "assert 2 + 2 == 4\n";
    const root = workspaceWith(authentic);
    try {
      unlinkSync(join(root, "_t.py"));
      expect(existsSync(join(root, "_t.py"))).toBe(false);
      const check = await runGradedFixtureCheck(root, { authenticTest: authentic });
      expect(check).not.toBeNull();
      expect(check?.ran).toBe(true);
      expect(check?.passed).toBe(true);
      expect(readFileSync(join(root, "_t.py"), "utf8")).toBe(authentic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without authenticTest, a neutered on-disk test is trusted (legacy unit path)", async () => {
    // Call sites that build their own workspace (these tests) may omit the
    // fixture source. Production rollouts always pass authenticTest.
    const root = workspaceWith("assert False\n");
    try {
      writeFileSync(join(root, "_t.py"), "assert True\n", "utf8");
      const check = await runGradedFixtureCheck(root);
      expect(check?.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
