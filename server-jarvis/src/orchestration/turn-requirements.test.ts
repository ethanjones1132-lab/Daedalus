import { describe, test, expect } from "bun:test";
import {
  classifyTurnRequirements,
  hasWriteIntent,
  inheritRequirementForContinuation,
  resolveTurnRequirement,
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

  test("explicit deep-read escape hatch and read_file instructions stay read-only", () => {
    expect(classifyTurnRequirements("force deep read").requirement).toBe("workspace_read");
    expect(classifyTurnRequirements(
      "Perform Phase 1 deep reads by executing read_file on the six files listed above.",
    ).requirement).toBe("workspace_read");
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

// ── 2026-07-17 live incident (runs 02:57Z–03:02Z): inflected mutation verbs ──
// "Begin implementing phase 1" classified answer_only because MUTATION_VERB
// only matched base verb forms — the turn short-circuited to a tool-less
// synthesizer, which fabricated a completion claim with fake diffs.
describe("inflected mutation language (2026-07-17 write-path incident)", () => {
  test.each([
    ["Begin implementing phase 1"],
    ["start implementing the plan now"],
    ["continue fixing the smoothing code"],
    ["keep adding the missing tests"],
    ["Actually implement Phase 1 – Write the missing smoothing code to PluginProcessor.h and PluginProcessor.cpp"],
  ])("gerund/inflected mutation → full_execution: %s", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });

  test("work items after an implement verb carry write intent", () => {
    expect(hasWriteIntent("Begin implementing phase 1")).toBe(true);
    expect(hasWriteIntent("implement task 3")).toBe(true);
    expect(hasWriteIntent(
      "Actually implement Phase 1 – Write the missing smoothing code to PluginProcessor.h and PluginProcessor.cpp",
    )).toBe(true);
  });

  test("deep-read escape hatch still beats an inflected execute verb", () => {
    expect(classifyTurnRequirements(
      "Perform Phase 1 deep reads by executing read_file on the six files listed above.",
    ).requirement).toBe("workspace_read");
  });

  test("negated gerunds stay non-mutating", () => {
    const result = classifyTurnRequirements("Review this repository without writing files.");
    expect(result.requirement).toBe("workspace_read");
    expect(result.signals).not.toContain("mutation_verb");
  });

  test("noun-like verb forms in status questions stay non-write", () => {
    expect(classifyTurnRequirements("is the server running?").requirement).toBe("answer_only");
    expect(classifyTurnRequirements("what are the latest changes?").requirement).toBe("answer_only");
    expect(hasWriteIntent("what are the latest changes?")).toBe(false);
  });

  test("verification follow-ups classify as read work, not conversation", () => {
    expect(classifyTurnRequirements("verify the implementation in src/app.ts").requirement)
      .toBe("workspace_read");
  });
});

// ── 2026-07-18 live incident (runs 04:43Z–04:53Z): "apply" and sticky authority ──
// "Apply the Phase 1 smoothing changes to PluginProcessor.h and
// PluginProcessor.cpp" routed READ-ONLY (no verb match, "changes" not a
// target), and "Please apply the edits oh my goodness" went to a tool-less
// synthesizer. Mid-task work orders must inherit the task's authority.
describe("apply-verbs and sticky task authority (2026-07-18 incident)", () => {
  test.each([
    ["Apply the Phase 1 smoothing changes to PluginProcessor.h and PluginProcessor.cpp"],
    ["Please apply the edits oh my goodness"],
    ["apply the patch to src/main.rs"],
    ["ship the fix"],
    ["wire up the new handler in router.ts"],
  ])("apply/ship/wire phrasing → full_execution: %s", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });

  test("mutation-artifact nouns count as concrete write targets", () => {
    expect(hasWriteIntent("Apply the Phase 1 smoothing changes to PluginProcessor.h and PluginProcessor.cpp")).toBe(true);
    expect(hasWriteIntent("Please apply the edits oh my goodness")).toBe(true);
  });

  test("noun-form status questions still carry no authority", () => {
    expect(classifyTurnRequirements("what are the latest changes?").requirement).toBe("answer_only");
    expect(hasWriteIntent("what are the latest changes?")).toBe(false);
  });

  test("active full-execution task: short work orders inherit full authority", () => {
    for (const message of ["re-execute", "polish it up", "Please apply the edits oh my goodness"]) {
      const resolved = resolveTurnRequirement(message, "full_execution", true);
      expect(resolved.continuation).toBe(true);
      expect(resolved.result.requirement).toBe("full_execution");
    }
  });

  test("active task: questions and pleasantries do NOT inherit", () => {
    const question = resolveTurnRequirement("what does the smoothing actually do?", "full_execution", true);
    expect(question.continuation).toBe(false);
    expect(question.result.requirement).toBe("answer_only");

    const thanks = resolveTurnRequirement("thanks!", "full_execution", true);
    expect(thanks.result.requirement).toBe("conversational");
  });

  test("no active task: work-order inheritance is off", () => {
    // "polish it up" carries no classifiable authority of its own; without a
    // live task run it stays answer_only — a casual remark after finished
    // work cannot summon a full pipeline.
    const resolved = resolveTurnRequirement("polish it up", "full_execution", false);
    expect(resolved.continuation).toBe(false);
    expect(resolved.result.requirement).toBe("answer_only");
  });
});

// ── 2026-07-18 23:23 live incident: commencement verbs over mutation NOUNS ──
// "begin complete and total implementation of phase 1" (23:23) and "Now
// complete phase 2 please" (23:42) both classified answer_only — "implementation"
// is a noun the MUTATION_VERB list can never match, and "complete" was in no
// verb list at all. Both short-circuited to a tool-less synthesizer-only
// route; the first streamed a fully fabricated "## Changes Made" report with
// invented diffs (zero tool calls), the second asked the user for Phase 2
// requirements that were sitting in the plan file written one turn earlier.
describe("work commencement over mutation nouns (2026-07-18 23:23 incident)", () => {
  test.each([
    ["begin complete and total implementation of phase 1"],
    ["Now complete phase 2 please"],
    ["start the implementation"],
    ["finish the migration"],
    ["wrap up phase 3"],
    ["proceed with the rollout"],
    ["complete the remaining tasks"],
    ["alright, let's now complete phase 2"],
  ])("commencement + work noun → full_execution: %s", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });

  test("polite modal requests to complete work are executive", () => {
    expect(classifyTurnRequirements("can you complete phase 2?").requirement).toBe("full_execution");
  });

  test("status questions about completed work stay non-executive", () => {
    expect(classifyTurnRequirements("is the implementation complete?").requirement).toBe("answer_only");
    expect(classifyTurnRequirements("did you complete the phase?").requirement).toBe("answer_only");
  });

  test("negated commencement grants no authority", () => {
    expect(classifyTurnRequirements("don't start the implementation yet").requirement)
      .not.toBe("full_execution");
  });

  test("the live phrases can never short-circuit the coordinator", () => {
    for (const message of [
      "begin complete and total implementation of phase 1",
      "Now complete phase 2 please",
    ]) {
      const result = classifyTurnRequirements(message);
      expect(shouldShortCircuitCoordinator(message, result, false)).toBe(false);
    }
  });

  test("commencement work orders arm write intent (effect gate)", () => {
    expect(hasWriteIntent("begin complete and total implementation of phase 1")).toBe(true);
    expect(hasWriteIntent("Now complete phase 2 please")).toBe(true);
  });

  test("commencing an abstract deliverable is not write intent", () => {
    // "complete the plan" asks for the plan text to be finished — an answer
    // artifact, not a file mutation; the effect gate must not demand writes.
    expect(hasWriteIntent("complete the plan")).toBe(false);
  });

  test("aux-governed 'start' in failure reports is not a commencement", () => {
    // Diagnostic phrasing must not read as a work order.
    expect(classifyTurnRequirements("why does the app fail to start the sync task?").requirement)
      .not.toBe("full_execution");
  });
});

