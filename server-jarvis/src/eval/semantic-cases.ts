// server-jarvis/src/eval/semantic-cases.ts
// ═══════════════════════════════════════════════════════════════
// Golden tasks for the LIVE semantic eval track (semantic-harness.ts).
// Unlike eval/cases.ts (deterministic, mocked), these run through the
// REAL orchestrator against REAL models and are graded by judge.ts.
// Keep this list small (5-10 cases) — every run costs real API calls.
// ═══════════════════════════════════════════════════════════════

import type { TaskType } from "../orchestration/coordinator";

export interface SemanticCase {
  id: string;
  task_type: TaskType;
  request: string;
  /** Facts/behaviors the final answer MUST include to be graded correct. */
  rubric: string[];
  /** Relative-path -> file content. Materialized into a temp workspace before the turn runs. */
  workspaceFixture?: Record<string, string>;
}

export const SEMANTIC_CASES: SemanticCase[] = [
  {
    id: "semantic/read-named-file",
    task_type: "general",
    request: "What does config.ts export? Read the file and tell me.",
    rubric: [
      "names the exported identifier(s) from config.ts",
      "does not claim the file couldn't be read",
    ],
    workspaceFixture: {
      "config.ts": "export const MAX_RETRIES = 3;\nexport function resolveTimeout(ms: number) { return Math.max(1000, ms); }\n",
    },
  },
  {
    id: "semantic/summarize-two-files",
    task_type: "docs",
    request: "Give me a one-paragraph summary of what this small project does, based on the files here.",
    rubric: [
      "mentions the greet function or greeting behavior",
      "mentions the add/sum function or arithmetic behavior",
      "does not invent a framework or language that isn't present",
    ],
    workspaceFixture: {
      "greet.ts": "export function greet(name: string) { return `Hello, ${name}!`; }\n",
      "math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    },
  },
  {
    id: "semantic/plain-knowledge-question",
    task_type: "general",
    request: "In one sentence, what is the difference between TCP and UDP?",
    rubric: [
      "mentions TCP is connection-oriented or reliable",
      "mentions UDP is connectionless or unreliable/faster",
    ],
  },
  {
    id: "semantic/debug-from-error-text",
    task_type: "debug",
    request: "This throws `TypeError: Cannot read properties of undefined (reading 'name')` in user.ts — what's the likely cause and fix?",
    rubric: [
      "identifies that something is undefined/null before .name is accessed",
      "suggests a guard, optional chaining, or ensuring the value is defined",
    ],
    workspaceFixture: {
      "user.ts": "function printName(user) {\n  console.log(user.name);\n}\nprintName(getUser());\nfunction getUser() { return undefined; }\n",
    },
  },
  {
    id: "semantic/trivial-greeting",
    task_type: "general",
    request: "hey, how's it going?",
    rubric: [
      "responds conversationally without pretending to inspect a workspace",
    ],
  },
];
