import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ExecutionContext } from "./tool-runtime";
import { registerWebBundle, extractReadableContent, resolveSearchProvider, searchWeb } from "./web-bundle";
import type { WebSearchConfig } from "./config";

// Ported from the legacy tools.test.ts "web tools" suite — now exercised through
// the canonical ToolRuntime instead of executeTool().

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function makeRuntime() {
  const rt = createToolRuntime();
  registerWebBundle(rt);
  return rt;
}

function ctx(): ExecutionContext {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  return makeExecutionContext("chat", cfg);
}

function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("web bundle", () => {
  test("registers web_search and web_fetch", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  test("web_search returns instant-answer information", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      Answer: "42",
      AbstractText: "A useful abstract.",
      AbstractURL: "https://example.com/abstract",
      RelatedTopics: [{ Text: "First result", FirstURL: "https://example.com/first" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await makeRuntime().execute(call("web_search", { query: "useful query" }), ctx());
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("A useful abstract.");
    expect(result.output).toContain("https://example.com/first");
  });

  test("web_search falls back to HTML results when instant-answer JSON is null", async () => {
    globalThis.fetch = (async (input: any) => {
      if (String(input).startsWith("https://api.duckduckgo.com/")) {
        return new Response("null", { status: 200, headers: { "Content-Type": "application/x-javascript" } });
      }
      return new Response(`
        <div class="result">
          <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Useful &amp; current docs</a></h2>
          <a class="result__snippet">The fetched result snippet.</a>
        </div>
      `, { status: 200, headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;

    const result = await makeRuntime().execute(call("web_search", { query: "current docs" }), ctx());
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Useful & current docs");
    expect(result.output).toContain("https://example.com/docs");
    expect(result.output).toContain("The fetched result snippet.");
  });

  test("web_fetch extracts page text and accepts a URL without a protocol", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: any) => {
      requestedUrl = String(input);
      return new Response("<html><style>hide me</style><body><h1>Useful title</h1><p>Useful body</p></body></html>", {
        status: 200, headers: { "Content-Type": "text/html" },
      });
    }) as typeof fetch;

    const result = await makeRuntime().execute(call("web_fetch", { url: "example.com" }), ctx());
    expect(result.is_error).toBe(false);
    expect(requestedUrl).toBe("https://example.com/");
    expect(result.output).toContain("Useful title Useful body");
    expect(result.output).not.toContain("hide me");
  });

  test("web_fetch reports HTTP failures as tool errors", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503, statusText: "Unavailable" })) as typeof fetch;
    const result = await makeRuntime().execute(call("web_fetch", { url: "https://example.com" }), ctx());
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("HTTP 503 Unavailable");
  });

  test("rejects a missing web_search query before making a request", async () => {
    let requested = false;
    globalThis.fetch = (async () => { requested = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const result = await makeRuntime().execute(call("web_search", {}), ctx());
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("Missing required argument");
    expect(requested).toBe(false);
  });
});

describe("readability extraction", () => {
  test("prefers the article region and drops nav/header/footer chrome", () => {
    const html = `
      <html><body>
        <nav>Home About Contact NAVNOISE</nav>
        <header>SITE HEADER NOISE</header>
        <article><h1>Real Title</h1><p>The actual body content here.</p></article>
        <footer>FOOTERNOISE copyright</footer>
      </body></html>`;
    const text = extractReadableContent(html);
    expect(text).toContain("Real Title");
    expect(text).toContain("The actual body content here.");
    expect(text).not.toContain("NAVNOISE");
    expect(text).not.toContain("SITE HEADER NOISE");
    expect(text).not.toContain("FOOTERNOISE");
  });

  test("strips scripts and styles, falls back to body when no article", () => {
    const html = `<body><script>evil()</script><style>.x{}</style><p>Plain page text.</p></body>`;
    const text = extractReadableContent(html);
    expect(text).toContain("Plain page text.");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain(".x{}");
  });
});

describe("search provider routing", () => {
  const base: WebSearchConfig = { provider: "duckduckgo", brave_api_key: "", tavily_api_key: "" };

  test("defaults to duckduckgo, and only uses a keyed provider when its key is present", () => {
    expect(resolveSearchProvider(undefined)).toBe("duckduckgo");
    expect(resolveSearchProvider(base)).toBe("duckduckgo");
    expect(resolveSearchProvider({ ...base, provider: "brave" })).toBe("duckduckgo");
    expect(resolveSearchProvider({ ...base, provider: "brave", brave_api_key: "k" })).toBe("brave");
    expect(resolveSearchProvider({ ...base, provider: "tavily" })).toBe("duckduckgo");
    expect(resolveSearchProvider({ ...base, provider: "tavily", tavily_api_key: "k" })).toBe("tavily");
  });

  test("a failing keyed provider falls back to duckduckgo rather than throwing", async () => {
    let braveHit = false;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("brave")) { braveHit = true; return new Response("nope", { status: 500 }); }
      // DuckDuckGo fallback path.
      return new Response(JSON.stringify({ Answer: "fallback-answer" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await searchWeb("q", { provider: "brave", brave_api_key: "k", tavily_api_key: "" });
    expect(braveHit).toBe(true);
    expect(result.provider).toBe("duckduckgo");
    expect(result.answer).toBe("fallback-answer");
  });
});
