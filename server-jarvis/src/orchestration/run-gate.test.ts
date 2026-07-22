import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findRunnableTarget, isTestFile, runWrittenCodeGate } from "./run-gate";
import type { ToolCallRecord } from "./stage-output";

function writeCall(path: string): ToolCallRecord {
  return {
    name: "write_file",
    arguments: { path, content: "" },
    output: "Wrote",
    is_error: false,
    duration_ms: 1,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-run-gate-test-"));
}

describe("isTestFile", () => {
  test("recognizes the codebase's own _t naming convention plus test_/_test", () => {
    const shouldMatch = [
      "_t.py",
      "_t2.py",
      "solution_t.py",
      "test_foo.py",
      "foo_test.py",
      "my_test.py",
    ];
    for (const name of shouldMatch) {
      expect(isTestFile(name)).toBe(true);
    }
  });

  test("rejects non-test files, including ones that merely contain the substring _t", () => {
    const shouldNotMatch = [
      "solution.py",
      "calc.py",
      "rules.py",
      "config_store.py",
      "session.py",
      "tokens.py",
      "process_runner.py",
      // These plausible module names contain "_t" as a substring but are not
      // test files — the fixed regex must not false-positive on them.
      "_temp.py",
      "output_transform.py",
      "data_target.py",
      "session_token.py",
      "_tools.py",
    ];
    for (const name of shouldNotMatch) {
      expect(isTestFile(name)).toBe(false);
    }
  });

  test("matches against the basename only, ignoring directory components", () => {
    expect(isTestFile(join("some", "nested", "dir", "_t.py"))).toBe(true);
    expect(isTestFile(join("test", "solution.py"))).toBe(false);
  });
});

describe("run gate target selection", () => {
  test("prefers a test explicitly named by the request", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "src.py"), "print('src')\n");
      writeFileSync(join(root, "named_test.py"), "print('test')\n");
      const target = await findRunnableTarget(
        [writeCall("src.py")],
        "Implement src.py and run named_test.py",
        "Plan: validate with named_test.py",
        { root },
      );
      expect(target?.path).toBe(join(root, "named_test.py"));
      expect(target?.reason).toBe("explicit_test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects _t.py named explicitly, matching this codebase's own test-oracle convention", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "solution.py"), "print('solution')\n");
      writeFileSync(join(root, "_t.py"), "print('oracle')\n");
      const target = await findRunnableTarget(
        [writeCall("solution.py")],
        "Implement solution.py and verify with _t.py",
        "",
        { root },
      );
      expect(target?.path).toBe(join(root, "_t.py"));
      expect(target?.reason).toBe("explicit_test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not select an unrelated, non-test, unwritten file merely mentioned in the request", async () => {
    // Regression case: "settings.py" is mentioned in the request text (as
    // context, not as a run target), is not a test by naming convention, and
    // is not among the files written this turn. It must be rejected by
    // Priority A so Priority B can find the real adjacent test instead of the
    // gate running an arbitrary, unrelated config module.
    const root = tempRoot();
    try {
      writeFileSync(join(root, "app.py"), "print('app')\n");
      writeFileSync(join(root, "settings.py"), "DEBUG = True\n");
      writeFileSync(join(root, "test_app.py"), "print('test')\n");
      const target = await findRunnableTarget(
        [writeCall("app.py")],
        "Update app.py per the config values defined in settings.py",
        "",
        { root },
      );
      expect(target?.path).toBe(join(root, "test_app.py"));
      expect(target?.reason).toBe("adjacent_test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not let the edited file's own name masquerade as an explicit test target", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "app.py"), "print('app')\n");
      writeFileSync(join(root, "test_app.py"), "print('test')\n");
      // Only the edited file is mentioned in the request/plan text — it must
      // not be picked up by the Priority-A fallback, or the adjacent
      // conventional test (Priority B) would never get a chance to run.
      const target = await findRunnableTarget(
        [writeCall("app.py")],
        "Please update app.py to fix the bug",
        "",
        { root },
      );
      expect(target?.path).toBe(join(root, "test_app.py"));
      expect(target?.reason).toBe("adjacent_test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses an adjacent test before treating the written script as runnable", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "app.py"), "print('app')\n");
      writeFileSync(join(root, "test_app.py"), "print('test')\n");
      const target = await findRunnableTarget([writeCall("app.py")], "update app.py", "", { root });
      expect(target?.path).toBe(join(root, "test_app.py"));
      expect(target?.reason).toBe("adjacent_test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to a written standalone script with a main guard", async () => {
    const root = tempRoot();
    try {
      const script = "if __name__ == '__main__':\n    print('ok')\n";
      writeFileSync(join(root, "script.py"), script);
      const target = await findRunnableTarget([writeCall("script.py")], "update script.py", "", { root });
      expect(target?.path).toBe(join(root, "script.py"));
      expect(target?.reason).toBe("standalone_script");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run gate execution", () => {
  test("runs the selected target with direct argv and reports success", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "test_app.py"), "print('run gate passed')\n");
      const result = await runWrittenCodeGate([writeCall("app.py")], "update app.py", "", { root });
      expect(result.status).toBe("passed");
      expect(result.target).toBe(join(root, "test_app.py"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("turns a nonzero Python run into a deterministic repair issue", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "test_app.py"), "raise RuntimeError('broken')\n");
      const result = await runWrittenCodeGate([writeCall("app.py")], "update app.py", "", { root });
      expect(result.status).toBe("failed");
      expect(result.issues[0]?.path).toBe(join(root, "test_app.py"));
      expect(result.issues[0]?.error).toContain("RuntimeError");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
