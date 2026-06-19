// ═══════════════════════════════════════════════════════════════
// ── Reasoning Engine ──
// ═══════════════════════════════════════════════════════════════
// Extracts and structures Chain-of-Thought reasoning from model output.
// Handles both explicit reasoning tags and implicit reasoning patterns.

import type { ReasoningConfig } from "./config";

// ── Types ──

export interface ReasoningStep {
  type: "thought" | "action" | "observation" | "reflection" | "plan";
  content: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  timestamp: number;
}

export interface ReasoningTrace {
  id: string;
  session_id: string;
  steps: ReasoningStep[];
  is_complete: boolean;
  total_tokens: number;
  duration_ms: number;
}

// ── Reasoning Parser ──

export class ReasoningParser {
  private steps: ReasoningStep[] = [];
  private buffer = "";
  private inThinking = false;
  private inCodeBlock = false;
  private currentThought = "";
  private startTime: number;
  private traceId: string;
  private sessionId: string;
  private activePattern: { open: string; close: string; type: "thought" } | null = null;
  private hasEmittedContent = false;
  private static readonly MAX_BUFFER = 10485760; // 10MB max buffer

  private static readonly AT_START_REGEX = /\n\s*$/;
  private static readonly THINKING_PATTERNS = [
    { open: "<think>", close: "</think>", type: "thought" as const },
    { open: "<reasoning>", close: "</reasoning>", type: "thought" as const },
    { open: "<thought>", close: "</thought>", type: "thought" as const },
    { open: "Thinking:", close: "\n\n", type: "thought" as const },
  ];
  private static readonly ORPHAN_CLOSE_TAGS = ReasoningParser.THINKING_PATTERNS
    .map((pattern) => pattern.close)
    .filter((closeTag) => closeTag.startsWith("</"));

  constructor(sessionId: string) {
    this.traceId = crypto.randomUUID();
    this.sessionId = sessionId;
    this.startTime = Date.now();
  }

  private pushContent(events: ReasoningEvent[], text: string) {
    if (text.length > 0) {
      events.push({ type: "content", text });
      this.hasEmittedContent = true;
    }
  }

