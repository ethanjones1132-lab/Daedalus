import { countTokens } from "../tokens";
import type { ToolCallRecord } from "./stage-output";
import type { TurnRequirement } from "./turn-requirements";

export const HISTORY_BUDGET_TOKENS: Record<TurnRequirement, number> = {
  conversational: 0,
  answer_only: 1_200,
  workspace_read: 2_000,
  full_execution: 2_400,
};

export const EXECUTOR_TOOL_RESULT_CONTEXT_CHARS = 6_000;
export const EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS = 3_000;
export const REWRITER_TOOL_RESULT_CONTEXT_CHARS = 4_000;
// Network results (web_fetch/web_search) carry the evidence for research turns,
// where the readable article is the whole point. The 5,000-char strip that
// web_fetch used truncated mid-article on any real page; this budget admits a
// full extracted article while staying well under the write-turn cap.
export const NETWORK_TOOL_RESULT_CONTEXT_CHARS = 12_000;
export const EXECUTOR_TRANSCRIPT_BUDGET_TOKENS = 12_000;
export const REWRITER_TRANSCRIPT_BUDGET_TOKENS = 8_000;

// ── Write-turn visibility (2026-07-18) ───────────────────────────────────────
// A model cannot compose a correct edit_file old_string for code it never
// saw: the live incident file (PluginProcessor.cpp) is 22,335 chars while the
// 6,000-char read cap showed the executor barely a quarter of it, making
// every real implementation task structurally impossible regardless of
// routing or nudges. Write turns therefore run with a per-result cap that
// admits real source files whole, and a transcript budget sized to hold two
// such files plus the working conversation. Read-only turns keep the tight
// caps — summarization does not need byte-exact visibility.
export const WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS = 24_000;
export const WRITE_TURN_TRANSCRIPT_BUDGET_TOKENS = 24_000;

/**
 * Per-result context cap for the Claude CLI delegate.
 * The delegate only runs on write-intent turns, so it always uses the
 * write-turn visibility budget (not the 6 KB read-turn executor cap).
 */
export function delegateToolResultContextChars(): number {
  return WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS;
}

/** Keep the newest N assistant/tool cycles intact; older ones become a checkpoint. */
const KEEP_NEWEST_ASSISTANT_CYCLES = 2;
/** Hard cap for the evidence checkpoint carrier message. */
const EVIDENCE_CHECKPOINT_MAX_CHARS = 2_000;

const CHECKPOINT_READ_TOOLS = new Set([
  "read_file",
  "list_directory",
  "glob",
  "grep",
  "workspace_read",
]);
const CHECKPOINT_WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
]);

export interface TranscriptMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  /** Present on assistant turns that issued tool_calls; kept for provider pairing. */
  tool_calls?: unknown;
}

/**
 * Evict only old runtime payloads from a loop transcript. Messages stay in
 * place so provider tool-call pairing remains valid, and the newest assistant
 * turn plus its immediately-following results remain intact.
 */
export function enforceTranscriptBudget(
  messages: TranscriptMessage[],
  budgetTokens: number,
): { evicted: number; inputTokens: number } {
  const measure = () => countTokens(JSON.stringify(messages));
  let inputTokens = measure();
  if (inputTokens <= budgetTokens) return { evicted: 0, inputTokens };

  const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistantIndex < 0) return { evicted: 0, inputTokens };

  let evicted = 0;
  for (let index = 2; index < lastAssistantIndex && inputTokens > budgetTokens; index++) {
    const message = messages[index];
    const isPreflightCarrier = message.role === "user"
      && /^\[Runtime (?:preflight:|substitution\])/i.test(message.content);
    if (message.role !== "tool" && !isPreflightCarrier) continue;
    if (message.content.includes("[elided to fit context budget:")) continue;

    const name = message.name || (isPreflightCarrier
      ? (message.content.match(/^\[Runtime ([^\]]+)/i)?.[1] ?? "runtime result")
      : "tool result");
    message.content = `[elided to fit context budget: earlier ${name} result (${message.content.length} chars) removed — re-run the tool if needed]`;
    evicted++;
    inputTokens = measure();
  }

  return { evicted, inputTokens };
}

/**
 * Mid-loop write-pressure nudges (WRITE_EFFECT_NUDGE / buildWriteEffectNudge).
 * These are deduped to at most one across compaction — distinct from the
 * seeded `[Runtime write contract]`, which is a permanent stage carrier.
 */
