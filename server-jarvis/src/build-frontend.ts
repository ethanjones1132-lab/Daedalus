/**
 * Build the artifacts Tauri bundles into the desktop app.
 *
 * Two outputs:
 *   1. `server-jarvis/dist/index.js` — the Bun server, and
 *   2. `server-jarvis/dist/mcp-stdio-server.js` — the standalone MCP stdio
 *      sidecar the Claude delegate launches.
 * plus the UI bundle at `src-ui/dist`, which Tauri embeds as frontendDist.
 *
 * ## Why this exists
 *
 * Tauri runs `beforeBuildCommand` immediately before it compiles the app,
 * and the old value of that command rebuilt `index.js` *without* the build
 * identity:
 *
 *     cd server-jarvis && bun build ./src/index.ts --outdir ./dist --target bun
 *
 * That silently undid the provenance bake. `scripts/build-and-deploy.ps1`
 * bakes the git SHA into the bundle with `bun build --define`, but a
 * `cargo tauri build` afterwards replaced the same file with a build that
 * reads the environment at runtime — so the *installed* app reported
 * `git_sha: "dev"` and `/health` could not distinguish it from any other
 * build. That is the 2026-07 stale-bundle incident, one `cargo tauri build`
 * away.
 *
 * So the identity is now passed in through the environment and folded in
 * here, in one place:
 *
 *   JARVIS_BUILD_GIT_SHA             -> process.env.JARVIS_GIT_SHA
 *   JARVIS_BUILD_BUILT_AT            -> process.env.JARVIS_BUILT_AT
 *   JARVIS_BUILD_GIT_DIRTY           -> process.env.JARVIS_GIT_DIRTY
 *   JARVIS_BUILD_SOURCE_TREE_SHA256  -> process.env.JARVIS_SOURCE_TREE_SHA256
 *
 * `scripts/release-build.ps1` computes those values (the source-tree digest
 * is SHA-256 over the source roots and must be computed identically by
 * every producer and verifier, so it lives in
 * `scripts/lib/release-common.ps1`) and sets them before invoking
 * `cargo tauri build`. A developer running `cargo tauri build` directly
 * sets none of them, and the bundle falls back to `"dev"` exactly as it
 * did before.
 *
 * This script is the only place the bundle build is described, so the
 * PowerShell quoting trap that used to live in build-and-deploy.ps1 does
 * not need to be reproduced here: bun receives its argv directly, with no
 * shell in between to eat the quotes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const uiDir = join(repoRoot, "src-ui");

function step(message: string): void {
  console.log(`\n=== ${message} ===`);
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "signal"}`);
  }
}

/**
 * The `--define` arguments that fold the build identity into the bundle.
 *
 * bun replaces the member expression `process.env.JARVIS_GIT_SHA` with the
 * literal that follows it, so the value is written as a JS string literal
 * (with real double quotes). A bare identifier would fold to a ReferenceError
 * at module load, and bun still exits 0 in that case — which is why the
 * release build asserts the fold afterwards rather than trusting the exit
 * code.
 */
function buildDefines(): string[] {
  const mapping: Array<[string, string | undefined]> = [
    ["process.env.JARVIS_GIT_SHA", process.env.JARVIS_BUILD_GIT_SHA],
    ["process.env.JARVIS_BUILT_AT", process.env.JARVIS_BUILD_BUILT_AT],
    ["process.env.JARVIS_GIT_DIRTY", process.env.JARVIS_BUILD_GIT_DIRTY],
    ["process.env.JARVIS_SOURCE_TREE_SHA256", process.env.JARVIS_BUILD_SOURCE_TREE_SHA256],
  ];
  const defines: string[] = [];
  for (const [expression, value] of mapping) {
    if (value === undefined || value === "") continue;
    defines.push(`${expression}="${value}"`);
  }
  return defines;
}

function buildServerBundle(): void {
  step("Building server bundle (bun)");
  const defines = buildDefines();
  if (defines.length === 0) {
    console.log("  no build identity in the environment - the bundle will report git_sha 'dev'.");
  } else {
    for (const define of defines) {
      console.log(`  define ${define.split("=")[0]}`);
    }
  }

  run(
    "bun",
    [
      "build",
      "./src/tokenizer-entry.ts",
      "--outfile",
      "./dist/tokenizer.cjs",
      "--target",
      "bun",
      "--format",
      "cjs",
    ],
    serverDir,
  );

  const defineArgs = defines.flatMap((define) => ["--define", define]);
  run(
    "bun",
    [
      "build",
      "./src/index.ts",
      "--outdir",
      "./dist",
      "--target",
      "bun",
      ...defineArgs,
      "--define",
      'process.env.JARVIS_TOKENIZER_PACKAGED="true"',
    ],
    serverDir,
  );
  run(
    "bun",
    [
      "build",
      "./src/mcp-stdio-server.ts",
      "--outdir",
      "./dist",
      "--target",
      "bun",
      "--outfile",
      "./dist/mcp-stdio-server.js",
    ],
    serverDir,
  );

  const indexJs = join(serverDir, "dist", "index.js");
  const tokenizerCjs = join(serverDir, "dist", "tokenizer.cjs");
  const mcpJs = join(serverDir, "dist", "mcp-stdio-server.js");
  if (!existsSync(indexJs)) throw new Error("server bundle not produced at " + indexJs);
  if (!existsSync(tokenizerCjs)) throw new Error("tokenizer bundle not produced at " + tokenizerCjs);
  if (!existsSync(mcpJs)) throw new Error("mcp-stdio-server bundle not produced at " + mcpJs);
  const indexBytes = statSync(indexJs).size;
  if (indexBytes >= 2_000_000) {
    throw new Error("server entry is " + indexBytes + " bytes; expected less than 2,000,000");
  }
  console.log("  [OK] server bundle -> server-jarvis/dist/index.js (" + indexBytes + " bytes)");
  console.log("  [OK] lazy tokenizer -> server-jarvis/dist/tokenizer.cjs");
  console.log("  [OK] mcp-stdio-server -> server-jarvis/dist/mcp-stdio-server.js");
}

function buildUi(): void {
  step("Building UI");
  if (!existsSync(join(uiDir, "node_modules"))) {
    throw new Error(
      "src-ui/node_modules is missing. Install it first: `npm ci` (src-ui ships package-lock.json) " +
        "or `bun install`.",
    );
  }

  // src-ui ships package-lock.json, so npm is its package manager; bun is
  // accepted as a fallback because the repo's quick start uses it.
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
  if (process.platform === "win32") {
    run("cmd", ["/c", "npm", "run", "build"], uiDir);
  } else {
    run(npmCommand, ["run", "build"], uiDir);
  }
  if (!existsSync(join(uiDir, "dist"))) {
    // npm failed but did not report a non-zero status (some Windows shims
    // swallow it) - fall back to bun before giving up.
    console.log("  npm build produced no dist/ - retrying with bun");
    run(bunCommand, ["run", "build"], uiDir);
  }
  if (!existsSync(join(uiDir, "dist"))) {
    throw new Error("UI build produced no src-ui/dist");
  }
  console.log("  [OK] UI -> src-ui/dist");
}

try {
  buildServerBundle();
  if (!process.argv.includes("--server-only")) {
    buildUi();
    console.log("\nFrontend artifacts built.");
  } else {
    console.log("\nServer artifacts built.");
  }
} catch (error) {
  console.error(`\n[FAILED] ${(error as Error).message}`);
  process.exitCode = 1;
}
