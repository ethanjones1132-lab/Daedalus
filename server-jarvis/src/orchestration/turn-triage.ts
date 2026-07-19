// 2026-07-17 incident note: every alternation here must match INFLECTED verb
// forms ("implementing", "writing", "fixing"), not just the base verb.
// "Begin implementing phase 1" matched nothing, classified answer_only, and
// short-circuited to a tool-less synthesizer that fabricated a completion.
const TASK_SIGNAL = /\b(read(?:ing)?|writ(?:e|ing)|edit(?:ing)?|creat(?:e|ing)|delet(?:e|ing)|run(?:ning)?|build(?:ing)?|fix(?:ing)?|refactor(?:ing)?|implement(?:ing)?|add(?:ing)?|remov(?:e|ing)|search(?:ing)?|find(?:ing)?|list(?:ing)?|summari[sz]e|review(?:ing)?|debug(?:ging)?|test(?:ing)?|deploy(?:ing)?|install(?:ing)?|configur(?:e|ing)|analyz(?:e|ing)|explain(?:ing)?|generat(?:e|ing)|updat(?:e|ing)|chang(?:e|ing)|verify(?:ing)?|file|repo|code|function|class|directory|folder|commit|branch|phase|task|step|plan)\b/i;

const TRIVIAL_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|howdy|hiya)\b/i,
  /\b(how are you|how's it going|how are things|what's up|whats up)\b/i,
  /^(thanks|thank you|ty|cheers|nice|cool|great|awesome|ok|okay|got it|sounds good)\b/i,
  /^(good (morning|afternoon|evening|night))\b/i,
];

const CONTINUATION_PATTERNS: RegExp[] = [
  /^(now|ok(ay)?|yes|yep|yeah|sure|please)?[,.!\s]*(go ahead|continue|proceed|carry on|keep going|do it|next)\b/i,
  /^(now\s+)?(task|step|item|part|phase|stage|milestone)\s*#?\d+\b/i,
  /^(and\s+)?(then\s+)?(the\s+)?(next|second|third)\s+(one|task|step|item)\b/i,
  /^same\s+(again|thing)\b/i,
  // Verification of just-completed work ("Verify implementation completed",
  // "check that the changes work") inherits the prior turn's authority so the
  // executor actually goes and looks, instead of a tool-less synthesizer
  // guessing. Concept questions ("verify my understanding of TCP") don't
  // mention prior-work nouns and stay non-continuation.
  /^(?:please\s+|now\s+|ok(?:ay)?\s+|and\s+)*(?:verify|check|confirm|validate)\b.{0,80}?\b(?:implement\w*|complet\w*|done|work(?:s|ed|ing)?|chang\w*|edit\w*|fix\w*|finish\w*|written|wrote|appl(?:y|ied))\b/i,
];

// `(?:[\w'’-]+\s+){0,4}?` lets up to four words — a gerund, determiners, or
// adjectives — sit between the command verb and the work object: "begin
// implementing phase 1", "start writing the plan", and (2026-07-18 23:23
// incident) "begin complete and total implementation of phase 1". The verb
// list must include completion verbs too: "Now complete phase 2 please" had
// no matching verb anywhere and short-circuited to a tool-less synthesizer
// that fabricated an implementation report. The `(?!\s+(?:you|we|they|i)\b)`
// guard keeps aux usage ("do you think…") from reading as a command.
export const WORK_START_COMMAND =
  /^(?:now |ok |okay |please |actually |just |alright |and |then )*(begin|start|complete|finish|resume|continue|execute|launch|perform|implement|tackle|kick off|wrap up|carry out|proceed with|do)(?!\s+(?:you|we|they|i)\b)\s+(?:[\w'’-]+\s+){0,4}?(phase|task|step|item|part|stage|plan|milestone|next|implementation|migration|integration|deployment|rollout|remainder|rest|work|fixe?|change|edit|feature|functionality)s?\b/i;

export function isContinuationTurn(request: string): boolean {
  const text = (request || "").trim();
  if (!text || text.length > 120) return false;
  return CONTINUATION_PATTERNS.some((re) => re.test(text)) || WORK_START_COMMAND.test(text);
}

const QUESTION_OPENER =
  /^(what|why|how|when|where|who|which|whose|is|are|was|were|does|do|did|can|could|should|would|will|explain|describe|summari[sz]e|tell me|walk me|what's|whats)\b/i;

/**
 * 2026-07-18 polarity flip: during an ACTIVE full-execution task run, the
 * question is no longer "does this message match a continuation pattern?"
 * but "is there any reason NOT to keep working?". Live sessions produced
 * "re-execute", "Please apply the edits oh my goodness", "go" — imperative
 * work orders that no finite pattern list will ever fully enumerate, and
 * every miss silently downgraded the turn to a tool-less pipeline. A short
 * non-question, non-smalltalk message during active work IS a work order.
 * Questions and pleasantries still break the inheritance.
 */
export function isWorkOrderFollowup(request: string): boolean {
  const text = (request || "").trim();
  if (!text || text.length > 160) return false;
  if (text.includes("?")) return false;
  if (QUESTION_OPENER.test(text)) return false;
  if (isTrivialConversationalTurn(text)) return false;
  return true;
}

export function isTrivialConversationalTurn(request: string): boolean {
  const text = (request || "").trim();
  if (text.length === 0) return true;
  if (text.length > 80) return false;
  if (TASK_SIGNAL.test(text)) return false;
  return TRIVIAL_PATTERNS.some((re) => re.test(text));
}
