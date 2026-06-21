// ═══════════════════════════════════════════════════════════════
// ── Interactive Bundle ──
// ═══════════════════════════════════════════════════════════════
// Tools and session state for interactive chat flows. The text-protocol-only
// ask_user_question tool lets the model pause for clarification without being
// emitted to native function-calling APIs.

import type { ExecutionContext, ToolRuntime } from "./tool-runtime";
import type { ToolDefinition, ToolParameter } from "./tool-types";

interface QuestionInput {
  question: string;
  options?: string[];
  header?: string;
  multiSelect?: boolean;
}

export interface SessionInteractionState {
  session_id: string;
  state: Record<string, unknown> | null;
  updated_at: string;
}

const sessionStates = new Map<string, SessionInteractionState>();

function def(
  name: string,
  description: string,
  properties: Record<string, ToolParameter>,
  required: string[],
): ToolDefinition {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
    requires_approval: false,
    dangerous: false,
    text_protocol_only: true,
  };
}

const ASK_USER_QUESTION_DEF = def(
  "ask_user_question",
  "Ask the user a question and WAIT for their response. Use when you need clarification, confirmation, or a decision before proceeding. The conversation pauses until the user answers.",
  {
    questions: {
      type: "array",
      description: "Array of question objects, each with a 'question' string and optional fields",
      items: { type: "object", description: "Question object" },
    },
  },
  ["questions"],
);

function isQuestionArray(value: unknown): value is QuestionInput[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && typeof (item as QuestionInput).question === "string");
}

export function registerInteractiveBundle(runtime: ToolRuntime): void {
  runtime.register(ASK_USER_QUESTION_DEF, async (args, ctx) => {
    if (!ctx.interactive) {
      throw new Error("ask_user_question requires an interactive surface");
    }

    const questions = isQuestionArray(args.questions) ? args.questions : [];
    const sessionId = ctx.session_id ?? "anonymous";
    const state = {
      last_question: questions,
    };

    sessionStates.set(sessionId, {
      session_id: sessionId,
      state,
      updated_at: new Date().toISOString(),
    });

    return JSON.stringify({
      ok: true,
      session_id: sessionId,
      state: "awaiting_user_response",
      questions,
    });
  });
}

export function getSessionState(sessionId: string): SessionInteractionState | null {
  return sessionStates.get(sessionId) ?? null;
}

export function clearSessionState(sessionId: string): boolean {
  return sessionStates.delete(sessionId);
}
