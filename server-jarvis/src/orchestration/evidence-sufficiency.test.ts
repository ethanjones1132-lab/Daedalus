import { describe, expect, test } from "bun:test";
import {
  DEEP_READ_MIN_CONTENT_READS,
  assessWorkspaceEvidence,
  evidenceFailure,
  isDeepReadRequest,
} from "./evidence-sufficiency";
import type { ToolCallRecord } from "./stage-output";

const ls: ToolCallRecord = {
  name: "list_directory",
  arguments: { path: "C:\\repo" },
  output: "src/\npackage.json",
  is_error: false,
  duration_ms: 10,
};
const read = (p: string): ToolCallRecord => ({
  name: "read_file",
  arguments: { path: p },
  output: "{...contents...}",
  is_error: false,
  duration_ms: 12,
});
const grep: ToolCallRecord = {
  name: "grep",
  arguments: { pattern: "TODO", path: "." },
  output: "src/a.ts:1: // TODO: refactor",
  is_error: false,
  duration_ms: 8,
};
const gitMetadata: ToolCallRecord = {
  name: "git_metadata",
  arguments: { include: ["head", "branch", "dirty"] },
  output: "head=abc123",
  is_error: false,
  duration_ms: 6,
};
const failedRead: ToolCallRecord = {
  name: "read_file",
  arguments: { path: "C:\\repo\\src" },
  output: "EISDIR: is a directory",
  is_error: true,
  error_code: "is_a_directory",
  duration_ms: 5,
};

describe("isDeepReadRequest", () => {
  test("repo-level diagnosis requests are deep reads", () => {
    expect(
      isDeepReadRequest(
        "Read the contents of this repo and comprehensively diagnose the gaps in architecture",
      ),
    ).toBe(true);
  });

  test("comprehensive/thorough/audit markers trigger deep-read mode", () => {
    expect(isDeepReadRequest("Do a thorough audit of the codebase")).toBe(true);
    expect(isDeepReadRequest("Diagnose the whole repository end-to-end")).toBe(true);
  });

  test("shallow file-pointed requests are not deep reads", () => {
    expect(isDeepReadRequest("what does src/index.ts export?")).toBe(false);
    expect(isDeepReadRequest("what version is in package.json?")).toBe(false);
    // "Show me the full path to the README" — 'full' is in the plan's marker
    // set (intentionally; a request that says 'full' about a file path is
    // usually asking the model to load the whole thing). The plan source
    // of truth is docs/superpowers/plans/2026-07-12-comprehensive-performance-improvement.md
    // Phase 2 Task 2.1 — pinning 'full' as a deep-read marker is the plan's
    // choice and would only be a false positive if 'full' appears with the
    // narrow meaning 'show me the full file path', which is rare enough
    // that the depth-scaled sufficiency (3 content reads) is the right
    // trade-off — it would still pass a single read_file + 1 listing.
    expect(isDeepReadRequest("Show me the full path to the README")).toBe(true);
  });

  test("a request that mentions 'repo' is treated as a deep read by design", () => {
    // The 2026-07-12 incident was a "comprehensively diagnose this repo"
    // turn, so the plan's marker set intentionally includes 'repo' and
    // 'repository'. A 'list the files in <dir>' request that happens to
    // mention 'repo' will be classified as deep — that is by design and
    // is the bug class the depth-scaled sufficiency exists to catch.
    expect(isDeepReadRequest("list the files in C:\\repo")).toBe(true);
  });
});

