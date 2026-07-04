import { describe, expect, test } from "bun:test";
import {
  extractTextToolCalls,
  createStageStreamSanitizer,
  hasExplicitWebSearchIntent,
  TextToolCallStreamSanitizer,
  VisibleAnswerStreamSanitizer,
  webSearchQueryFromPrompt,
} from "./text-tools";
import { toApiTools } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string", description: "Path" } }, required: ["path"] },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "Pattern" }, path: { type: "string", description: "Path" } }, required: ["pattern"] },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List a directory",
      parameters: { type: "object", properties: { path: { type: "string", description: "Path" } }, required: ["path"] },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "browse",
      description: "Browse a URL",
      parameters: { type: "object", properties: { url: { type: "string", description: "URL" } }, required: ["url"] },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search web",
      parameters: { type: "object", properties: { query: { type: "string", description: "Query" } }, required: ["query"] },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "mcp_call_tool",
      description: "Call MCP",
      parameters: { type: "object", properties: { server: { type: "string", description: "Server" }, tool: { type: "string", description: "Tool" } }, required: ["server", "tool"] },
    },
    requires_approval: true,
    dangerous: true,
  },
  {
    type: "function",
    function: {
      name: "agent",
      description: "Run agent",
      parameters: { type: "object", properties: { prompt: { type: "string", description: "Prompt" } }, required: ["prompt"] },
    },
    requires_approval: true,
    dangerous: false,
  },
];

function sanitizeVisibleAnswer(chunks: string[]): string {
  const sanitizer = new VisibleAnswerStreamSanitizer();
  return chunks.map((chunk) => sanitizer.push(chunk)).join("") + sanitizer.flush();
}

