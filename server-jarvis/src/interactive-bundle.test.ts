import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerInteractiveBundle, getSessionState, clearSessionState } from "./interactive-bundle";

const cfg = defaultConfig();

describe("InteractiveBundle", () => {
  test("registers ask_user_question as an interactive text-protocol-only tool", () => {
    const runtime = createToolRuntime();
    registerInteractiveBundle(runtime);

    const tools = runtime.listTools();
    const ask = tools.find((tool) => tool.function.name === "ask_user_question");

    expect(ask).toBeDefined();
    expect(ask?.text_protocol_only).toBe(true);
    expect(ask?.requires_approval).toBe(false);
    expect(ask?.dangerous).toBe(false);
  });

  test("ask_user_question stores session state and waits for the user", async () => {
    const runtime = createToolRuntime();
    registerInteractiveBundle(runtime);
    const sessionId = "session-interactive-bundle-test";
    const ctx = makeExecutionContext("chat", cfg, { session_id: sessionId });

    const result = await runtime.execute(
      {
        id: "ask-1",
        name: "ask_user_question",
        arguments: {
          questions: [{ question: "Which file should I edit?", options: ["src/index.ts", "src/config.ts"] }],
        },
      },
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toContain(sessionId);
    expect(getSessionState(sessionId)?.state).toEqual({
      last_question: [{ question: "Which file should I edit?", options: ["src/index.ts", "src/config.ts"] }],
    });
    expect(clearSessionState(sessionId)).toBe(true);
    expect(getSessionState(sessionId)).toBe(null);
  });

  test("ask_user_question is rejected on non-interactive surfaces", async () => {
    const runtime = createToolRuntime();
    registerInteractiveBundle(runtime);
    const ctx = makeExecutionContext("agent", cfg, { session_id: "agent-session" });

    const result = await runtime.execute(
      { id: "ask-2", name: "ask_user_question", arguments: { questions: [{ question: "Proceed?" }] } },
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.error).toContain("interactive surface");
  });
});
