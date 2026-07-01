// server-jarvis/src/eval/judge.ts
// ═══════════════════════════════════════════════════════════════
// LLM-judge: scores a live model answer against a rubric of required
// facts/behaviors. Deliberately NOT exact-string matching (live model
// output varies) — asks a judge model which rubric items are covered.
// ═══════════════════════════════════════════════════════════════

import type { CallModelFn } from "../orchestration/coordinator";

export interface JudgeVerdict {
  score: number; // covered.length / rubric.length, in [0, 1]
  covered: string[];
  missed: string[];
  rationale: string;
}

function buildJudgePrompt(request: string, answer: string, rubric: string[]): string {
  return [
    "You are grading an AI assistant's answer against a rubric of required facts or behaviors.",
    "Respond with ONLY a single JSON object of the shape:",
    `{"covered": ["<rubric item text>", ...], "missed": ["<rubric item text>", ...]}`,
    "Every rubric item must appear in exactly one of the two arrays. No other text.",
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
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
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
    return { score: 1, covered: [], missed: [], rationale: "Empty rubric — vacuous pass." };
  }

  const resp = await callModel([
    { role: "system", content: "You are a strict, literal grading judge. Output only JSON." },
    { role: "user", content: buildJudgePrompt(request, answer, rubric) },
  ], { temperature: 0, max_tokens: 500 });

  const parsed = extractJudgeJson(resp.content);
  if (!parsed || !Array.isArray(parsed.covered) || !Array.isArray(parsed.missed)) {
    return { score: 0, covered: [], missed: rubric, rationale: `Judge output unparseable: ${resp.content.slice(0, 200)}` };
  }

  const covered = parsed.covered.filter((item) => rubric.includes(item));
  const missed = rubric.filter((item) => !covered.includes(item));
  return {
    score: covered.length / rubric.length,
    covered,
    missed,
    rationale: `${covered.length}/${rubric.length} rubric items covered.`,
  };
}
