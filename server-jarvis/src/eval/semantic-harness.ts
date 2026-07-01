// server-jarvis/src/eval/semantic-harness.ts
// ═══════════════════════════════════════════════════════════════
// LIVE semantic eval runner. Requires real API keys in the loaded config
// and `JARVIS_EVAL_LIVE=1` — NOT part of `bun test` (costs money, is
// non-deterministic). Run manually or on a schedule:
//   JARVIS_EVAL_LIVE=1 bun run src/eval/semantic-harness.ts
//   JARVIS_EVAL_LIVE=1 bun run src/eval/semantic-harness.ts --write-baseline
//
// `makeCallModel` mirrors production's native-vs-text tool-calling branch
// (see index.ts's `modelSupportsNativeTools` resolution): it resolves the
// pool agent for the requested stage via `AgentPool.pickFor`, and if that
// agent's provider/model doesn't support native function calling (OpenCode
// Zen/Go, or an OpenRouter model `isOpenRouterModelSupportsTools` rejects),
// it injects the text tool-call protocol instructions and recovers any
// attempted tool calls via `extractTextToolCalls` instead of reading
// `choices[0].message.tool_calls`. This closes a previously-flagged gap
// where cheap/free models using the text protocol were scored as if they
// never attempted a tool call — eval results now reflect real production
// tool-use behavior for both protocol types.
// ═══════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { loadConfig, type JarvisConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { Coordinator } from "../orchestration/coordinator";
import { PipelineExecutor } from "../orchestration/pipeline";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import { normalizeRoute } from "../orchestration/route-normalization";
import { chatCompletionWithFallback, isOpenRouterModelSupportsTools } from "../openrouter";
import { buildTextToolInstructions, extractTextToolCalls } from "../text-tools";
import { AgentPool } from "../orchestration/agent-pool";
import { judgeAnswer } from "./judge";
import { SEMANTIC_CASES, type SemanticCase } from "./semantic-cases";
import type { CallModelFn, ChatMessage } from "../orchestration/coordinator";
import type { ToolDefinition } from "../tool-types";

export interface SemanticCaseResult {
  id: string;
  score: number;
  covered: string[];
  missed: string[];
  answer: string;
}

export interface SemanticReport {
  total: number;
  averageScore: number;
  results: SemanticCaseResult[];
}

