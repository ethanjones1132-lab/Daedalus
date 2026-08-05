import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  MAX_GROUNDING_SYMBOLS,
  GROUNDING_BLOCK_CONTEXT_CHARS,
  collectSymbolGrounding,
  extractGroundingIdentifiers,
  formatGroundingBlock,
  parseGrepContentHits,
  buildGroundingGrepPattern,
  type SymbolGroundingResult,
} from "./symbol-grounding";

describe("extractGroundingIdentifiers", () => {
  test("pulls Perihelion-style fabricated / real API names from task prose", () => {
    const text = `
      Fix the filter: use \`juce::isnan\` on the sample, call
      Slider::setTextFromValueFunction for the UI, and set
      StateVariableTPTFilterType::notch on the DSP path.
    `;
    const ids = extractGroundingIdentifiers(text);
    expect(ids).toContain("juce::isnan");
    expect(ids).toContain("Slider::setTextFromValueFunction");
    expect(ids).toContain("StateVariableTPTFilterType::notch");
  });

  test("extracts backticked spans and function-call shapes", () => {
    const text = "Wire `clampValue` into processBlock, then call prepareToPlay(sampleRate).";
    const ids = extractGroundingIdentifiers(text);
    expect(ids).toContain("clampValue");
    expect(ids).toContain("prepareToPlay");
  });

  test("stoplist + single lowercase filter: plain English yields nothing", () => {
    const text =
      "please fix the bug in the file and make sure the tests pass when you write the code";
    expect(extractGroundingIdentifiers(text)).toEqual([]);
  });

  test("dedupes and caps at MAX_GROUNDING_SYMBOLS", () => {
    const names = Array.from({ length: 12 }, (_, i) => `ApiThing${i}Helper`);
    const text = names.map((n) => `\`${n}\``).join(" ") + " " + names[0] + " again";
    const ids = extractGroundingIdentifiers(text);
    expect(ids.length).toBeLessThanOrEqual(MAX_GROUNDING_SYMBOLS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("qualified dotted names with three segments", () => {
    const ids = extractGroundingIdentifiers("Use std.math.isnan carefully.");
    expect(ids.some((id) => id.includes("std.math.isnan") || id === "std.math.isnan")).toBe(true);
  });
});

describe("formatGroundingBlock", () => {
  test("found symbols render path:line hits", () => {
    const results: SymbolGroundingResult[] = [
      {
        symbol: "clampValue",
        status: "found",
        hits: [
          { path: "lib/math.ts", line: 12, text: "export function clampValue(x: number, lo: number, hi: number)" },
        ],
      },
    ];
    const block = formatGroundingBlock(results);
    expect(block).toContain("clampValue:");
    expect(block).toContain("lib/math.ts:12:");
    expect(block).toContain("export function clampValue");
  });

  test("missing symbols render NOT FOUND anti-fabrication line", () => {
    const results: SymbolGroundingResult[] = [
      { symbol: "juce::isnan", status: "missing", hits: [] },
    ];
    const block = formatGroundingBlock(results);
    expect(block).toContain("juce::isnan: NOT FOUND in project source");
    expect(block).toContain("do not reference juce::isnan");
  });

  test("indeterminate symbols render SEARCH INDETERMINATE", () => {
    const results: SymbolGroundingResult[] = [
      { symbol: "RealExistingApi", status: "indeterminate", hits: [], errors: ["permission denied"] },
    ];
    const block = formatGroundingBlock(results);
    expect(block).toContain("SEARCH INDETERMINATE");
    expect(block).not.toContain("NOT FOUND");
  });

  test("budget cap truncates oversized blocks", () => {
    const longLine = "x".repeat(800);
    const results: SymbolGroundingResult[] = Array.from({ length: 8 }, (_, i) => ({
      symbol: `VeryLongSymbolName${i}Type`,
      status: "found" as const,
      hits: [
        { path: `src/mod${i}.ts`, line: 1, text: longLine },
        { path: `src/mod${i}.ts`, line: 2, text: longLine },
        { path: `src/mod${i}.ts`, line: 3, text: longLine },
      ],
    }));
    const block = formatGroundingBlock(results);
    expect(block.length).toBeLessThanOrEqual(GROUNDING_BLOCK_CONTEXT_CHARS + 50);
  });
});

describe("parseGrepContentHits / buildGroundingGrepPattern", () => {
  test("parses content-mode path:line: text", () => {
    const hits = parseGrepContentHits("lib/a.ts:4: export function clampValue(x)\nlib/b.ts:9: clampValue(1, 0, 1)");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ path: "lib/a.ts", line: 4, text: "export function clampValue(x)" });
  });

  test("pattern wraps simple identifiers in word boundaries", () => {
    expect(buildGroundingGrepPattern("clampValue")).toBe("\\bclampValue\\b");
    expect(buildGroundingGrepPattern("juce::isnan")).toContain("juce::isnan");
  });
});

describe("collectSymbolGrounding orchestration", () => {
  test("found symbol yields hits; bait symbol yields NOT FOUND; dep only via miss pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "math.ts"),
      "export function clampValue(x: number, lo: number, hi: number) {\n  return Math.min(hi, Math.max(lo, x));\n}\n",
    );
    mkdirSync(join(root, "node_modules", "fast-lib"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "fast-lib", "index.js"),
      "export function realFastClamp(x) { return x; }\n",
    );

    // Simulate handleGrep: recursive walk skips node_modules; explicit path does not.
    const grep: Parameters<typeof collectSymbolGrounding>[0]["grep"] = async ({ pattern, path, headLimit }) => {
      const { readdirSync, readFileSync, statSync } = await import("fs");
      const { join: pjoin, relative } = await import("path");
      const regex = new RegExp(pattern);
      const results: string[] = [];
      const searchPath = path;

      const walk = (dir: string, skipNodeModules: boolean) => {
        if (results.length >= headLimit) return;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= headLimit) break;
          if (entry.startsWith(".") || entry === ".git") continue;
          if (skipNodeModules && entry === "node_modules") continue;
          const full = pjoin(dir, entry);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            walk(full, skipNodeModules);
          } else if (st.isFile() && st.size < 1_000_000) {
            try {
              const content = readFileSync(full, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${relative(searchPath, full)}:${i + 1}: ${lines[i].trim()}`);
                  if (results.length >= headLimit) break;
                }
              }
            } catch {
              /* binary */
            }
          }
        }
      };

      try {
        const st = statSync(searchPath);
        if (st.isDirectory()) {
          // When path is the workspace root, skip node_modules (primary pass).
          // When path is explicitly node_modules/..., do not skip (miss pass).
          const base = searchPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
          const skipNm = base !== "node_modules";
          walk(searchPath, skipNm);
        }
      } catch {
        return { output: "No matches found", is_error: true };
      }
      return { output: results.join("\n") || "No matches found", is_error: false };
    };

    const { results, summary } = await collectSymbolGrounding({
      symbols: ["clampValue", "juce::isnan", "realFastClamp"],
      searchRoot: root,
      rootEntries: ["src", "node_modules"],
      grep,
    });

    const bySymbol = Object.fromEntries(results.map((r) => [r.symbol, r]));
    expect(bySymbol["clampValue"]?.status).toBe("found");
    expect(bySymbol["clampValue"]?.hits.length).toBeGreaterThan(0);
    expect(bySymbol["juce::isnan"]?.status).toBe("missing");
    expect(bySymbol["realFastClamp"]?.status).toBe("found");
    expect(summary.symbols_searched).toBe(3);
    expect(summary.symbols_found).toBe(2);
    expect(summary.symbols_missing).toBe(1);
    expect(summary.symbols_indeterminate).toBe(0);

    const block = formatGroundingBlock(results);
    expect(block).toContain("clampValue:");
    expect(block).toContain("juce::isnan: NOT FOUND");
    expect(block).toContain("realFastClamp:");
  });

  test("grep errors produce indeterminate evidence, not a confirmed miss", async () => {
    const { results, summary } = await collectSymbolGrounding({
      symbols: ["RealExistingApi"],
      searchRoot: "C:/workspace",
      rootEntries: [],
      grep: async () => ({ output: "permission denied", is_error: true }),
    });

    expect(results[0]?.status).toBe("indeterminate");
    expect(results[0]?.errors).toContain("permission denied");
    expect(summary.symbols_missing).toBe(0);
    expect(summary.symbols_indeterminate).toBe(1);
    expect(formatGroundingBlock(results)).toContain("SEARCH INDETERMINATE");
  });

  test("a successful exhaustive no-match is a confirmed miss", async () => {
    const { results, summary } = await collectSymbolGrounding({
      symbols: ["AbsentApi"],
      searchRoot: "C:/workspace",
      rootEntries: [],
      grep: async () => ({ output: "No matches found", is_error: false }),
    });

    expect(results[0]?.status).toBe("missing");
    expect(summary.symbols_missing).toBe(1);
    expect(summary.symbols_indeterminate).toBe(0);
  });

  test("search-budget exhaustion is indeterminate", async () => {
    const { results } = await collectSymbolGrounding({
      symbols: ["FirstApi", "SecondApi"],
      searchRoot: "C:/workspace",
      rootEntries: [],
      maxGreps: 1,
      grep: async () => ({ output: "No matches found", is_error: false }),
    });

    expect(results[0]?.status).toBe("missing");
    expect(results[1]?.status).toBe("indeterminate");
  });
});
