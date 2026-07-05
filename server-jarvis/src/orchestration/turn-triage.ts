const TASK_SIGNAL = /\b(read|write|edit|create|delete|run|build|fix|refactor|implement|add|remove|search|find|list|summari[sz]e|review|debug|test|deploy|install|configure|analyze|explain|generate|update|change|file|repo|code|function|class|directory|folder|commit|branch)\b/i;

const TRIVIAL_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|howdy|hiya)\b/i,
  /\b(how are you|how's it going|how are things|what's up|whats up)\b/i,
  /^(thanks|thank you|ty|cheers|nice|cool|great|awesome|ok|okay|got it|sounds good)\b/i,
  /^(good (morning|afternoon|evening|night))\b/i,
];

const CONTINUATION_PATTERNS: RegExp[] = [
  /^(now|ok(ay)?|yes|yep|yeah|sure|please)?[,.!\s]*(go ahead|continue|proceed|carry on|keep going|do it|next)\b/i,
  /^(now\s+)?(task|step|item|part)\s*#?\d+\b/i,
  /^(and\s+)?(then\s+)?(the\s+)?(next|second|third)\s+(one|task|step|item)\b/i,
  /^same\s+(again|thing)\b/i,
];

export function isContinuationTurn(request: string): boolean {
  const text = (request || "").trim();
  if (!text || text.length > 120) return false;
  return CONTINUATION_PATTERNS.some((re) => re.test(text));
}

export function isTrivialConversationalTurn(request: string): boolean {
  const text = (request || "").trim();
  if (text.length === 0) return true;
  if (text.length > 80) return false;
  if (TASK_SIGNAL.test(text)) return false;
  return TRIVIAL_PATTERNS.some((re) => re.test(text));
}
