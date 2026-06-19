import { describe, expect, test } from "bun:test";
import {
  extractTextToolCalls,
  hasExplicitWebSearchIntent,
  TextToolCallStreamSanitizer,
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

describe("text tool extraction", () => {
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
