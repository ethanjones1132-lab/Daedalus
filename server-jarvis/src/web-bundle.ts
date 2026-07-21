// ═══════════════════════════════════════════════════════════════
// ── Web Bundle ──
// ═══════════════════════════════════════════════════════════════
// web_search + web_fetch registered into the ToolRuntime. Ported verbatim from
// the legacy tools.ts. `searchWeb` is re-exported for the chat loop's explicit
// web-search shortcut.

import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import type { WebSearchConfig } from "./config";
import { NETWORK_TOOL_RESULT_CONTEXT_CHARS } from "./orchestration/context-budget";

const WEB_SEARCH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information. Returns DuckDuckGo instant-answer results and related links.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "network", evidence: "network", parallel_safe: true },
};

const WEB_FETCH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch content from a URL and extract relevant information.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        prompt: { type: "string", description: "What information to extract from the page (optional)" },
      },
      required: ["url"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "network", evidence: "network", parallel_safe: true, cacheable: true },
};

async function toolWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = normalizeWebUrl(args.url as string);
  const prompt = typeof args.prompt === "string" && args.prompt.trim()
    ? args.prompt.trim()
    : "Extract the information relevant to the user's request.";
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "Accept": "text/html, text/plain, application/json",
        "User-Agent": "Jarvis/3.0 web_fetch",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    const text = await res.text();
    const stripped = extractReadableContent(text).slice(0, NETWORK_TOOL_RESULT_CONTEXT_CHARS);

    return `Content from ${url} (extraction prompt: ${prompt}):\n\n${stripped}`;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Readability-style extraction: prefer the main article region and drop
 * chrome (nav/header/footer/aside) so a research turn's evidence is the page's
 * actual content, not its menus. Falls back to the whole body when no article
 * region is marked up. Kept dependency-free — a heuristic, not a DOM parser.
 */
export function extractReadableContent(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");

  // Prefer the largest <article> or <main> region if present.
  const region = largestRegion(withoutNoise, "article") ?? largestRegion(withoutNoise, "main");
  const source = region ?? withoutNoise;

  return source
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function largestRegion(html: string, tag: string): string | null {
  const matches = [...html.matchAll(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"))];
  if (matches.length === 0) return null;
  return matches.reduce((longest, m) => (m[0].length > longest.length ? m[0] : longest), "");
}

async function toolWebSearch(args: Record<string, unknown>, ctx?: ExecutionContext): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("web_search requires a query.");
  return JSON.stringify(await searchWeb(query, ctx?.config?.web_search), null, 2);
}

/**
 * Resolve the effective provider: only use brave/tavily when their key is
 * actually present, otherwise there is nothing to try and DuckDuckGo is used
 * directly. Exported for pinning the routing decision without a live request.
 */
export function resolveSearchProvider(cfg?: WebSearchConfig): "duckduckgo" | "brave" | "tavily" {
  if (cfg?.provider === "brave" && cfg.brave_api_key.trim()) return "brave";
  if (cfg?.provider === "tavily" && cfg.tavily_api_key.trim()) return "tavily";
  return "duckduckgo";
}

export async function searchWeb(
  query: string,
  cfg?: WebSearchConfig,
): Promise<Record<string, unknown>> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("web_search requires a query.");

  const provider = resolveSearchProvider(cfg);
  if (provider !== "duckduckgo") {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      try {
        const result = provider === "brave"
          ? await searchBrave(normalizedQuery, cfg!.brave_api_key.trim(), ctrl.signal)
          : await searchTavily(normalizedQuery, cfg!.tavily_api_key.trim(), ctrl.signal);
        return { ...result, provider };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Keyed providers are an upgrade, never a hard dependency: any failure
      // falls back to the keyless DuckDuckGo path below so a bad key or an
      // outage degrades quality rather than breaking web_search entirely.
    }
  }

  return { ...(await searchDuckDuckGo(normalizedQuery)), provider: "duckduckgo" };
}

async function searchDuckDuckGo(normalizedQuery: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  try {
    const [instantResult, htmlResult] = await Promise.allSettled([
      fetchDuckDuckGoInstantAnswer(normalizedQuery, ctrl.signal),
      fetchDuckDuckGoHtmlResults(normalizedQuery, ctrl.signal),
    ]);
    const instant = instantResult.status === "fulfilled" ? instantResult.value : {};
    const results = htmlResult.status === "fulfilled" ? htmlResult.value : [];
    const related = flattenDuckDuckGoTopics(instant.RelatedTopics || []).slice(0, 8);

    if (
      htmlResult.status === "rejected"
      && !instant.Answer
      && !instant.AbstractText
      && related.length === 0
    ) {
      throw htmlResult.reason;
    }

    return {
      query: normalizedQuery,
      answer: instant.Answer || "",
      abstract: instant.AbstractText || "",
      abstract_url: instant.AbstractURL || "",
      related_topics: related,
      results,
      results_count: results.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchBrave(
  query: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status} ${res.statusText}`.trim());
  const json = await res.json() as any;
  const results = (json?.web?.results ?? []).slice(0, 8).map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: stripWebHtml(String(r.description ?? "")),
  }));
  return {
    query,
    answer: "",
    abstract: String(json?.web?.results?.[0]?.description ?? ""),
    abstract_url: String(json?.web?.results?.[0]?.url ?? ""),
    related_topics: [],
    results,
    results_count: results.length,
  };
}

async function searchTavily(
  query: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 8, include_answer: true }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status} ${res.statusText}`.trim());
  const json = await res.json() as any;
  const results = (json?.results ?? []).slice(0, 8).map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: stripWebHtml(String(r.content ?? "")),
  }));
  return {
    query,
    answer: String(json?.answer ?? ""),
    abstract: "",
    abstract_url: "",
    related_topics: [],
    results,
    results_count: results.length,
  };
}

async function fetchDuckDuckGoInstantAnswer(query: string, signal: AbortSignal): Promise<Record<string, any>> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      "Accept": "application/json",
      "User-Agent": "Jarvis/3.0 web_search",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  const json = await res.json();
  return json && typeof json === "object" ? json as Record<string, any> : {};
}

async function fetchDuckDuckGoHtmlResults(
  query: string,
  signal: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      "Accept": "text/html",
      "User-Agent": "Mozilla/5.0 (compatible; Jarvis/3.0 web_search)",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }

  const html = await res.text();
  const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.slice(0, 8).map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    return {
      title: stripWebHtml(match[2]),
      url: unwrapDuckDuckGoUrl(match[1]),
      snippet: stripWebHtml(snippetMatch?.[1] || ""),
    };
  });
}

function flattenDuckDuckGoTopics(topics: any[]): Array<{ text: string; url: string }> {
  const flattened: Array<{ text: string; url: string }> = [];
  for (const topic of topics) {
    if (Array.isArray(topic?.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }
    if (topic?.Text || topic?.FirstURL) {
      flattened.push({
        text: topic.Text || "",
        url: topic.FirstURL || "",
      });
    }
  }
  return flattened;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeWebHtml(rawUrl);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    return new URL(absolute).searchParams.get("uddg") || absolute;
  } catch {
    return absolute;
  }
}

function stripWebHtml(value: string): string {
  return decodeWebHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeWebHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeWebUrl(rawUrl: string): string {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) throw new Error("web_fetch requires a URL.");
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

export function registerWebBundle(rt: ToolRuntime): void {
  rt.register(WEB_SEARCH_DEF, (a, c) => toolWebSearch(a, c));
  rt.register(WEB_FETCH_DEF, (a) => toolWebFetch(a));
}