  /** Process a streaming chunk and extract reasoning events */
  processChunk(chunk: string): ReasoningEvent[] {
    let newBuffer = this.buffer + chunk;
    const endsWithCarriageReturn = newBuffer.endsWith("\r");
    if (endsWithCarriageReturn) {
      newBuffer = newBuffer.slice(0, -1).replace(/\r\n/g, "\n") + "\r";
    } else {
      newBuffer = newBuffer.replace(/\r\n/g, "\n");
    }
    this.buffer = newBuffer;

    if (this.buffer.length > ReasoningParser.MAX_BUFFER) {
      console.warn(`[ReasoningParser] Buffer exceeded MAX_BUFFER (${ReasoningParser.MAX_BUFFER} bytes). Resetting buffer to prevent memory leak.`);
      if (this.inThinking) {
        this.currentThought += this.buffer;
        const thought = this.currentThought.trim();
        if (thought.length > 0) {
          this.steps.push({ type: "thought", content: thought, timestamp: Date.now() });
        }
        this.inThinking = false;
        this.activePattern = null;
        this.currentThought = "";
      }
      this.buffer = "";
    }
    const events: ReasoningEvent[] = [];

    while (this.buffer.length > 0) {
      if (this.inCodeBlock) {
        const codeIdx = this.buffer.indexOf("```");
        if (codeIdx === -1) {
          // Entire buffer is inside the code block.
          // Guard against partial backticks at the end of the buffer.
          let keepLength = 0;
          if (this.buffer.endsWith("``")) {
            keepLength = 2;
          } else if (this.buffer.endsWith("`")) {
            keepLength = 1;
          }

          if (keepLength > 0) {
            const emitText = this.buffer.slice(0, -keepLength);
            this.pushContent(events, emitText);
            this.buffer = this.buffer.slice(-keepLength);
          } else {
            this.pushContent(events, this.buffer);
            this.buffer = "";
          }
          break;
        } else {
          // Closing backticks found!
          const emitText = this.buffer.slice(0, codeIdx + 3);
          this.pushContent(events, emitText);
          this.inCodeBlock = false;
          this.buffer = this.buffer.slice(codeIdx + 3);
        }
      } else if (this.inThinking && this.activePattern) {
        const closeTag = this.activePattern.close;
        const closeIdx = this.buffer.indexOf(closeTag);

        if (closeIdx === -1) {
          // No close tag found. We might have a partial close tag at the end of the buffer.
          let keepLength = 0;
          for (let i = 1; i < closeTag.length; i++) {
            if (this.buffer.endsWith(closeTag.slice(0, i))) {
              keepLength = i;
            }
          }

          let addedText = "";
          if (keepLength > 0) {
            addedText = this.buffer.slice(0, -keepLength);
            this.currentThought += addedText;
            this.buffer = this.buffer.slice(-keepLength);
          } else {
            addedText = this.buffer;
            this.currentThought += addedText;
            this.buffer = "";
          }
          if (addedText.length > 0) {
            events.push({ type: "reasoning_chunk", text: addedText });
          }
          break; // Need more data
        } else {
          // Close tag found!
          const addedText = this.buffer.slice(0, closeIdx);
          this.currentThought += addedText;
          const thought = this.currentThought.trim();
          if (addedText.length > 0) {
            events.push({ type: "reasoning_chunk", text: addedText });
          }
          if (thought.length > 0) {
            const step: ReasoningStep = {
              type: this.activePattern.type,
              content: thought,
              timestamp: Date.now(),
            };
            this.steps.push(step);
            events.push({ type: "reasoning_step", step });
          }

          this.buffer = this.buffer.slice(closeIdx + closeTag.length);
          this.inThinking = false;
          this.activePattern = null;
          this.currentThought = "";
        }
      } else {
        // Not in code block, and not in thinking mode. Find the earliest start.
        let earliestOpenIdx = -1;
        let selectedPattern = null;

        for (const pattern of ReasoningParser.THINKING_PATTERNS) {
          const idx = this.buffer.indexOf(pattern.open);
          if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
            if (pattern.open === "Thinking:") {
              const isAtStart = !this.hasEmittedContent && (idx === 0 || this.buffer.slice(0, idx).trim() === "");
              if (!isAtStart) continue;
            }
            earliestOpenIdx = idx;
            selectedPattern = pattern;
          }
        }

        const codeIdx = this.buffer.indexOf("```");
        const hasCodeBlock = codeIdx !== -1;
        let earliestCloseIdx = -1;
        let selectedCloseTag = "";
        for (const closeTag of ReasoningParser.ORPHAN_CLOSE_TAGS) {
          const idx = this.buffer.indexOf(closeTag);
          if (idx !== -1 && (earliestCloseIdx === -1 || idx < earliestCloseIdx)) {
            earliestCloseIdx = idx;
            selectedCloseTag = closeTag;
          }
        }

        if (
          hasCodeBlock
          && (earliestOpenIdx === -1 || codeIdx < earliestOpenIdx)
          && (earliestCloseIdx === -1 || codeIdx < earliestCloseIdx)
        ) {
          // Code block starts first!
          const emitText = this.buffer.slice(0, codeIdx + 3);
          this.pushContent(events, emitText);
          this.inCodeBlock = true;
          this.buffer = this.buffer.slice(codeIdx + 3);
        } else if (selectedCloseTag && (earliestOpenIdx === -1 || earliestCloseIdx < earliestOpenIdx)) {
          const beforeText = this.buffer.slice(0, earliestCloseIdx);
          this.pushContent(events, beforeText);
          this.buffer = this.buffer.slice(earliestCloseIdx + selectedCloseTag.length);
        } else if (selectedPattern !== null) {
          // Found an open thinking tag!
          // Emit any text before the open tag as content
          const beforeText = this.buffer.slice(0, earliestOpenIdx);
          this.pushContent(events, beforeText);

          // Transition to thinking mode
          this.inThinking = true;
          this.activePattern = selectedPattern;
          this.currentThought = "";
          this.buffer = this.buffer.slice(earliestOpenIdx + selectedPattern.open.length);
        } else {
          // No open tags and no code block starts.
          // Check for a partial open tag or partial code block at the end of the buffer.
          let keepLength = 0;
          for (const pattern of ReasoningParser.THINKING_PATTERNS) {
            const openTag = pattern.open;
            for (let i = 1; i < openTag.length; i++) {
              if (this.buffer.endsWith(openTag.slice(0, i))) {
                keepLength = Math.max(keepLength, i);
              }
            }
          }
          for (const closeTag of ReasoningParser.ORPHAN_CLOSE_TAGS) {
            for (let i = 1; i < closeTag.length; i++) {
              if (this.buffer.endsWith(closeTag.slice(0, i))) {
                keepLength = Math.max(keepLength, i);
              }
            }
          }

          if (this.buffer.endsWith("``")) {
            keepLength = Math.max(keepLength, 2);
          } else if (this.buffer.endsWith("`")) {
            keepLength = Math.max(keepLength, 1);
          }

          if (keepLength > 0) {
            const emitText = this.buffer.slice(0, -keepLength);
            this.pushContent(events, emitText);
            this.buffer = this.buffer.slice(-keepLength);
          } else {
            // Emit everything as content
            this.pushContent(events, this.buffer);
            this.buffer = "";
          }
          break; // Done with current buffer
        }
      }
    }

