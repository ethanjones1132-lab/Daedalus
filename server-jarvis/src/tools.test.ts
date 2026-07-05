import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { executeTextToolCall, extractTextToolCalls, textToolResultsPrompt } from "./text-tools";
import { executeTool, getAllTools, getApiTools } from "./tools";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("web tools", () => {
  test("registers web_search and strips Jarvis metadata from API schemas", () => {
    const cfg = defaultConfig();
    expect(getAllTools(cfg).map(tool => tool.function.name)).toContain("web_search");

    const apiTools = getApiTools(cfg);
    expect(apiTools.some(tool => "requires_approval" in tool)).toBe(false);
    expect(apiTools.some(tool => "dangerous" in tool)).toBe(false);
  });

  test("executes web_search and returns information to the text-tool continuation", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      Answer: "42",
      AbstractText: "A useful abstract.",
      AbstractURL: "https://example.com/abstract",
      RelatedTopics: [
        { Text: "First result", FirstURL: "https://example.com/first" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const cfg = defaultConfig();
    const tools = getAllTools(cfg);
    const parsed = extractTextToolCalls(
      '<tool_call>{"tool":"websearch","query":"useful query"}</tool_call>',
      tools,
    );
    expect(parsed.calls).toHaveLength(1);

    const result = await executeTextToolCall(parsed.calls[0], cfg, tools, executeTool);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("A useful abstract.");
    expect(result.output).toContain("https://example.com/first");

    const continuation = textToolResultsPrompt([result]);
    expect(continuation).toContain('<jarvis_internal_tool_result name="web_search"');
    expect(continuation).toContain("Tool result (success) for web_search");
    expect(continuation).toContain("A useful abstract.");
  });

  test("web_search falls back to HTML results when instant-answer JSON is null", async () => {
    globalThis.fetch = async (input) => {
      if (String(input).startsWith("https://api.duckduckgo.com/")) {
        return new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/x-javascript" },
        });
      }
      return new Response(`
        <div class="result">
          <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Useful &amp; current docs</a></h2>
          <a class="result__snippet">The fetched result snippet.</a>
        </div>
      `, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const result = await executeTool({
      id: "search-html-fallback",
      name: "web_search",
      arguments: { query: "current docs" },
    }, defaultConfig());

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Useful & current docs");
    expect(result.output).toContain("https://example.com/docs");
    expect(result.output).toContain("The fetched result snippet.");
  });

  test("web_fetch extracts page text and accepts a URL without a protocol", async () => {
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response("<html><style>hide me</style><body><h1>Useful title</h1><p>Useful body</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const result = await executeTool({
      id: "fetch-success",
      name: "web_fetch",
      arguments: { url: "example.com" },
    }, defaultConfig());

    expect(result.is_error).toBe(false);
    expect(requestedUrl).toBe("https://example.com/");
    expect(result.output).toContain("Useful title Useful body");
    expect(result.output).not.toContain("hide me");
  });

  test("web_fetch reports HTTP failures as tool errors", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503, statusText: "Unavailable" });

    const result = await executeTool({
      id: "fetch-failure",
      name: "web_fetch",
      arguments: { url: "https://example.com" },
    }, defaultConfig());

    expect(result.is_error).toBe(true);
    expect(result.error).toContain("HTTP 503 Unavailable");
  });

  test("rejects missing web_search query before making a request", async () => {
    let requested = false;
    globalThis.fetch = async () => {
      requested = true;
      return new Response("{}", { status: 200 });
    };

    const result = await executeTool({
      id: "search-missing-query",
      name: "web_search",
      arguments: {},
    }, defaultConfig());

    expect(result.is_error).toBe(true);
    expect(result.error).toContain("Missing required argument");
    expect(requested).toBe(false);
  });
});