function isWritePressureMessage(content: string): boolean {
  if (content.includes("[Runtime write contract]")) return false;
  return content.includes("CHANGE request")
    && (
      content.includes("write tools")
      || content.includes("write tool")
      || content.includes("Available write tools")
      || content.includes("Expected write target")
    );
}

/** Seeded write-intent contract; must survive cycle compaction as its own slot. */
function isWriteContractMessage(content: string): boolean {
  return content.includes("[Runtime write contract]");
}

function isCarriedEvidenceMessage(content: string): boolean {
  return content.includes("[Runtime carried evidence]");
}

function toolTargetPath(call: ToolCallRecord): string {
  const args = call.arguments as Record<string, unknown> | undefined;
  if (typeof args?.path === "string" && args.path.trim()) return args.path.trim();
  if (typeof args?.file_path === "string" && args.file_path.trim()) return args.file_path.trim();
  return "";
}

/**
 * Build a bounded evidence checkpoint from clean tool records.
 * Paths are ordered by first appearance; failed tools list paths (or tool name).
 */
export function buildEvidenceCheckpoint(toolCalls: readonly ToolCallRecord[]): string {
  const reads: string[] = [];
  const writes: string[] = [];
  const failed: string[] = [];
  const seenRead = new Set<string>();
  const seenWrite = new Set<string>();
  const seenFailed = new Set<string>();

  for (const call of toolCalls) {
    const path = toolTargetPath(call);
    if (call.is_error) {
      const label = path || call.name;
      if (!seenFailed.has(label)) {
        seenFailed.add(label);
        failed.push(label);
      }
      continue;
    }
    if (CHECKPOINT_READ_TOOLS.has(call.name) && path && !seenRead.has(path)) {
      seenRead.add(path);
      reads.push(path);
    }
    if (CHECKPOINT_WRITE_TOOLS.has(call.name) && path && !seenWrite.has(path)) {
      seenWrite.add(path);
      writes.push(path);
    }
  }

  let text = [
    "[Evidence checkpoint]",
    `reads: ${reads.length > 0 ? reads.join(", ") : "none"}`,
    `writes: ${writes.length > 0 ? writes.join(", ") : "none"}`,
    `failed: ${failed.length > 0 ? failed.join(", ") : "none"}`,
  ].join("\n");

  if (text.length > EVIDENCE_CHECKPOINT_MAX_CHARS) {
    text = text.slice(0, EVIDENCE_CHECKPOINT_MAX_CHARS);
  }
  return text;
}

/** Index after the system + original user request prefix. */
function seedEndIndex(messages: readonly TranscriptMessage[]): number {
  if (messages.length === 0) return 0;
  if (messages[0]?.role === "system") {
    if (messages[1]?.role === "user") return 2;
    return 1;
  }
  if (messages[0]?.role === "user") return 1;
  return 0;
}

/**
 * Compact completed executor assistant/tool cycles into a single evidence
 * checkpoint while preserving the newest cycles and tool_call pairing.
 *
 * - Compacts whole cycles only (never separates a retained tool result from
 *   its assistant `tool_calls`).
 * - Keeps the newest two assistant cycles intact.
 * - Replaces older cycles with one `[Evidence checkpoint]` derived from clean
 *   tool records (capped at 2,000 chars).
 * - Drops duplicate write-pressure user messages.
 * - Runs {@link enforceTranscriptBudget} afterward as the final size fence.
 */