function materializeFixture(root: string, fixture: Record<string, string> | undefined): void {
  if (!fixture) return;
  for (const [relPath, content] of Object.entries(fixture)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

/**
 * Determine whether the agent the pool would actually pick for `stage`
 * supports native OpenAI-style function calling. Mirrors index.ts's
 * `modelSupportsNativeTools` resolution (minus the Ollama branch, which the
 * eval harness never exercises): opencode_zen/opencode_go are hardcoded to
 * the text-tool protocol; everything else defers to
 * `isOpenRouterModelSupportsTools`. Falls back to `true` (native) when the
 * pool can't resolve an agent for the stage, matching the fallback cascade's
 * own behavior of defaulting to plain OpenRouter in that case.
 */
function resolveModelSupportsNativeTools(cfg: JarvisConfig, stage: string): boolean {
  const pool = new AgentPool(cfg.orchestrator?.agents ?? []);
  const agent = pool.pickFor(stage, "general");
  if (!agent) return true;
  if (agent.provider === "opencode_zen" || agent.provider === "opencode_go") return false;
  return isOpenRouterModelSupportsTools(agent.model_id);
}

// KNOWN LIMITATION: this only resolves the PRIMARY cascade candidate's protocol,
// before the request is made. If `chatCompletionWithFallback` internally falls
// back to a differently-protocoled secondary/tertiary candidate mid-request
// (e.g. on a 429/503/timeout from the primary), the harness still parses that
// response using the primary's protocol decision — so a tool call made via the
// *other* protocol on that fallback hop could be missed. This is accepted as a
// low-probability edge case (only triggers when the primary candidate actually
// fails live) whose impact is already bounded by the regression-band gating
// (diffSemanticBaseline) this harness uses to tolerate live-model noise; it is
// not silently worked around. A real fix would require either propagating the
// actually-used model/provider back from chatCompletionWithFallback, or
// re-deriving the protocol choice post-hoc from the response.

/** Inject the text tool-call protocol instructions into the system message,
 *  matching index.ts's `useTextTools` system-prompt augmentation. */
function withTextToolInstructions(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
  const textInstructions = buildTextToolInstructions(tools);
  const effectiveMessages = [...messages];
  const sysIdx = effectiveMessages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    effectiveMessages[sysIdx] = {
      ...effectiveMessages[sysIdx],
      content: `${effectiveMessages[sysIdx].content}\n\n${textInstructions}`,
    };
  } else {
    effectiveMessages.unshift({ role: "system", content: textInstructions });
  }
  return effectiveMessages;
}

/** Minimal callModel that goes through the real fallback cascade for a fixed stage.
 *  Mirrors production's native-vs-text tool-calling branch (index.ts): resolve
 *  which agent the pool would pick for `stage`, and if it doesn't support
 *  native function calling, use the text tool-call protocol instead of the
 *  `tools` request field so cheap/free models are scored on their real
 *  tool-use behavior rather than being silently marked as tool-call-less. */
function makeCallModel(cfg: JarvisConfig, stage: string): CallModelFn {
  return async (messages, options) => {
    const tools: ToolDefinition[] = options?.tools ?? [];
    const useTextTools = tools.length > 0 && !resolveModelSupportsNativeTools(cfg, stage);
    const effectiveMessages = useTextTools ? withTextToolInstructions(messages, tools) : messages;

    const { response } = await chatCompletionWithFallback(cfg, {
      messages: effectiveMessages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.max_tokens ?? 1024,
      stream: false,
      tools: useTextTools ? undefined : options?.tools,
    }, undefined, { stage });
    const json = await response.json();
    const choice = json.choices?.[0]?.message ?? {};
    const content: string = choice.content ?? "";

    if (useTextTools) {
      const extracted = extractTextToolCalls(content, tools);
      const tool_calls = extracted.calls.length > 0
        ? extracted.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
        : undefined;
      return { content: extracted.cleanedText, tool_calls };
    }

    return { content, tool_calls: choice.tool_calls };
  };
}

async function runSemanticCase(cfg: JarvisConfig, c: SemanticCase): Promise<SemanticCaseResult> {
  const workspace = mkdtempSync(join(tmpdir(), "jarvis-semantic-eval-"));
  try {
    materializeFixture(workspace, c.workspaceFixture);

    const callModel = makeCallModel(cfg, "orchestrator");
    const coordinator = new Coordinator(callModel);
    const route = await coordinator.route(c.request, { sessionId: `semantic-${c.id}` });
    const turnReq = classifyTurnRequirements(c.request);
    const normalized = normalizeRoute(route, turnReq.requirement, turnReq.requirement === "conversational" ? "trivial_short_circuit" : "model");

    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", cfg, {
      session_id: `semantic-${c.id}`,
      workspace_path: workspace,
    });
    const executor = new PipelineExecutor(callModel, runtime, ctx, { recordStageRun: () => {} });

    const result = await executor.execute(c.request, normalized.pipeline, `semantic_${c.id}`, () => {}, {
      topology: normalized.topology,
      executionProfile: normalized.profile,
    });

    const judgeModel = makeCallModel(cfg, "reviewer"); // reuse the pool's strongest reasoning default as judge
    const verdict = await judgeAnswer(judgeModel, c.request, result.answer, c.rubric);

    return { id: c.id, score: verdict.score, covered: verdict.covered, missed: verdict.missed, answer: result.answer };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runSemanticEval(cfg: JarvisConfig): Promise<SemanticReport> {
  const results: SemanticCaseResult[] = [];
  for (const c of SEMANTIC_CASES) {
    results.push(await runSemanticCase(cfg, c));
  }
  const averageScore = results.reduce((sum, r) => sum + r.score, 0) / Math.max(1, results.length);
  return { total: results.length, averageScore, results };
}

export interface SemanticBaseline {
  version: number;
  averageScore: number;
  scores: Record<string, number>;
}

export function toSemanticBaseline(report: SemanticReport): SemanticBaseline {
  const scores: Record<string, number> = {};
  for (const r of report.results) scores[r.id] = r.score;
  return { version: 1, averageScore: report.averageScore, scores };
}

// A live model is non-deterministic — only fail on a real regression, not noise.
const REGRESSION_DROP_THRESHOLD = 0.15;
const REGRESSION_ABSOLUTE_FLOOR = 0.6;

export function diffSemanticBaseline(report: SemanticReport, baseline: SemanticBaseline): string[] {
  const diffs: string[] = [];
  for (const [id, prevScore] of Object.entries(baseline.scores)) {
    const now = report.results.find((r) => r.id === id);
    if (!now) {
      diffs.push(`case removed: ${id}`);
      continue;
    }
    if (now.score < prevScore - REGRESSION_DROP_THRESHOLD && now.score < REGRESSION_ABSOLUTE_FLOOR) {
      diffs.push(`case ${id}: score dropped ${prevScore.toFixed(2)} -> ${now.score.toFixed(2)} (missed: ${now.missed.join(", ")})`);
    }
  }
  return diffs;
}

if (import.meta.main) {
  if (process.env.JARVIS_EVAL_LIVE !== "1") {
    console.error("Refusing to run: this hits live model APIs and costs money. Set JARVIS_EVAL_LIVE=1 to proceed.");
    process.exit(1);
  }
  const cfg = loadConfig();
  const report = await runSemanticEval(cfg);
  const baselinePath = join(import.meta.dir, "semantic-baseline.json");

  for (const r of report.results) {
    console.log(`${r.score >= REGRESSION_ABSOLUTE_FLOOR ? "OK  " : "LOW "} ${r.id}  score=${r.score.toFixed(2)}${r.missed.length ? `  missed=[${r.missed.join(", ")}]` : ""}`);
  }
  console.log(`\nAverage score: ${report.averageScore.toFixed(3)} across ${report.total} cases`);

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(toSemanticBaseline(report), null, 2) + "\n");
    console.log(`Wrote semantic baseline to ${baselinePath}`);
  } else {
    try {
      const { readFileSync } = await import("fs");
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as SemanticBaseline;
      const drift = diffSemanticBaseline(report, baseline);
      if (drift.length) {
        console.log("\nSemantic regressions detected:");
        for (const d of drift) console.log(`  - ${d}`);
        process.exit(1);
      }
    } catch (e) {
      console.log(`\n(no baseline yet — run with --write-baseline to create one: ${e})`);
    }
  }
}
