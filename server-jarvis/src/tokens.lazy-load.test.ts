import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer";

// DD-036 regression coverage for the source-mode lazy load (the shipped-layout
// variant lives in tokens.bundle.test.ts). These checks spawn isolated child
// processes because bun test runs every test file in one process: module-level
// load state in ./tokens is shared across files, so in-process assertions on
// getTokenizerLoadAttemptsForTest() would depend on test execution order.

const serverDir = process.cwd();
const repoRoot = resolve(serverDir, "..");

function runBun(
  args: string[],
  cwd: string,
  configPath: string,
  env?: Record<string, string | undefined>,
) {
  return Bun.spawnSync({
    // Same flags as the bundle test: the empty bunfig keeps the repo test
    // preload from attaching to these child runs.
    cmd: [process.execPath, `--config=${configPath}`, "--no-env-file", "--no-install", ...args],
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function outputOf(result: ReturnType<typeof runBun>): string {
  return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
}

function expectNoAncestorNodeModules(path: string): void {
  let cursor = resolve(path);
  while (true) {
    const nodeModulesPath = join(cursor, "node_modules");
    if (existsSync(nodeModulesPath)) {
      throw new Error("isolated run has a node_modules ancestor: " + nodeModulesPath);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function failWith(context: string, result: ReturnType<typeof runBun>): never {
  throw new Error(context + ":\n" + outputOf(result));
}

const SAMPLE_CODE = `function add(a: number, b: number): number {\n  return a + b;\n}\n`.repeat(15);
const SAMPLE_NON_ASCII = "🦊 café 你好 नमस्ते".repeat(25);
const SAMPLE_MIXED = SAMPLE_CODE + SAMPLE_NON_ASCII;

// The same safety multiplier tokens.ts applies (SAFETY_MULTIPLIER = 1.1).
const expectedCount = (text: string): number => Math.ceil(encode(text).length * 1.1);

describe("tokenizer lazy load (source mode)", () => {
  test(
    "import performs no load; the first concurrent batch shares exactly one load; counts match the pinned encoder",
    async () => {
      const tempRoot = await mkdtemp(join(repoRoot, ".tmp-token-lazy-"));
      const configPath = join(tempRoot, "bunfig.toml");
      await Bun.write(configPath, "");
      try {
        const probePath = join(tempRoot, "lazy-load-probe.mjs");
        const probe = [
          `import { countTokens, getTokenizerLoadAttemptsForTest } from ${JSON.stringify(
            join(serverDir, "src", "tokens.ts"),
          )};`,
          `const expected = ${JSON.stringify({
            code: expectedCount(SAMPLE_CODE),
            nonAscii: expectedCount(SAMPLE_NON_ASCII),
            mixed: expectedCount(SAMPLE_MIXED),
          })};`,
          `const code = ${JSON.stringify(SAMPLE_CODE)};`,
          `const nonAscii = ${JSON.stringify(SAMPLE_NON_ASCII)};`,
          `const mixed = ${JSON.stringify(SAMPLE_MIXED)};`,
          "const attemptsBefore = getTokenizerLoadAttemptsForTest();",
          "if (attemptsBefore !== 0) {",
          '  throw new Error("table loaded at import time: attempts=" + attemptsBefore);',
          "}",
          "const concurrent = await Promise.all([",
          "  countTokens(code),",
          "  countTokens(nonAscii),",
          "  countTokens(code),",
          "  countTokens(nonAscii),",
          "]);",
          "const attemptsAfterConcurrent = getTokenizerLoadAttemptsForTest();",
          "if (attemptsAfterConcurrent !== 1) {",
          '  throw new Error("first concurrent batch did not share one load: attempts=" + attemptsAfterConcurrent);',
          "}",
          "const later = countTokens(mixed);",
          "const attemptsAfterLater = getTokenizerLoadAttemptsForTest();",
          "if (attemptsAfterLater !== 1) {",
          '  throw new Error("repeat count reloaded the table: attempts=" + attemptsAfterLater);',
          "}",
          "if (concurrent[0] !== expected.code || concurrent[1] !== expected.nonAscii ||",
          "    concurrent[2] !== expected.code || concurrent[3] !== expected.nonAscii ||",
          "    later !== expected.mixed) {",
          '  throw new Error(JSON.stringify({ expected, concurrent, later }));',
          "}",
          "console.log(JSON.stringify({ attemptsBefore, attemptsAfterConcurrent, attemptsAfterLater }));",
        ].join("\n");
        await Bun.write(probePath, probe);
        expectNoAncestorNodeModules(probePath);

        const run = runBun([probePath], serverDir, configPath);
        if (run.exitCode !== 0) failWith("source-mode lazy-load probe failed", run);
        const observed = JSON.parse(
          outputOf(run).trim().split(/\r?\n/).at(-1) ?? "{}",
        ) as {
          attemptsBefore: number;
          attemptsAfterConcurrent: number;
          attemptsAfterLater: number;
        };
        expect(observed.attemptsBefore).toBe(0);
        expect(observed.attemptsAfterConcurrent).toBe(1);
        expect(observed.attemptsAfterLater).toBe(1);
      } finally {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    },
    120_000,
  );

  test(
    "falls back to len/4 only when the dependency is genuinely absent, without retrying",
    async () => {
      const tempRoot = await mkdtemp(join(repoRoot, ".tmp-token-fallback-"));
      const configPath = join(tempRoot, "bunfig.toml");
      await Bun.write(configPath, "");
      try {
        // Build ./src/tokens.ts standalone (no JARVIS_TOKENIZER_PACKAGED define,
        // so the packaged artifact path stays folded out) into an isolated layout
        // whose ancestry has no node_modules, then leave the Bun cache empty:
        // the only way "gpt-tokenizer" can resolve is a real install.
        const layoutDir = join(tempRoot, "isolated-layout");
        const cacheDir = join(tempRoot, "bun-global-cache");
        await mkdir(layoutDir, { recursive: true });
        await mkdir(cacheDir, { recursive: true });
        expectNoAncestorNodeModules(layoutDir);

        const build = runBun(
          ["build", "./src/tokens.ts", "--outfile", join(layoutDir, "index.js"), "--target", "bun"],
          serverDir,
          configPath,
        );
        if (build.exitCode !== 0) failWith("standalone tokens build failed", build);

        const probePath = join(layoutDir, "fallback-probe.mjs");
        const probe = [
          'import { countTokens, getTokenizerLoadAttemptsForTest } from "./index.js";',
          `const code = ${JSON.stringify(SAMPLE_CODE)};`,
          "const expected = Math.ceil(code.length / 4);",
          "const got = countTokens(code);",
          "if (got !== expected) {",
          '  throw new Error("fallback mismatch: expected=" + expected + " got=" + got);',
          "}",
          "const attemptsAfterFirst = getTokenizerLoadAttemptsForTest();",
          "if (countTokens(code) !== expected) {",
          '  throw new Error("fallback changed between calls: got=" + countTokens(code));',
          "}",
          "if (getTokenizerLoadAttemptsForTest() !== attemptsAfterFirst) {",
          '  throw new Error("missing dependency was retried: attempts=" + getTokenizerLoadAttemptsForTest());',
          "}",
          "console.log(JSON.stringify({ got, attemptsAfterFirst }));",
        ].join("\n");
        await Bun.write(probePath, probe);
        expectNoAncestorNodeModules(probePath);

        const run = runBun([probePath], layoutDir, configPath, {
          // Absent dependency by construction: no node_modules ancestor, no
          // seeded cache, and the packaged artifact path explicitly off.
          JARVIS_TOKENIZER_PACKAGED: "",
          BUN_INSTALL_CACHE_DIR: cacheDir,
        });
        if (run.exitCode !== 0) failWith("absent-dependency fallback probe failed", run);
        const observed = JSON.parse(
          outputOf(run).trim().split(/\r?\n/).at(-1) ?? "{}",
        ) as { got: number; attemptsAfterFirst: number };
        expect(observed.got).toBe(Math.ceil(SAMPLE_CODE.length / 4));
        expect(observed.attemptsAfterFirst).toBe(1);
      } finally {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    },
    120_000,
  );
});