describe("assessWorkspaceEvidence", () => {
  test("a lone list_directory is insufficient for a deep read", () => {
    const a = assessWorkspaceEvidence(
      [ls],
      "Read the contents of this repo and comprehensively diagnose it",
    );
    expect(a.sufficient).toBe(false);
    expect(a.deepRead).toBe(true);
    expect(a.contentReads).toBe(0);
    expect(a.listings).toBe(1);
    expect(a.reason).toContain("list_directory");
  });

  test("listing plus three file reads is sufficient for a deep read", () => {
    const a = assessWorkspaceEvidence(
      [ls, read("a.ts"), read("b.ts"), read("c.json")],
      "comprehensively diagnose this repo",
    );
    expect(a.sufficient).toBe(true);
    expect(a.deepRead).toBe(true);
    expect(a.contentReads).toBe(3);
    expect(a.reason).toContain("deep read satisfied");
  });

  test("grep and git_metadata count as content reads for a deep read", () => {
    const a = assessWorkspaceEvidence(
      [ls, read("a.ts"), grep, gitMetadata],
      "comprehensively diagnose the whole repository",
    );
    expect(a.sufficient).toBe(true);
    expect(a.contentReads).toBe(3);
  });

  test("the deep-read threshold is exactly DEEP_READ_MIN_CONTENT_READS", () => {
    const calls = [ls, read("a.ts"), read("b.ts")];
    const boundary = assessWorkspaceEvidence(
      calls,
      "comprehensively diagnose this repo",
    );
    expect(boundary.sufficient).toBe(false);
    expect(boundary.contentReads).toBe(DEEP_READ_MIN_CONTENT_READS - 1);
  });

  test("failed reads do not count toward the deep-read threshold", () => {
    const a = assessWorkspaceEvidence(
      [ls, failedRead, read("a.ts")],
      "comprehensively diagnose this repo",
    );
    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(1);
  });

  test("a shallow request is satisfied by one successful read", () => {
    const a = assessWorkspaceEvidence(
      [read("package.json")],
      "what version is in package.json?",
    );
    expect(a.sufficient).toBe(true);
    expect(a.deepRead).toBe(false);
    expect(a.reason).toBe("shallow read satisfied");
  });

  test("a shallow request is still satisfied by one list_directory (unchanged behavior)", () => {
    const a = assessWorkspaceEvidence([ls], "what's in the current directory?");
    expect(a.sufficient).toBe(true);
    expect(a.deepRead).toBe(false);
  });

  test("a shallow request with zero successful tool calls is not sufficient", () => {
    const a = assessWorkspaceEvidence([], "what version is in package.json?");
    expect(a.sufficient).toBe(false);
    expect(a.reason).toBe("no successful workspace tool result");
  });

  test("a deep read with zero tool calls returns the deep-read reason", () => {
    const a = assessWorkspaceEvidence([], "comprehensively diagnose this repo");
    expect(a.sufficient).toBe(false);
    expect(a.deepRead).toBe(true);
    expect(a.reason).toContain(`>=${DEEP_READ_MIN_CONTENT_READS}`);
  });
});

describe("evidenceFailure", () => {
  test("zero evidence yields missing_workspace_evidence", () => {
    const failure = evidenceFailure(assessWorkspaceEvidence([], "comprehensively diagnose this repo"));
    expect(failure.code).toBe("missing_workspace_evidence");
    expect(failure.message).toContain("no successful workspace read");
  });

  test("partial evidence on a deep read yields insufficient_workspace_evidence with actionable guidance", () => {
    const listing = {
      name: "list_directory",
      arguments: { path: "C:/repo" },
      output: "src/",
      is_error: false,
      duration_ms: 5,
    };
    const failure = evidenceFailure(assessWorkspaceEvidence([listing], "comprehensively diagnose this repo"));
    expect(failure.code).toBe("insufficient_workspace_evidence");
    expect(failure.message).toContain("force deep read");
  });

  test("failure messages never script the user's next message verbatim", () => {
    for (const assessment of [
      assessWorkspaceEvidence([], "audit the codebase"),
      assessWorkspaceEvidence(
        [{ name: "glob", arguments: { pattern: "*" }, output: "a.ts", is_error: false, duration_ms: 1 }],
        "audit the codebase",
      ),
    ]) {
      const failure = evidenceFailure(assessment);
      expect(failure.message.toLowerCase()).not.toContain("ask me to");
      expect(failure.message.toLowerCase()).not.toContain("re-send");
    }
  });
});
