import { describe, test, expect } from "bun:test";
import { classifyTurnRequirements } from "./turn-requirements";

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
});
