// T1.5: detect synthesizer "stand by / I'll have X ready" stall answers.
// Conservative two-prong: short answer + future-promise pattern + no
// substantive markers (code fence, paths, lists, numbers). False positives
// on legit short answers that mention "moment"/"shortly" are rejected via
// the substantive-marker gate.

const FUTURE_PROMISE =
  /\b(stand\s+by|i['’]?ll\s+have\b|give\s+me\s+a\s+(moment|second|minute)|just\s+a\s+(moment|second|minute)|one\s+(moment|second)|coming\s+(right\s+)?up|i['’]?ll\s+(get|pull|fetch|prepare|compile|analyze|look)\b|working\s+on\s+(that|it|this)|bear\s+with\s+me|hang\s+tight)\b/i;

const SUBSTANTIVE =
  /```|`[^`]+`|[/\\][\w.-]+|\b\d{2,}\b|^\s*[-*•]\s+\S|^\s*\d+\.\s+\S|\bhttps?:\/\//m;

/** Answers shorter than this (after trim) are candidates for stall detection. */
export const DEFERRAL_STALL_MAX_CHARS = 600;

export function detectDeferralStall(answer: string): boolean {
  const text = (answer || "").trim();
  if (!text) return false;
  if (text.length >= DEFERRAL_STALL_MAX_CHARS) return false;
  if (!FUTURE_PROMISE.test(text)) return false;
  // Substantive content means this is a real (short) answer that happens to
  // contain a promise word — not a pure stall.
  if (SUBSTANTIVE.test(text)) return false;
  return true;
}

export const DEFERRAL_STALL_NUDGE =
  "Your previous reply only promised future work (e.g. \"stand by\", \"I'll have X ready\") without delivering the answer. " +
  "Answer the user NOW with the actual content. Do not narrate future work. Do not say stand by.";
