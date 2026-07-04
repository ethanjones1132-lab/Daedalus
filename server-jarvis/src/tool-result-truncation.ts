export interface ToolResultTruncationMetadata {
  truncated: boolean;
  original_chars: number;
  retained_chars: number;
  removed_chars: number;
  limit_chars: number;
}

export interface PreparedToolResult {
  context: string;
  metadata: ToolResultTruncationMetadata;
}

/**
 * Bound a tool result for inference context while retaining exact provenance
 * metadata for the `tool_result` SSE frame shown by the UI.
 */
export function prepareToolResultForContext(text: string, limitChars: number): PreparedToolResult {
  const limit = Math.max(0, Math.floor(limitChars));
  if (text.length <= limit) {
    return {
      context: text,
      metadata: {
        truncated: false,
        original_chars: text.length,
        retained_chars: text.length,
        removed_chars: 0,
        limit_chars: limit,
      },
    };
  }

  // Reserve enough room for the marker before splitting the retained payload.
  const retainedChars = Math.max(0, limit - 120);
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  const removedChars = text.length - retainedChars;
  const marker = `\n\n[...truncated - ${removedChars} chars removed. Full result remains visible in the tool card...]\n\n`;
  const context = `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;

  return {
    context,
    metadata: {
      truncated: true,
      original_chars: text.length,
      retained_chars: retainedChars,
      removed_chars: removedChars,
      limit_chars: limit,
    },
  };
}
