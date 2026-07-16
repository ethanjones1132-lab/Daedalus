import { describe, test, expect } from "bun:test";
import {
  classifyTurnRequirements,
  hasWriteIntent,
  inheritRequirementForContinuation,
  shouldRememberRequirement,
  shouldShortCircuitCoordinator,
} from "./turn-requirements";

describe("shouldRememberRequirement", () => {
  test("substantive turns update memory", () => {
    expect(shouldRememberRequirement(false)).toBe(true);
  });

  test("short-circuited trivial turns do not update memory", () => {
    expect(shouldRememberRequirement(true)).toBe(false);
  });
});

describe("hasWriteIntent", () => {
  test("does not treat the incident's plan request as a file mutation", () => {
    expect(hasWriteIntent(
      "Identify all remaining gaps in C:\\Projects\\Versutus, create a comprehensive implementation plan for the repo, and do not modify files.",
    )).toBe(false);
  });

  test.each([
    ["create a comprehensive implementation plan. Do not modify files.", false],
    ["create a plan and save it to docs/plan.md", true],
    ["create a plan file for the migration", true],
    ["write a report on the architecture", false],
    ["fix the crash in auth.ts", true],
    ["update README.md", true],
    ["read CONTEXT.md and summarize", false],
    ["without modifying files, create src/new.ts", true],
  ])("classifies %s as write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Abstract-deliverable short-circuit (the morning commit's headline) ──
  // The narrow contract: a pure abstract deliverable (plan, report, summary,
  // analysis, etc.) without a concrete target is NOT a write. The function
  // is deliberately narrower than classifyTurnRequirements — the orchestrator
  // may still route the turn through a full-capability pipeline, but the
  // rewriter is not invoked because there is no file mutation to repair.
  test.each([
    ["create a plan", false],
    ["write a report", false],
    ["implement an analysis", false],
  ])("abstract deliverable without concrete target: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Compound phrases ARE writes (the morning commit's override) ──
  // "plan file", "report document", "summary document", etc. — any abstract
  // deliverable word immediately followed by a concrete-target word
  // (file|document|doc|path) — is a write. The compound phrase is the
  // authoritative override of the abstract-deliverable short-circuit.
  test.each([
    ["create a plan file", true],
    ["write a report document", true],
    ["create a plan file for the migration", true],
    ["write a report document on the architecture", true],
    ["create a summary document for the API", true],
    ["create an analysis document", true],
    ["write a proposal document", true],
    ["write a roadmap document", true],
    ["create an assessment document", true],
    ["write an overview document", true],
    ["create a recommendation document", true],
    ["write a strategy document", true],
    ["create an outline document", true],
    ["write a write-up document", true],
  ])("compound abstract + concrete: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Negation gating (the day-saving bug class) ──
  // "Without modifying files, create X" — if X is abstract-only, the negation
  // is honored and the turn is NOT a write. If X is a compound (plan file),
  // the compound wins because the user explicitly named a file artifact.
  test.each([
    ["Without modifying files, create a plan", false],
    ["Do not edit anything. Create a plan for the redesign.", false],
    ["Without modifying files, create a plan file", true],
    ["Do not edit anything. Write a report document.", true],
  ])("negation + abstract deliverable: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Mixed clauses: contrast marker breaks the negation scope ──
  // When the user writes "Do not edit X, but create Y" / "however, create Y" /
  // "yet create Y" — the second clause is governed by the contrast marker
  // (not the negation) and the unnegated mutation fires.
  test.each([
    ["Do not edit README.md, but create CHANGELOG.md.", true],
    ["Do not edit README.md, however, create CHANGELOG.md.", true],
    ["Do not edit README.md, yet create CHANGELOG.md.", true],
  ])("contrast marker: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Path-only references without a mutation verb → NOT a write ──
  // "read C:\foo" is a read intent even though a path is present. The
  // explicit-write-intent gate is intentional: a path is workspace evidence
  // for the classifier, but only an unnegated mutation verb unlocks the
  // rewriter.
  test.each([
    ["read C:\\Projects\\notes.md", false],
    ["summarize C:\\src\\server.ts", false],
    ["look at /usr/local/etc/app.conf", false],
  ])("path-only reference: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Tool-call exemplar masking ──
  // Pasted tool JSON in a read-intent frame must be masked before the
  // mutation detection runs, so a "analyze this read_file call" turn does
  // not turn into a write just because the JSON contains a path.
  test.each([
    [
      'Analyze only; do not run: {"name":"read_file","arguments":{"path":"C:\\Projects\\demo\\README.md"}}',
      false,
    ],
    [
      'Just inspect this tool call: {"name":"create","arguments":{"path":"src/new.ts"}}',
      false,
    ],
    [
      'Look at this: <tool_call>{"name":"write","arguments":{"path":"foo.ts"}}</tool_call>',
      false,
    ],
  ])("tool-call exemplar masking: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Negative surface (regression guard) ──
  // Pin the non-write surface so a future regression that broadens mutation
  // detection (e.g. adding "consider" or "produce" to MUTATION_VERB by
  // mistake) is caught here, not in production.
  test.each([
    ["hi", false],
    ["thanks!", false],
    ["what is the capital of France?", false],
    ["summarize this repository", false],
    ["audit the code", false],
    ["check the file", false],
  ])("non-write intent: %s → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Edge cases: empty / whitespace ──
  test.each([
    ["", false],
    ["   ", false],
    ["\n\n\t  ", false],
  ])("empty/whitespace: %j → write=%s", (message, expected) => {
    expect(hasWriteIntent(message)).toBe(expected);
  });

  // ── Quoted Windows path with mutation verb (still detects via path) ──
  test("quoted path with fix + add verbs → write", () => {
    expect(hasWriteIntent('fix "C:\\src\\x.ts" to add a header')).toBe(true);
  });
});

describe("inheritRequirementForContinuation", () => {
  test("inherits a higher-authority prior requirement on continuation", () => {
    const current = { requirement: "answer_only" as const, signals: ["default_answer_only"] };
    expect(inheritRequirementForContinuation(current, "full_execution", true)).toEqual({
      requirement: "full_execution",
      signals: ["default_answer_only", "continuation_inherit:full_execution"],
    });
  });

  test("never lowers the current requirement", () => {
    const current = { requirement: "full_execution" as const, signals: ["mutation_verb"] };
    expect(inheritRequirementForContinuation(current, "workspace_read", true)).toBe(current);
  });

  test("is a no-op when the turn is not a continuation", () => {
    const current = { requirement: "answer_only" as const, signals: ["default_answer_only"] };
    expect(inheritRequirementForContinuation(current, "full_execution", false)).toBe(current);
    expect(inheritRequirementForContinuation(current, undefined, true)).toBe(current);
  });
});

describe("shouldShortCircuitCoordinator", () => {
  test("bypasses coordinator for conversational and simple direct-answer turns", () => {
    expect(shouldShortCircuitCoordinator(
      "thanks!",
      classifyTurnRequirements("thanks!"),
      false,
    )).toBe(true);
    expect(shouldShortCircuitCoordinator(
      "What is the capital of France?",
      classifyTurnRequirements("What is the capital of France?"),
      false,
    )).toBe(true);
  });

  test("keeps coordinator for complex reasoning, continuations, and workspace authority", () => {
    const complex = "Compare Raft and Paxos across failure semantics, operational tradeoffs, and recovery behavior.";
    expect(shouldShortCircuitCoordinator(complex, classifyTurnRequirements(complex), false)).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "continue",
      classifyTurnRequirements("continue"),
      true,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "summarize this repository",
      classifyTurnRequirements("summarize this repository"),
      false,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "fix src/index.ts",
      classifyTurnRequirements("fix src/index.ts"),
      false,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "begin phase 1",
      classifyTurnRequirements("begin phase 1"),
      false,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "start phase 2",
      classifyTurnRequirements("start phase 2"),
      false,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "resume step 2",
      classifyTurnRequirements("resume step 2"),
      false,
    )).toBe(false);
    expect(shouldShortCircuitCoordinator(
      "proceed with the plan",
      classifyTurnRequirements("proceed with the plan"),
      false,
    )).toBe(false);
  });
});

describe("classifyTurnRequirements", () => {
  test("greetings and acknowledgements are conversational", () => {
    for (const s of ["hey buddy, how are you?", "hello", "thanks!", "good morning", "ok cool"]) {
      expect(classifyTurnRequirements(s).requirement).toBe("conversational");
    }
  });

  test("quoted Windows path → workspace_read", () => {
    const r = classifyTurnRequirements('can you read this file for me? "C:\\Projects\\notes.md"');
    expect(r.requirement).toBe("workspace_read");
  });

  test("unquoted Windows drive path → workspace_read", () => {
    expect(classifyTurnRequirements("tell me about C:\\Projects\\Versutus").requirement).toBe("workspace_read");
  });

  test("UNC path → workspace_read", () => {
    expect(classifyTurnRequirements("open \\\\server\\share\\config.ini").requirement).toBe("workspace_read");
  });

  test("POSIX absolute path → workspace_read", () => {
    expect(classifyTurnRequirements("show /usr/local/etc/app.conf").requirement).toBe("workspace_read");
  });

  test("relative dotted path → workspace_read", () => {
    expect(classifyTurnRequirements("inspect ./src/index.ts").requirement).toBe("workspace_read");
  });

  test("multi-segment relative path → workspace_read", () => {
    expect(classifyTurnRequirements("what is in app/components/Bar.tsx").requirement).toBe("workspace_read");
  });

  test("bare filename with code extension → workspace_read", () => {
    expect(classifyTurnRequirements("read package.json").requirement).toBe("workspace_read");
  });

  test("read verb + workspace noun (no path) → workspace_read", () => {
    expect(classifyTurnRequirements("summarize the codebase").requirement).toBe("workspace_read");
    expect(classifyTurnRequirements("give me a two-sentence summary of this repo").requirement).toBe("workspace_read");
    expect(classifyTurnRequirements("read the contents of this folder and tell me about it").requirement).toBe("workspace_read");
  });

  test("directory read request → workspace_read", () => {
    expect(classifyTurnRequirements("list the files in this directory").requirement).toBe("workspace_read");
  });

  test("definitional question with the word 'file' stays answer_only", () => {
    // "a JSON file" is not a workspace reference — must NOT trigger executor.
    expect(classifyTurnRequirements("Explain what a JSON file is").requirement).toBe("answer_only");
  });

  test("general knowledge question is answer_only", () => {
    expect(classifyTurnRequirements("what is the capital of France?").requirement).toBe("answer_only");
    expect(classifyTurnRequirements("explain how TCP congestion control works").requirement).toBe("answer_only");
  });

  test("explicit mutation verbs → full_execution (even with a path)", () => {
    expect(classifyTurnRequirements("fix the bug in C:\\src\\app.ts").requirement).toBe("full_execution");
    expect(classifyTurnRequirements("add unit tests").requirement).toBe("full_execution");
    expect(classifyTurnRequirements("refactor the orchestrator pipeline").requirement).toBe("full_execution");
    expect(classifyTurnRequirements("delete the temp directory").requirement).toBe("full_execution");
  });

  test("execute-to-completion language grants the write-capable profile", () => {
    const result = classifyTurnRequirements(
      "Read the core files of this application, get a plan together first then execute it to completion",
    );
    expect(result.requirement).toBe("full_execution");
    expect(result.signals).toContain("mutation_verb");
  });

  test.each([
    ["begin phase 1"],
    ["start phase 2"],
    ["resume step 2"],
    ["proceed with the plan"],
  ])("work-start command: %s → full_execution with work_start_command", (message) => {
    const result = classifyTurnRequirements(message);
    expect(result.requirement).toBe("full_execution");
    expect(result.signals).toContain("work_start_command");
  });

  test("mutation takes precedence over read on a path", () => {
    // "edit C:\x.ts" must be full_execution, not workspace_read.
    const r = classifyTurnRequirements('edit "C:\\src\\x.ts" to add a header');
    expect(r.requirement).toBe("full_execution");
  });

  test("negated mutation verbs keep explicit workspace probes read-only", () => {
    for (const message of [
      "Do not modify any files; read README.md and report what it says.",
      "Don't edit or delete anything. Inspect this repo only.",
      "Never run commands; just review src/app.ts.",
      "Don\u2019t update anything; inspect package.json.",
      "Inspect this codebase without modifying files.",
      "Review this repository without writing files.",
      "No modifications, edits, or changes; summarize the repository.",
    ]) {
      const result = classifyTurnRequirements(message);
      expect(result.requirement).toBe("workspace_read");
      expect(result.signals).toContain("negated_mutation");
      expect(result.signals).not.toContain("mutation_verb");
    }
  });

  test("negated mutation without workspace cues stays answer_only", () => {
    const result = classifyTurnRequirements("Do not run anything; explain TCP congestion control.");
    expect(result.requirement).toBe("answer_only");
    expect(result.signals).toContain("negated_mutation");
  });

  test("an unnegated mutation still wins when another mutation is negated", () => {
    const result = classifyTurnRequirements("Do not edit README.md, but create CHANGELOG.md.");
    expect(result.requirement).toBe("full_execution");
    expect(result.signals).toContain("negated_mutation");
    expect(result.signals).toContain("mutation_verb");
  });

  test("pasted tool JSON analyzed as an exemplar does not become workspace intent", () => {
    const result = classifyTurnRequirements(
      'Analyze only; do not run: {"name":"read_file","arguments":{"path":"C:\\Projects\\demo\\README.md"}}',
    );
    expect(result.requirement).toBe("answer_only");
    expect(result.signals).toContain("tool_call_exemplar");
    expect(result.signals.some((signal) => signal.startsWith("path:"))).toBe(false);
  });

  test("intent outside pasted tool JSON still controls authority", () => {
    const exemplar = '{"name":"read_file","arguments":{"path":"C:\\Projects\\demo\\README.md"}}';
    expect(classifyTurnRequirements(`Read the file described by this exemplar: ${exemplar}`).requirement)
      .toBe("workspace_read");
    expect(classifyTurnRequirements(`Run this exact tool call: ${exemplar}`).requirement)
      .toBe("full_execution");
  });

  test("classifies the raw message — history is the caller's responsibility", () => {
    // The classifier only sees what it is given; a follow-up greeting passed
    // alone is conversational even if a prior turn read files.
    expect(classifyTurnRequirements("thanks, that's perfect!").requirement).toBe("conversational");
  });

  test("work-start commands stay unaffected by unrelated answer-only language", () => {
    expect(classifyTurnRequirements("beginners guide to rust").requirement).toBe("answer_only");
    expect(classifyTurnRequirements("phase transitions in physics").requirement).toBe("answer_only");
  });
});