export function compactCompletedExecutorCycles(
  messages: TranscriptMessage[],
  toolCalls: readonly ToolCallRecord[],
  budgetTokens: number,
): { compactedCycles: number; inputTokens: number } {
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistantIndices.push(i);
  }

  let compactedCycles = 0;

  if (assistantIndices.length > KEEP_NEWEST_ASSISTANT_CYCLES) {
    const seedEnd = seedEndIndex(messages);
    const keepFrom = assistantIndices[assistantIndices.length - KEEP_NEWEST_ASSISTANT_CYCLES];
    const compactAssistants = assistantIndices.filter((index) => index < keepFrom);
    compactedCycles = compactAssistants.length;

    // Checkpoint summarizes clean tool records (paths the model already
    // gathered). Cap is applied inside buildEvidenceCheckpoint.
    const checkpoint = buildEvidenceCheckpoint(toolCalls);

    const gap = messages.slice(seedEnd, keepFrom);
    const pressureInGap = gap.filter(
      (message) => message.role === "user" && isWritePressureMessage(message.content),
    );
    // Carried evidence + write contract sit after the seed; keep the latest of
    // each so re-entry and write-intent do not lose permanent stage carriers.
    const carriedInGap = gap.filter(
      (message) => message.role === "user" && isCarriedEvidenceMessage(message.content),
    );
    const contractInGap = gap.filter(
      (message) => message.role === "user" && isWriteContractMessage(message.content),
    );

    const next: TranscriptMessage[] = messages.slice(0, seedEnd);
    if (carriedInGap.length > 0) {
      next.push({ ...carriedInGap[carriedInGap.length - 1] });
    }
    if (contractInGap.length > 0) {
      next.push({ ...contractInGap[contractInGap.length - 1] });
    }
    next.push({ role: "user", content: checkpoint });

    // At most one mid-loop write-pressure note between checkpoint and retained cycles.
    if (pressureInGap.length > 0) {
      next.push({ ...pressureInGap[pressureInGap.length - 1] });
    }

    let seenPressure = pressureInGap.length > 0;
    let seenCarried = carriedInGap.length > 0;
    let seenContract = contractInGap.length > 0;
    for (const message of messages.slice(keepFrom)) {
      if (message.role === "user" && isWritePressureMessage(message.content)) {
        if (seenPressure) continue;
        seenPressure = true;
      }
      if (message.role === "user" && isCarriedEvidenceMessage(message.content)) {
        if (seenCarried) continue;
        seenCarried = true;
      }
      if (message.role === "user" && isWriteContractMessage(message.content)) {
        if (seenContract) continue;
        seenContract = true;
      }
      next.push(message);
    }

    messages.length = 0;
    messages.push(...next);
  } else {
    // Collapse duplicate mid-loop pressure notes (not the write contract carrier).
    let seenPressure = false;
    let seenContract = false;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "user" && isWriteContractMessage(message.content)) {
        if (seenContract) {
          messages.splice(i, 1);
          i--;
          continue;
        }
        seenContract = true;
        continue;
      }
      if (message.role === "user" && isWritePressureMessage(message.content)) {
        if (seenPressure) {
          messages.splice(i, 1);
          i--;
          continue;
        }
        seenPressure = true;
      }
    }
  }

  // Final size fence: payload eviction only, preserves tool_call pairing.
  const fence = enforceTranscriptBudget(messages, budgetTokens);
  return { compactedCycles, inputTokens: fence.inputTokens };
}

/** Trim dynamic stage text while preserving both the newest request prefix and
 * the tail where the latest tool effects and terminal status are rendered. */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (!text || budgetTokens <= 0) return "";
  if (countTokens(text) <= budgetTokens) return text;
  let headChars = Math.max(80, Math.floor(budgetTokens * 4 * 0.68));
  let tailChars = Math.max(40, Math.floor(budgetTokens * 4 * 0.24));
  const marker = "\n...[context truncated for latency budget]...\n";
  let output = "";
  while (headChars + tailChars > 120) {
    output = `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
    if (countTokens(output) <= budgetTokens) return output;
    headChars = Math.floor(headChars * 0.9);
    tailChars = Math.floor(tailChars * 0.9);
  }
  return output || text.slice(0, Math.max(1, budgetTokens * 4));
}

/** Newest-first token-budgeted history block for the orchestrator contextMessage. */
export function buildBoundedHistoryBlock(
  turnHistory: Array<{ role: string; content: string }>,
  budgetTokens = 4_000,
  perMessageChars = 1_000,
): string {
  if (budgetTokens <= 0 || turnHistory.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (let index = turnHistory.length - 1; index >= 0; index--) {
    const message = turnHistory[index];
    const line = `[${message.role.toUpperCase()}]: ${message.content.slice(0, perMessageChars)}${message.content.length > perMessageChars ? "..." : ""}`;
    const cost = countTokens(line);
    if (used + cost > budgetTokens && lines.length > 0) break;
    lines.unshift(line);
    used += cost;
  }
  const dropped = turnHistory.length - lines.length;
  return (dropped > 0 ? `[... ${dropped} earlier message(s) omitted for context budget ...]\n` : "")
    + lines.join("\n");
}
