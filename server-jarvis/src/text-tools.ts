export class TextToolCallStreamSanitizer {
  private pending = "";
  private insideToolCall = false;

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(flush: boolean): string {
    let visible = "";

    while (this.pending) {
      const expectedTag = this.insideToolCall ? TOOL_CALL_CLOSE_TAG : TOOL_CALL_OPEN_TAG;
      const tagIndex = this.pending.toLowerCase().indexOf(expectedTag);

      if (tagIndex >= 0) {
        if (!this.insideToolCall) {
          visible += this.pending.slice(0, tagIndex);
        }
        this.pending = this.pending.slice(tagIndex + expectedTag.length);
        this.insideToolCall = !this.insideToolCall;
        continue;
      }

      if (flush) {
        if (!this.insideToolCall) visible += this.pending;
        this.pending = "";
        break;
      }

      const suffixLength = matchingTagPrefixSuffixLength(this.pending, expectedTag);
      if (!this.insideToolCall) {
        visible += this.pending.slice(0, this.pending.length - suffixLength);
      }
      this.pending = this.pending.slice(this.pending.length - suffixLength);
      break;
    }

    return visible;
  }
}

export function hasExplicitWebSearchIntent(text: string): boolean {
  return /\b(?:web\s*search|search\s+(?:the\s+)?(?:web|internet)|browse\s+(?:the\s+)?(?:web|internet)|(?:internet|online)\s+search|look\s+(?:it|this|that|them)?\s*up\s+(?:online|on\s+the\s+web))\b/i.test(text);
}

export function webSearchQueryFromPrompt(text: string): string {
  return text
    .replace(/^\s*please\b[:,]?\s*/i, "")
    .replace(/\b(?:please\s+)?(?:use|do|run|perform|conduct)\s+(?:a\s+)?web\s*search(?:\s+for)?\b/gi, " ")
    .replace(/\bsearch\s+(?:the\s+)?(?:web|internet)(?:\s+for)?\b/gi, " ")
    .replace(/\bbrowse\s+(?:the\s+)?(?:web|internet)(?:\s+for)?\b/gi, " ")
    .replace(/\b(?:and\s+)?(?:answer|respond|tell\s+me)[\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim() || text.trim();
}

export function buildTextToolInstructions(tools: ToolDefinition[]): string {
  const toolList = tools.map((tool) => {
    const required = tool.function.parameters.required;
    const properties = Object.entries(tool.function.parameters.properties)
      .map(([name, schema]) => `${name}${required.includes(name) ? "*" : ""}: ${schema.type}`)
      .join(", ");
    return `- ${tool.function.name}: ${tool.function.description} Args: { ${properties} }`;
  }).join("\n");