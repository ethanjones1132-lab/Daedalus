/** Text-bearing parts of an OpenAI-compatible streaming delta. */
export interface DeltaText {
  visible: string;
  reasoning: string;
}

/**
 * Providers disagree on the name of their hidden reasoning field. Keep the
 * normalization in one pure helper so every streaming loop applies the same
 * liveness semantics without leaking reasoning into the user-visible answer.
 */
export function extractDeltaText(choice: any): DeltaText {
  const delta = choice?.delta;
  return {
    visible: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta?.reasoning === "string"
        ? delta.reasoning
        : "",
  };
}
