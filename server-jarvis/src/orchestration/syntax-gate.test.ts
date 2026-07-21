import { describe, expect, test } from "bun:test";
import {
  checkWrittenFilesSyntax,
  renderSyntaxIssues,
  writtenCodePaths,
  type SyntaxChecker,
} from "./syntax-gate";
import type { ToolCallRecord } from "./stage-output";

function call(name: string, path: string, is_error = false): ToolCallRecord {
  return { id: name + path, name, arguments: { path }, output: "", is_error, duration_ms: 1 } as ToolCallRecord;
}

describe("writtenCodePaths", () => {
  test("extracts checkable paths from successful write tools, deduped", () => {
    const calls = [
      call("write_file", "a.py"),
      call("edit_file", "a.py"),        // dupe
      call("multi_edit", "b.py"),
      call("read_file", "c.py"),        // not a write tool
      call("write_file", "notes.txt"),  // unsupported ext
      call("write_file", "bad.py", true), // errored write
    ];
    expect(writtenCodePaths(calls).sort()).toEqual(["a.py", "b.py"]);
  });

  test("empty / undefined tool calls yield nothing", () => {
    expect(writtenCodePaths(undefined)).toEqual([]);
    expect(writtenCodePaths([])).toEqual([]);
  });
});

describe("checkWrittenFilesSyntax", () => {
  const okChecker: SyntaxChecker = async () => null;
  const failChecker: SyntaxChecker = async (p) => `SyntaxError in ${p}`;

  test("reports a confirmed syntax error on a written+existing file", async () => {
    const issues = await checkWrittenFilesSyntax([call("write_file", "broken.py")], {
      checkers: new Map([[".py", failChecker]]),
      exists: () => true,
    });
    expect(issues).toEqual([{ path: "broken.py", error: "SyntaxError in broken.py" }]);
  });

  test("skips files that do not exist on disk (no false failure)", async () => {
    const issues = await checkWrittenFilesSyntax([call("write_file", "gone.py")], {
      checkers: new Map([[".py", failChecker]]),
      exists: () => false,
    });
    expect(issues).toEqual([]);
  });

  test("fail-open: a checker returning null (valid / unavailable) yields no issue", async () => {
    const issues = await checkWrittenFilesSyntax([call("write_file", "ok.py")], {
      checkers: new Map([[".py", okChecker]]),
      exists: () => true,
    });
    expect(issues).toEqual([]);
  });

  test("only gates extensions with a registered checker", async () => {
    const issues = await checkWrittenFilesSyntax([call("write_file", "x.rs")], {
      checkers: new Map([[".py", failChecker]]),
      exists: () => true,
    });
    expect(issues).toEqual([]);
  });
});

describe("renderSyntaxIssues", () => {
  test("empty issues render nothing", () => {
    expect(renderSyntaxIssues([])).toBe("");
  });
  test("issues render a REJECT that names the file and demands a full rewrite", () => {
    const out = renderSyntaxIssues([{ path: "a.py", error: "SyntaxError: bad" }]);
    expect(out).toContain("REJECT");
    expect(out).toContain("a.py");
    expect(out).toContain("SyntaxError: bad");
    expect(out.toLowerCase()).toContain("rewrite the whole");
  });
});