describe("text tool extraction", () => {
  test("non-tool orchestration stages suppress bare tool markup before activity is emitted", () => {
    const sanitizer = createStageStreamSanitizer(false);

    expect(sanitizer.push('{"name":"read_file","arguments":{"path":"README.md"}}\n')).toBe("");
    expect(sanitizer.push("Planner summary follows.\n")).toBe("Planner summary follows.\n");
    expect(sanitizer.flush()).toBe("");
  });

  test("extracts tagged tool calls without leaking the block", () => {
    const parsed = extractTextToolCalls(
      'I will check.\n<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
      tools,
    );

    expect(parsed.cleanedText).toBe("I will check.");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({ path: "README.md" });
  });

  test("strips a hallucinated tool_call tag even with an empty tools list (no stage-appropriate tools offered)", () => {
    // Regression for the 2026-07-01 live incident: the synthesizer stage
    // never passes `tools` (it has none), so it never runs this extraction —
    // but a free-tier model can still hallucinate <tool_call> syntax from
    // prior context (e.g. echoing the executor's tool-heavy activity log).
    // Calling extractTextToolCalls with an empty tools array must still
    // strip the tag (nothing CAN match against an empty allow-list, so
    // `calls` stays empty, but the cleanup regex fires independently of
    // whether any call actually matched).
    const parsed = extractTextToolCalls(
      '<tool_call>{"name":"list_directory","arguments":{"path":"C:\\\\Projects\\\\Versutus\\\\src\\\\lib\\\\gateway"}}</tool_call>',
      [],
    );

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toBe("");
  });

  test("strips bare tool JSON lines with an empty tools list (2026-07-02 synthesizer spill)", () => {
    const spill =
      '{"name":"read_file","arguments":{"path":"C:\\\\Projects\\\\Versutus\\\\src\\\\lib\\\\gateway\\\\client.ts"}}\n' +
      '{"name":"read_file","arguments":{"path":"C:\\\\Projects\\\\Versutus\\\\src\\\\lib\\\\gateway\\\\types.ts"}}';
    const parsed = extractTextToolCalls(spill, []);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toBe("");
  });

  test("strips an UNCLOSED tool_call tag on the same line as the JSON (2026-07-03 live leak)", () => {
    // Exact reproduction of session 1d4727cf / run_81091960: the synthesizer
    // emitted `<tool_call>{json}` with no closing tag. The cosmetic line-strip
    // skipped the line (removing the JSON leaves the tag as a non-empty
    // remainder — "mixed prose" protection), then the lone-tag cleanup deleted
    // the tag, leaving the naked JSON as the user-visible answer. An unclosed
    // open tag must suppress everything after it, mirroring the stream
    // sanitizer's semantics.
    const leaked =
      '<tool_call>{"name":"list_directory","arguments":{"path":"C:\\\\Projects\\\\Versutus\\\\src"}}';

    const parsed = extractTextToolCalls(leaked, []);
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toBe("");

    // Prose before the unclosed block survives; the block itself never leaks.
    const withProse = extractTextToolCalls(`Checking the src folder now.\n${leaked}`, []);
    expect(withProse.cleanedText).toBe("Checking the src folder now.");

    // Unclosed tag with the JSON on the NEXT line is equally suppressed.
    const nextLine = extractTextToolCalls(
      '<tool_call>\n{"name":"list_directory","arguments":{"path":"C:\\\\Projects\\\\Versutus\\\\src"}}',
      [],
    );
    expect(nextLine.cleanedText).toBe("");
  });

  test("stray closing tag cannot un-mix a line into a leaking tool echo", () => {
    // Tag removal can turn `</tool_call>{json}` into a pure tool-echo line;
    // the post-removal cosmetic re-run must strip it.
    const parsed = extractTextToolCalls(
      '</tool_call>{"name":"read_file","arguments":{"path":"README.md"}}',
      [],
    );
    expect(parsed.cleanedText).toBe("");
  });

  test("unclosed tag still yields the executable call for stages WITH tools", () => {
    // Executor-protocol models sometimes stop before emitting </tool_call>.
    // The call must still be extracted (bare-JSON candidate scan) and the
    // visible text must not leak the payload.
    const parsed = extractTextToolCalls(
      'Reading it now.\n<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}',
      tools,
    );
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.cleanedText).toBe("Reading it now.");
  });

  test("preserves non-tool JSON in answers when tools list is empty", () => {
    const parsed = extractTextToolCalls('Config: {"theme":"dark","fontSize":14}', []);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toContain("theme");
  });

  test("strips cosmetic tool echoes only when they occupy a complete line", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const parsed = extractTextToolCalls(`Before\n${toolJson}\nAfter`, []);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toBe("Before\nAfter");
  });

  test("preserves cosmetic-tool-shaped JSON in fenced examples and mixed prose", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const fenced = `\`\`\`json\n${toolJson}\n\`\`\``;

    expect(extractTextToolCalls(fenced, []).cleanedText).toBe(fenced);
    expect(extractTextToolCalls(`Here: ${toolJson}`, []).cleanedText).toBe(`Here: ${toolJson}`);
  });

  test("keeps generic name JSON but strips legacy flat tool-key echoes", () => {
    const generic = 'Search metadata: {"name":"search","query":"x"}';
    const legacy = '{"tool":"find_files","path":"."}';

    expect(extractTextToolCalls(generic, []).cleanedText).toBe(generic);
    expect(extractTextToolCalls(legacy, []).cleanedText).toBe("");
  });

  // ── isCosmeticToolEchoPayloadStrict — pinned contract for the post-turn ──
  // cosmetic-strip predicate. The streaming sanitizer uses a looser
  // predicate (isCosmeticToolEchoPayload) because it has to commit line-by-line,
  // but the post-turn extractor has the full picture and can afford to be
  // stricter — these three tests pin the cases where they differ.

  test("strict predicate: generic search JSON in prose is KEPT (no args)", () => {
    const { cleanedText } = extractTextToolCalls(`{"name":"search","query":"x"}\n`, []);
    expect(cleanedText).toContain("search");
  });

  test("strict predicate: legacy flat block with payload is stripped", () => {
    const { cleanedText } = extractTextToolCalls(`{"tool":"find_files","path":"."}\n`, []);
    expect(cleanedText).toBe("");
  });

  test("strict predicate: bare legacy block with no payload is KEPT", () => {
    const { cleanedText } = extractTextToolCalls(`{"tool":"read_file"}\n`, []);
    expect(cleanedText).toContain("read_file");
  });

  test("supports legacy find_files blocks with only a closing tag", () => {
    const parsed = extractTextToolCalls(
      '{"tool":"find_files","path":".","limit":100}\n</tool_call>',
      tools,
    );

    expect(parsed.cleanedText).toBe("");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("list_directory");
    expect(parsed.calls[0].arguments).toMatchObject({ path: "." });
  });

  test("maps browse blocks to the browse tool", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"tool":"browse","url":"example.com"}</tool_call>',
      tools,
    );

    expect(parsed.cleanedText).toBe("");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("browse");
    expect(parsed.calls[0].arguments).toEqual({ url: "example.com" });
  });

  test("maps websearch aliases to web_search", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"tool":"websearch","query":"Jarvis MCP tools"}</tool_call>',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("web_search");
    expect(parsed.calls[0].arguments).toEqual({ query: "Jarvis MCP tools" });
  });

  test("keeps MCP server and target tool arguments", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"tool":"mcp_call_tool","server":"github","tool_name":"list_issues","arguments":{"state":"open"}}</tool_call>',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("mcp_call_tool");
    expect(parsed.calls[0].arguments).toMatchObject({
      server: "github",
      tool: "list_issues",
      arguments: { state: "open" },
    });
  });

  test("maps legacy Task blocks to agent", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"tool":"Task","description":"Explore code","prompt":"Find the tools"}</tool_call>',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("agent");
    expect(parsed.calls[0].arguments).toMatchObject({ prompt: "Find the tools" });
  });

  test("api tool schemas exclude Jarvis-only metadata", () => {
    const apiTools = toApiTools(tools);

    expect(apiTools.length).toBeGreaterThan(0);
    expect(apiTools.some(tool => "requires_approval" in tool)).toBe(false);
    expect(apiTools.some(tool => "dangerous" in tool)).toBe(false);
  });
});

