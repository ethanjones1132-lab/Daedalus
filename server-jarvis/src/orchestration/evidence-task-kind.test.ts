// Pins for task-type-aware evidence (P2.2).
//
// The central risk of this change is that relaxing the evidence floor readmits
// fabrication. It does not: every added floor counts SUCCESSFUL result records
// only, so a turn that called nothing — or whose calls all failed — is still
// insufficient. Those are the first tests below, deliberately.

import { describe, expect, test } from "bun:test";
import { assessWorkspaceEvidence } from "./evidence-sufficiency";
import { deriveEvidenceTaskKind } from "./turn-requirements";
import type { ToolCallRecord } from "./stage-output";

function call(name: string, output = "content", is_error = false, args: Record<string, unknown> = {}): ToolCallRecord {
  return {
    id: `${name}-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
    output,
    is_error,
    duration_ms: 1,
  } as ToolCallRecord;
}

describe("research evidence floor", () => {
  test("a zero-tool research turn still fails (fabrication fence)", () => {
    const result = assessWorkspaceEvidence([], "research the X protocol", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
  });

  test("re-fetching one URL with different prompts is still a single source", () => {
    const result = assessWorkspaceEvidence(
      [
        call("web_fetch", "page content", false, { url: "https://a.example", prompt: "summarize" }),
        call("web_fetch", "page content", false, { url: "https://a.example", prompt: "extract dates" }),
        call("web_search", "results", false, { query: "x" }),
      ],
      "research X",
      undefined,
      {},
      "research",
    );
    expect(result.sufficient).toBe(false);
  });

  test("re-fetching one URL is a single source even with no search", () => {
    const result = assessWorkspaceEvidence(
      [
        call("web_fetch", "one", false, { url: "https://a.example" }),
        call("web_fetch", "one", false, { url: "https://a.example" }),
        call("web_fetch", "one", false, { url: "https://a.example" }),
      ],
      "research X",
      undefined,
      {},
      "research",
    );
    expect(result.sufficient).toBe(false);
  });

  test("distinct URLs keep their independent credit", () => {
    const result = assessWorkspaceEvidence(
      [
        call("web_fetch", "one", false, { url: "https://a.example" }),
        call("web_fetch", "two", false, { url: "https://b.example" }),
        call("web_search", "r", false, { query: "x" }),
      ],
      "research X",
      undefined,
      {},
      "research",
    );
    expect(result.sufficient).toBe(true);
  });

  test("mixed turn also cannot pass on repeated fetches of one URL", () => {
    const result = assessWorkspaceEvidence(
      [
        call("web_fetch", "one", false, { url: "https://a.example" }),
        call("web_fetch", "two", false, { url: "https://a.example", prompt: "different" }),
        call("web_search", "results", false, { query: "x" }),
      ],
      "research X and check the repo",
      undefined,
      {},
      "mixed",
    );
    expect(result.sufficient).toBe(false);
  });

  test("URL aliases and fragments do not create additional sources", () => {
    const calls = ["a.example", "https://A.EXAMPLE:443/", "https://a.example/#section"]
      .map((url) => call("web_fetch", "content", false, { url }));
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
    expect(result.contentReads).toBe(1);
  });

  test("distinct paths and query values on one host retain credit", () => {
    const calls = ["https://a.example/One", "https://a.example/one", "https://a.example/one?v=2"]
      .map((url) => call("web_fetch", "content", false, { url }));
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(true);
    expect(result.contentReads).toBe(3);
  });

  test("missing, malformed, and unsupported URLs earn no source credit", () => {
    const calls = [undefined, 42, "", "https://", "ftp://a.example"]
      .map((url) => call("web_fetch", "content", false, { url }));
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
    expect(result.contentReads).toBe(0);
  });

  test("empty and deflected fetches cannot supplement a successful source", () => {
    const calls = [
      call("web_fetch", "one", false, { url: "https://a.example" }),
      call("web_fetch", "  ", false, { url: "https://b.example" }),
      call("web_fetch", "[duplicate call deflected]", false, { url: "https://c.example" }),
      call("web_fetch", "failed", true, { url: "https://d.example" }),
      call("web_search", "results", false, { query: "x" }),
    ];
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
    expect(result.contentReads).toBe(1);
  });

  test("failed fetches earn no credit", () => {
    const calls = [
      call("web_fetch", "boom", true, { url: "https://a.example" }),
      call("web_fetch", "boom", true, { url: "https://b.example" }),
      call("web_search", "boom", true, { query: "x" }),
    ];
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
  });

  test("two fetches plus a search satisfies a research turn", () => {
    const calls = [
      call("web_search", "results", false, { query: "x" }),
      call("web_fetch", "article one", false, { url: "https://a.example" }),
      call("web_fetch", "article two", false, { url: "https://b.example" }),
    ];
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(true);
  });

  test("three fetches satisfy without any search", () => {
    const calls = [
      call("web_fetch", "one", false, { url: "https://a.example" }),
      call("web_fetch", "two", false, { url: "https://b.example" }),
      call("web_fetch", "three", false, { url: "https://c.example" }),
    ];
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(true);
  });

  test("a single fetch is not enough", () => {
    const calls = [call("web_fetch", "one", false, { url: "https://a.example" })];
    const result = assessWorkspaceEvidence(calls, "research X", undefined, {}, "research");
    expect(result.sufficient).toBe(false);
  });
});

describe("command evidence floor", () => {
  test("a successful shell result satisfies a command turn", () => {
    const result = assessWorkspaceEvidence([call("bash", "ok", false, { command: "bun test" })], "run the tests", undefined, {}, "command");
    expect(result.sufficient).toBe(true);
  });

  test("a failed shell result does not", () => {
    const result = assessWorkspaceEvidence([call("bash", "boom", true, { command: "bun test" })], "run the tests", undefined, {}, "command");
    expect(result.sufficient).toBe(false);
  });
});

describe("workspace floor is unchanged", () => {
  test("a workspace turn still requires a workspace read, not a fetch", () => {
    const calls = [
      call("web_fetch", "one", false, { url: "https://a.example" }),
      call("web_fetch", "two", false, { url: "https://b.example" }),
      call("web_search", "results", false, { query: "x" }),
    ];
    const result = assessWorkspaceEvidence(calls, "what is in this repo", undefined, {}, "workspace");
    expect(result.sufficient).toBe(false);
  });

  test("a single successful read still satisfies the shallow floor", () => {
    const result = assessWorkspaceEvidence([call("read_file", "contents", false, { path: "a.ts" })], "what is in a.ts", undefined, {}, "workspace");
    expect(result.sufficient).toBe(true);
  });

  test("workspace remains the default when no task kind is passed", () => {
    const calls = [
      call("web_fetch", "one", false, { url: "https://a.example" }),
      call("web_fetch", "two", false, { url: "https://b.example" }),
      call("web_search", "r", false, { query: "x" }),
    ];
    expect(assessWorkspaceEvidence(calls, "what is in this repo").sufficient).toBe(false);
  });
});

describe("mixed turns accept either kind of evidence", () => {
  test("network evidence satisfies a mixed turn", () => {
    const calls = [
      call("web_fetch", "one", false, { url: "https://a.example" }),
      call("web_fetch", "two", false, { url: "https://b.example" }),
      call("web_search", "r", false, { query: "x" }),
    ];
    expect(assessWorkspaceEvidence(calls, "research X and check the repo", undefined, {}, "mixed").sufficient).toBe(true);
  });

  test("a mixed turn with nothing at all still fails", () => {
    expect(assessWorkspaceEvidence([], "research X and check the repo", undefined, {}, "mixed").sufficient).toBe(false);
  });
});

describe("deriveEvidenceTaskKind", () => {
  test("classifies plain research", () => {
    expect(deriveEvidenceTaskKind("research the history of X and cite sources")).toBe("research");
  });

  test("classifies plain command", () => {
    expect(deriveEvidenceTaskKind("run the test suite")).toBe("command");
  });

  test("defaults to workspace", () => {
    expect(deriveEvidenceTaskKind("what does this function do")).toBe("workspace");
  });

  test("research plus a workspace signal is mixed", () => {
    expect(deriveEvidenceTaskKind("research X then update src/foo.ts")).toBe("mixed");
  });
});