// ── 2026-07-26 live incident (session c5f1a360, run_247d1cf1): ──
// The `MUTATION_ARTIFACT_ORDER` rule (generic verb + mutation-artifact noun)
// is the new layer that fired for "Retry, implement the fixes this time" and
// for the read→write escalation that the continuation branch failed to arm.
// The incident-20260726-write-refusal.test.ts file pins the verbatim session
// turns; this block broadens the contract pin to the full rule shape so a
// future "tighten the regex" can't silently lose the new coverage.
//
// One regression found while writing this pin: "make all the remaining fixes"
// and "do all the fixes" did NOT match the original
//   \b(?:make|...|apply)\s+(?:the|...|all)?\s*(?:remaining|...)?\s*(?:fix|...)\b
// because the optional groups each match only a SINGLE word. The fix lifts
// the article group to `(?:(?:the|...|all)\s+){0,2}` so up to TWO article
// words can sit between the verb and the modifier (e.g. "all the", "the
// remaining", or simply "the"). All cases below assume that fix.
describe("MUTATION_ARTIFACT_ORDER — generic verb + mutation artifact (2026-07-26 rule)", () => {
  test.each([
    // Singular objects.
    "make the fix",
    "do the edit",
    "handle the change",
    "perform the modification",
    "finish the patch",
    "complete the change",
    "land the fix",
    "ship the patch",
    "apply the fix",
    // Plural objects.
    "make the fixes",
    "do the edits",
    "handle the changes",
    "perform the modifications",
    "finish the patches",
    "complete the changes",
    "land the fixes",
    "ship the patches",
    "apply the fixes",
    "apply the changes",
    // The incident's exact phrase.
    "implement the fixes",
    "implement the changes",
    // With one modifier.
    "make the remaining fixes",
    "do the necessary edits",
    "handle the outstanding changes",
    "perform the required modifications",
    "finish the pending changes",
    "complete the proposed edits",
    "land the suggested fix",
    "ship the discussed changes",
    "apply the above patches",
    // With two article words (the regression that motivated the fix).
    "make all the remaining fixes",
    "do all the fixes",
    "make all the changes",
    "do all the edits",
    "apply all the above patches",
    "ship all the pending changes",
    // Different article words.
    "do those remaining edits",
    "make those changes",
    "apply these fixes",
    "handle your modifications",
  ])("%p is write intent", (message) => {
    expect(hasWriteIntent(message)).toBe(true);
  });

  test.each([
    // Conversational / interrogative framing — the rule must NOT fire.
    "what are the changes?",
    "what were the fixes you made?",
    "explain the fixes in this file",
    "review the patches",
    "summarize the modifications",
    "show me the patches",
    // The "MUTATION_ARTIFACT_ORDER" object list is exactly {fix|edit|change|
    // modification|patch}. Abstract deliverables + other artifact nouns must
    // remain in their own gates.
    "make a plan",
    "make a report",
    "make a summary",
    "make the analysis",
    "make the outline",
    "make the report",
    "complete the assessment",
    "do the recommendation",
    "perform the overview",
    "ship the proposal",
    "apply the strategy",
    "complete the write-up",
    "ship the documentation",
    "land the proposal",
    // Generic verbs without an artifact object must not gain authority.
    "do you think this is right?",
    "do you agree?",
    "make sure it works",
    // Compound turns with a leading read/inspection frame still defer to
    // their own classification.
    "summarize the changes without editing anything",
    "read the implementation plan please",
  ])("%p is NOT write intent", (message) => {
    expect(hasWriteIntent(message)).toBe(false);
  });

  test.each([
    "don't make the fixes",
    "do not make the fixes",
    "don't apply the edits",
    "do not ship the patches",
    "do not do the changes",
    "don't make the changes",
    "never make the fixes",
    "without making the fixes",
    "DO NOT make the fixes",
    "Don't make any changes",
    "don't apply the fixes yet",
    "without applying the fixes",
  ])("negated mutation-artifact order is read-only: %p", (message) => {
    expect(hasWriteIntent(message)).toBe(false);
  });

  // The `MUTATION_ARTIFACT_ORDER` rule arms `hasWriteIntent` (the effect-gate
  // contract) but does NOT raise the requirement on its own — that is a
  // separate decision owned by MUTATION_VERB, WORK_START_COMMAND, and
  // findWorkCommencement. The three groups below pin the split:
  //   (a) `make/handle/land/do the/...` (verbs ONLY in
  //       MUTATION_ARTIFACT_ORDER) → writeIntent=true, requirement=answer_only.
  //       The effect gate arms, but the pipeline is not auto-promoted to
  //       full_execution.
  //   (b) `apply/implement/edit/...` (verbs in MUTATION_VERB too) →
  //       writeIntent=true, requirement=full_execution. MUTATION_VERB
  //       promotes the requirement; MUTATION_ARTIFACT_ORDER (or the
  //       concrete-target check) arms write intent.
  //   (c) `do all the fixes` (also fires WORK_START_COMMAND) →
  //       full_execution via the anchored work-start shortcut. The
  //       artifact rule still contributes to write intent; the
  //       WORK_START_COMMAND path drives the requirement.
  test.each([
    "make the remaining fixes",
    "handle the pending changes",
  ])("(a) artifact-only verb → writeIntent=true, requirement=answer_only: %p", (message) => {
    expect(hasWriteIntent(message)).toBe(true);
    expect(classifyTurnRequirements(message).requirement).toBe("answer_only");
  });

  test.each([
    "implement the remaining fixes",
    "apply the remaining patches",
    "fix the remaining issue",          // singular `issue` IS in CONCRETE_WRITE_TARGET
    "fix the bug",                       // singular `bug` IS in CONCRETE_WRITE_TARGET
    "land the necessary patches",        // `land` is in MUTATION_VERB
  ])("(b) MUTATION_VERB + artifact → full_execution + writeIntent=true: %p", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
    expect(hasWriteIntent(message)).toBe(true);
  });

  test("(c) work-start command with artifact noun → full_execution + writeIntent=true", () => {
    // `do all the fixes` matches WORK_START_COMMAND ("do the" + count noun +
    // artifact), not MUTATION_VERB. The artifact rule also fires.
    expect(hasWriteIntent("do all the fixes")).toBe(true);
    expect(classifyTurnRequirements("do all the fixes").requirement).toBe("full_execution");
  });

  // KNOWN GAP (documented, not fixed in this pass): the older
  // CONCRETE_WRITE_TARGET list accepts `issue`/`bug`/`crash`/`doc`/`config`/
  // `directory`/`file` but not their plurals (`issues`/`bugs`/`crashes`/
  // `docs`/`configs`/`directories`/`files`). The 2026-07-26 fix widened
  // `fix(?:es)?` and added the MUTATION_ARTIFACT_ORDER list (which handles
  // the most common plural phrasings), but did not retro-fit the older
  // list. The cases below are the residual gap: a user who says
  // "fix the bugs" / "fix the crashes" / "fix the docs" / "fix the
  // issues" / "fix the configs" / "fix the directories" / "edit the
  // necessary files" gets writeIntent=false because neither the older
  // CONCRETE_WRITE_TARGET nor the new MUTATION_ARTIFACT_ORDER matches
  // the plural target. Surfaced here so a future pass can decide whether
  // to widen the older list (`s?` on each noun) or accept the gap.
  test.each([
    "fix the bugs",
    "fix the issues",
    "fix the crashes",
    "fix the docs",
    "fix the configs",
    "fix the directories",
    "edit the necessary files",
  ])("KNOWN GAP: plural non-artifact targets carry no write intent: %p", (message) => {
    expect(hasWriteIntent(message)).toBe(false);
  });
});

describe("retrospective questions are not execution orders", () => {
  test.each([
    "what was your reasoning for implementing 1.6 first before 1.1",
    "what did you change",
    "why did you do 1.6 before 1.1",
    "how did you implement the smoothing",
    "which files did you edit",
    "what have you completed so far",
  ])("%p does not classify as full_execution", (message) => {
    expect(classifyTurnRequirements(message).requirement).not.toBe("full_execution");
  });

  test.each([
    "Begin full execution of phase 1",
    "implement the fixes",
    "fix the bug in PluginProcessor.cpp",
    "what needs fixing? then fix it",
  ])("%p is still an execution order", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });

  test.each([
    "why is the build failing, please fix it",
    "what is the plan, implement it now",
    "how is the module structured, refactor it to be cleaner",
  ])("%p (comma-joined order) is still an execution order", (message) => {
    expect(classifyTurnRequirements(message).requirement).toBe("full_execution");
  });
});