describe("text tool stream sanitizer", () => {
  test("suppresses tagged tool calls split across stream chunks", () => {
    const sanitizer = new TextToolCallStreamSanitizer();

    expect(sanitizer.push("Checking now.\n<tool_")).toBe("Checking now.\n");
    expect(sanitizer.push('call>{"name":"web_search","arguments":{"query":"Dillard restaurants"}}')).toBe("");
    expect(sanitizer.push("</tool_")).toBe("");
    expect(sanitizer.push("call>\nDone.")).toBe("\nDone.");
    expect(sanitizer.flush()).toBe("");
  });

  test("passes normal streamed text through without buffering whole responses", () => {
    const sanitizer = new TextToolCallStreamSanitizer();

    expect(sanitizer.push("A normal response")).toBe("A normal response");
    expect(sanitizer.push(" keeps streaming.")).toBe(" keeps streaming.");
    expect(sanitizer.flush()).toBe("");
  });

  test("suppresses bare tool JSON lines split across stream chunks", () => {
    const sanitizer = new VisibleAnswerStreamSanitizer();

    expect(sanitizer.push('{"name":"read_file","arguments":{"path":"a.ts"}}\n')).toBe("");
    expect(sanitizer.push('{"name":"read_file","arguments":{"path":"b.ts"}}\n')).toBe("");
    expect(sanitizer.push("Here is the summary.")).toBe("Here is the summary.");
    expect(sanitizer.flush()).toBe("");
  });

  test("is chunking-invariant and byte-faithful for clean multi-paragraph markdown", () => {
    const markdown = "# Heading\n\nIntro paragraph.\n\n- first item\n\n- second item\n";
    const chunkings = [
      [markdown],
      [...markdown],
      markdown.match(/\S+|\s+/g) ?? [],
      ["# Heading", "\n", "\nIntro paragraph.", "\n\n", "- first item\n", "\n- second item", "\n"],
      Array.from({ length: Math.ceil(markdown.length / 3) }, (_, index) => markdown.slice(index * 3, index * 3 + 3)),
    ];

    for (const chunks of chunkings) {
      expect(sanitizeVisibleAnswer(chunks)).toBe(markdown);
    }
  });

  test("preserves paragraph breaks, chunk-boundary newlines, and loose-list spacing", () => {
    expect(sanitizeVisibleAnswer(["Hello\n\nWorld\n"])).toBe("Hello\n\nWorld\n");
    expect(sanitizeVisibleAnswer(["Hello", "\nWorld"])).toBe("Hello\nWorld");
    expect(sanitizeVisibleAnswer(["- one\n\n- two\n"])).toBe("- one\n\n- two\n");
  });

  test("drops complete bare tool-JSON lines under arbitrary chunking", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const chunkings = [
      [toolJson + "\n"],
      ["{", toolJson.slice(1), "\n"],
      [...toolJson, "\n"],
      [toolJson],
    ];

    for (const chunks of chunkings) {
      expect(sanitizeVisibleAnswer(chunks)).toBe("");
    }
  });

  test("drops multiple cosmetic tool objects when they occupy one complete line", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    expect(sanitizeVisibleAnswer([`${toolJson} ${toolJson}\n`])).toBe("");
  });

  test("preserves mixed prose and cosmetic tool JSON regardless of chunk boundaries", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const expected = `Result: ${toolJson}`;

    expect(sanitizeVisibleAnswer([expected])).toBe(expected);
    expect(sanitizeVisibleAnswer(["Result: ", toolJson])).toBe(expected);
  });

  test("preserves fenced cosmetic tool JSON examples with fences intact", () => {
    const toolJson = '{"name":"read_file","arguments":{"path":"README.md"}}';
    const fenced = `\`\`\`json\n${toolJson}\n\`\`\`\n`;

    expect(sanitizeVisibleAnswer([fenced])).toBe(fenced);
    expect(sanitizeVisibleAnswer([...fenced])).toBe(fenced);
  });

  test("does not emit whitespace-only partial chunks", () => {
    const sanitizer = new VisibleAnswerStreamSanitizer();

    expect(sanitizer.push("   ")).toBe("");
    expect(sanitizer.push("\t")).toBe("");
    expect(sanitizer.flush()).toBe("");
  });
});

describe("explicit web search intent", () => {
  test("detects explicit web requests and keeps ordinary answers opt-in", () => {
    expect(hasExplicitWebSearchIntent("Please search the web for restaurants near Dillard, Georgia.")).toBe(true);
    expect(hasExplicitWebSearchIntent("Look it up online and tell me what changed.")).toBe(true);
    expect(hasExplicitWebSearchIntent("What are some restaurants near Dillard, Georgia?")).toBe(false);
  });

  test("derives a focused query from an explicit web-search request", () => {
    expect(webSearchQueryFromPrompt("Please use a web search for restaurants near Dillard, Georgia. and answer from the results."))
      .toBe("restaurants near Dillard, Georgia.");
  });
});
