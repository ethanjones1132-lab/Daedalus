import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findRunnableTarget, runWrittenCodeGate } from "./run-gate";
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
