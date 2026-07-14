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
export function prepareToolResultForContext(
  text: string,
  limitChars: number,
  noteSuffix?: string,
): PreparedToolResult {
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
  // The orchestrator note is longer than the legacy marker, so calculate the
  // actual marker width instead of relying on the old fixed 120-char reserve.
  const markerText = (removedChars: number) => noteSuffix
    ? `\n\n[...truncated - ${removedChars} chars removed. ${noteSuffix}]\n\n`
    : `\n\n[...truncated - ${removedChars} chars removed. Full result remains visible in the tool card...]\n\n`;
  let retainedChars = Math.max(0, limit - 120);
  let removedChars = text.length - retainedChars;
  let marker = markerText(removedChars);
  while (retainedChars + marker.length > limit && retainedChars > 0) {
    retainedChars -= Math.min(retainedChars, retainedChars + marker.length - limit);
    removedChars = text.length - retainedChars;
    marker = markerText(removedChars);
  }
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;
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
