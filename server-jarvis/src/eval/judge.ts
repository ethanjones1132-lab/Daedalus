// server-jarvis/src/eval/judge.ts
// ═══════════════════════════════════════════════════════════════
// LLM-judge: scores a live model answer against a rubric of required
// facts/behaviors. Deliberately NOT exact-string matching (live model
// output varies) — asks a judge model which rubric items are covered.
// ═══════════════════════════════════════════════════════════════

import type { CallModelFn } from "../orchestration/coordinator";

export type JudgeVerdictError = "invalid_verdict" | "unparseable";

export type JudgeVerdict =
  | {
      valid: true;
      score: number;
      covered: string[];
      missed: string[];
      rationale: string;
      error?: undefined;
    }
  | {
      valid: false;
      error: JudgeVerdictError;
      score: 0;
      covered: [];
      missed: string[];
      rationale: string;
    };

function buildJudgePrompt(request: string, answer: string, rubric: string[]): string {
  return [
    "You are grading an AI assistant's answer against a rubric of required facts or behaviors.",
    "Respond with ONLY a single JSON object of the shape:",
    `{"covered": ["<rubric item text>", ...], "missed": ["<rubric item text>", ...]}`,
    "Every rubric item must appear in exactly one of the two arrays. No other text.",
    "Copy each rubric item's text byte-for-byte/verbatim from the list below — do not paraphrase, reword, or reformat it.",
    "",
    `User request:\n${request}`,
    "",
    `Assistant answer:\n${answer}`,
    "",
    `Rubric items (must each be classified as covered or missed):\n${rubric.map((r) => `- ${r}`).join("\n")}`,
  ].join("\n");
}

function extractJudgeJson(text: string): { covered: string[]; missed: string[] } | null {
  try {
    return JSON.parse(text.trim());
  } catch {}
  // Judge models often wrap their JSON in prose or markdown code fences despite
  // being told not to. Fall back to extracting the outermost `{...}` span and
  // parsing that instead of giving up on the whole response.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function invalidVerdict(
  rubric: string[],
  error: JudgeVerdictError,
  detail: string,
): JudgeVerdict {
  return {
    valid: false,
    error,
    score: 0,
    covered: [],
    missed: [...rubric],
    rationale: `Judge output invalid: ${detail}`,
  };
}

function findPartitionConflict(
  rubric: string[],
  covered: unknown[],
  missed: unknown[],
): string | null {
  const rubricSet = new Set(rubric);
  if (rubricSet.size !== rubric.length) return "rubric contains duplicate items";

  const seen = new Map<string, "covered" | "missed">();
  for (const [partition, values] of [["covered", covered], ["missed", missed]] as const) {
    for (const value of values) {
      if (typeof value !== "string" || !rubricSet.has(value)) continue;
      const previous = seen.get(value);
      if (previous) return `rubric item "${value}" appears in ${previous} and ${partition}`;
      seen.set(value, partition);
    }
  }
  return null;
}

export async function judgeAnswer(
  callModel: CallModelFn,
  request: string,
  answer: string,
  rubric: string[],
): Promise<JudgeVerdict> {
  if (rubric.length === 0) {
    return { valid: true, score: 1, covered: [], missed: [], rationale: "Empty rubric — vacuous pass." };
  }

  const resp = await callModel([
    { role: "system", content: "You are a strict, literal grading judge. Output only JSON." },
    { role: "user", content: buildJudgePrompt(request, answer, rubric) },
  ], { temperature: 0, max_tokens: 500 });

  const parsed = extractJudgeJson(resp.content);
  if (!parsed || !Array.isArray(parsed.covered) || !Array.isArray(parsed.missed)) {
    return invalidVerdict(
      rubric,
      "unparseable",
      `unparseable: ${resp.content.slice(0, 200)}`,
    );
  }

  const conflict = findPartitionConflict(rubric, parsed.covered, parsed.missed);
  if (conflict) return invalidVerdict(rubric, "invalid_verdict", conflict);

  const rubricSet = new Set(rubric);
  const covered = parsed.covered.filter(
    (item: unknown): item is string => typeof item === "string" && rubricSet.has(item),
  );
  const missed = rubric.filter((item) => !covered.includes(item));
  return {
    valid: true,
    score: Math.min(1, covered.length / rubric.length),
    covered,
    missed,
    rationale: `${covered.length}/${rubric.length} rubric items covered.`,
  };
}
