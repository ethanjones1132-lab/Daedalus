import { describe, expect, test } from "bun:test";
import {
  DEEP_READ_MIN_CONTENT_READS,
  assessWorkspaceEvidence,
  evidenceFailure,
  isDeepReadRequest,
  turnNeedsWorkspaceEvidence,
} from "./evidence-sufficiency";
import { hasWorkspaceSignal } from "./turn-requirements";
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
  output: "src/c.ts:1: // TODO: refactor",
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

describe("turnNeedsWorkspaceEvidence", () => {
  test("hasWorkspaceSignal recognizes exported path and workspace signals", () => {
    expect(hasWorkspaceSignal("audit src/orchestration/pipeline.ts")).toBe(true);
    expect(hasWorkspaceSignal("summarize this repo")).toBe(true);
    expect(hasWorkspaceSignal("what is a JSON file?")).toBe(false);
  });

  test("workspace_read always requires workspace evidence", () => {
    expect(turnNeedsWorkspaceEvidence("workspace_read", "what version is in package.json?")).toBe(true);
    expect(turnNeedsWorkspaceEvidence("workspace_read", "thanks")).toBe(true);
  });

  test("full_execution research requires evidence when deep-read or workspace-scoped but not write intent", () => {
    expect(turnNeedsWorkspaceEvidence("full_execution", "comprehensively audit this repo without modifying files")).toBe(true);
    expect(turnNeedsWorkspaceEvidence("full_execution", "create an architecture report for src/index.ts, no edits")).toBe(true);
  });

  test("full_execution write turns and non-workspace answer turns do not use workspace evidence fences", () => {
    expect(turnNeedsWorkspaceEvidence("full_execution", "write src/index.ts")).toBe(false);
    expect(turnNeedsWorkspaceEvidence("full_execution", "write me a poem")).toBe(false);
    expect(turnNeedsWorkspaceEvidence("answer_only", "explain event loops")).toBe(false);
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
      [ls, read("a.ts"), read("b.ts"), read("c.ts")],
      "comprehensively diagnose this repo",
    );
    expect(a.sufficient).toBe(true);
    expect(a.deepRead).toBe(true);
    expect(a.contentReads).toBe(3);
    expect(a.reason).toContain("deep read satisfied");
  });

  test("grep counts as a content read for a deep read, but git_metadata never does", () => {
    // 2026-07-13 live-benchmark finding: a deep-read turn against a
    // fixture with exactly one real file satisfied the old floor via
    // read_file(1) + git_metadata(2) — git_metadata reveals nothing about
    // file contents and must never count toward "comprehensively
    // diagnosed" evidence, only toward a shallow git-status turn.
    const a = assessWorkspaceEvidence(
      [ls, read("a.ts"), read("b.ts"), grep, gitMetadata],
      "comprehensively diagnose the whole repository",
    );
    expect(a.contentReads).toBe(3); // read_file(a.ts) + read_file(b.ts) + grep(c.ts); git_metadata excluded
    expect(a.sufficient).toBe(true);
  });

  test("repeated grep patterns against one source file do not inflate the deep-read count", () => {
    const sameFile = (pattern: string): ToolCallRecord => ({
      name: "grep",
      arguments: { pattern, path: "src" },
      output: "src/a.ts:1: matching line",
      is_error: false,
      duration_ms: 8,
    });
    const a = assessWorkspaceEvidence(
      [sameFile("TODO"), sameFile("const"), sameFile("export")],
      "comprehensively audit this repo",
    );
    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(1);
  });

  test("git_metadata calls alone never satisfy the deep-read floor, however many times repeated", () => {
    const a = assessWorkspaceEvidence(
      [ls, read("a.ts"), gitMetadata, gitMetadata, gitMetadata],
      "comprehensively diagnose the architecture of this repo",
    );
    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(1); // only the one real read_file counts
  });

  test("re-reading the same file repeatedly does not inflate the deep-read count", () => {
    const a = assessWorkspaceEvidence(
      [ls, read("payload.ts"), read("payload.ts"), read("payload.ts")],
      "comprehensively diagnose the architecture of the repo",
    );
    expect(a.sufficient).toBe(false); // 3 calls, but only 1 DISTINCT target
    expect(a.contentReads).toBe(1);
  });

  test("path aliases for one source file do not inflate the deep-read count", () => {
    const a = assessWorkspaceEvidence(
      [read("src/a.ts"), read("./src/../src/a.ts"), read("C:/repo/src/a.ts")],
      "comprehensively diagnose the architecture of this repo",
      "C:/repo",
    );
    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(1);
  });

  test("grep output relative to its directory shares the read_file target", () => {
    const a = assessWorkspaceEvidence(
      [
        read("src/a.ts"),
        {
          name: "grep",
          arguments: { pattern: "TODO", path: "src" },
          output: "a.ts:1: matching line",
          is_error: false,
          duration_ms: 8,
        },
        read("src/b.ts"),
      ],
      "comprehensively diagnose the architecture of this repo",
      "C:/repo",
    );
    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(2);
  });

  test("workspace-root normalization does not collapse same-suffix files from another root", () => {
    const a = assessWorkspaceEvidence(
      [read("C:/repo/src/a.ts"), read("D:/other/src/a.ts"), read("C:/repo/src/b.ts")],
      "comprehensively diagnose the architecture of this repo",
      "C:/repo",
    );
    expect(a.sufficient).toBe(true);
    expect(a.contentReads).toBe(3);
  });

  test("manifests and overview files do not satisfy the deep-read source floor", () => {
    const a = assessWorkspaceEvidence(
      [
        read("package.json"),
        read("README.md"),
        read("tsconfig.json"),
        read("OVERVIEW.md"),
        read("docs/ARCHITECTURE_OVERVIEW.md"),
        read("docs/system-overview.md"),
        read("AGENTS.md"),
        read("CLAUDE.md"),
        read("ARCHITECTURE.md"),
      ],
      "comprehensively diagnose this repo",
    );

    expect(a.sufficient).toBe(false);
    expect(a.contentReads).toBe(0);
  });

  test("git_metadata alone still satisfies a shallow request (the git/SHA preflight case)", () => {
    const a = assessWorkspaceEvidence([gitMetadata], "what's the current git sha?");
    expect(a.sufficient).toBe(true);
    expect(a.deepRead).toBe(false);
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