    return events;
  }

  /** Flush any remaining buffer and return any final events */
  flush(): ReasoningEvent[] {
    const events: ReasoningEvent[] = [];
    if (this.inThinking) {
      const remaining = (this.currentThought + this.buffer).trim();
      if (remaining) {
        const step: ReasoningStep = {
          type: this.activePattern?.type ?? "thought",
          content: remaining,
          timestamp: Date.now(),
        };
        this.steps.push(step);
        events.push({ type: "reasoning_step", step });
      }
      this.currentThought = "";
      this.buffer = "";
    } else if (this.buffer.length > 0) {
      this.pushContent(events, this.buffer);
      this.buffer = "";
    }
    return events;
  }

  /** Finalize parsing — flush any remaining buffer and return the trace */
  finalize(): ReasoningTrace {
    // Flush remaining thought/buffer into steps if it wasn't flushed via flush()
    if (this.inThinking) {
      const remaining = (this.currentThought + this.buffer).trim();
      if (remaining) {
        this.steps.push({
          type: "thought",
          content: remaining,
          timestamp: Date.now(),
        });
      }
      this.currentThought = "";
      this.buffer = "";
    }

    return {
      id: this.traceId,
      session_id: this.sessionId,
      steps: this.steps,
      is_complete: true,
      total_tokens: this.steps.reduce((sum, s) => sum + s.content.split(/\s+/).length, 0),
      duration_ms: Date.now() - this.startTime,
    };
  }

  get trace(): ReasoningTrace {
    return {
      id: this.traceId,
      session_id: this.sessionId,
      steps: this.steps,
      is_complete: false,
      total_tokens: this.steps.reduce((sum, s) => sum + s.content.split(/\s+/).length, 0),
      duration_ms: Date.now() - this.startTime,
    };
  }
}

// ── Reasoning Events ──

export type ReasoningEvent =
  | { type: "reasoning_step"; step: ReasoningStep }
  | { type: "reasoning_chunk"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call"; tool_name: string; tool_input: Record<string, unknown> }
  | { type: "complete"; trace: ReasoningTrace };

export function stripReasoningFromText(text: string): string {
  if (!text) return "";

  const parser = new ReasoningParser("strip-reasoning");
  const visibleChunks: string[] = [];
  const collectVisibleText = (events: ReasoningEvent[]) => {
    for (const event of events) {
      if (event.type === "content") {
        visibleChunks.push(event.text);
      }
    }
  };

  collectVisibleText(parser.processChunk(text));
  collectVisibleText(parser.flush());
  const trace = parser.finalize();

  const result = visibleChunks.join("").trim();
  // Fallback: If stripping left us with nothing, but the original text had content,
  // and we were in a "Thinking:" block that never closed, restore the thought content as visible text.
  if (!result && text.trim()) {
    const lastStep = trace.steps[trace.steps.length - 1];
    if (lastStep && lastStep.type === "thought" && text.includes("Thinking:")) {
      const idx = text.indexOf("Thinking:");
      const before = text.slice(0, idx);
      const after = text.slice(idx + "Thinking:".length);
      return (before + after).trim();
    }
  }

  return result;
}

// ── Implicit Reasoning Detection ──

/**
 * Detects reasoning patterns in plain text output.
 * Some models don't use explicit tags but still show reasoning.
 */
export function detectImplicitReasoning(text: string): ReasoningStep[] {
  const steps: ReasoningStep[] = [];

  // Pattern: "Let me think about this..."
  // Pattern: "First, I need to..."
  // Pattern: "The issue is..."
  // Pattern: "I should..."

  const reasoningPatterns = [
    /(?:Let me think|I need to|First,|Second,|Third,|Finally,|The issue is|I should|I'll|Let's|Step \d+:|I notice|I see|Looking at this|Analyzing|The problem is|To solve this)/i,
  ];

  const lines = text.split("\n");
  for (const line of lines) {
    for (const pattern of reasoningPatterns) {
      if (pattern.test(line) && line.length > 10) {
        steps.push({
          type: "thought",
          content: line.trim(),
          timestamp: Date.now(),
        });
        break;
      }
    }
  }

  return steps;
}

// ── Format Reasoning for Display ──

export function formatReasoningTrace(trace: ReasoningTrace): string {
  if (trace.steps.length === 0) return "";

  const lines = trace.steps.map((step, i) => {
    const num = `[${i + 1}]`;
    switch (step.type) {
      case "thought":
        return `${num} 💭 ${step.content}`;
      case "action":
        return `${num} 🔧 ${step.tool_name}(${JSON.stringify(step.tool_input)})`;
      case "observation":
        return `${num} 👁 ${step.content}`;
      case "reflection":
        return `${num} 🔄 ${step.content}`;
      case "plan":
        return `${num} 📋 ${step.content}`;
      default:
        return `${num} ${step.content}`;
    }
  });

  return lines.join("\n");
}
