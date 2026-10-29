import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer";

const serverDir = process.cwd();
const repoRoot = resolve(serverDir, "..");

function runBun(
  args: string[],
  cwd: string,
  configPath: string,
  env?: Record<string, string | undefined>,
) {
  return Bun.spawnSync({
    // Bun 1.3 treats a space-separated `--config <path>` as a no-op that exits 0
    // without running the subcommand. The equals form loads the empty bunfig,
    // which keeps the repo test preload from attaching to these child builds.
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
      throw new Error("isolated output has a node_modules ancestor: " + nodeModulesPath);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

describe("tokenizer production bundle", () => {
  test(
    "counts with the pinned encoder from the shipped layout, offline and lazily",
    async () => {
      const tempRoot = await mkdtemp(join(repoRoot, ".tmp-token-bundle-"));
      const configPath = join(tempRoot, "bunfig.toml");
      await Bun.write(configPath, "");
      try {
        const canonicalDir = join(tempRoot, "canonical");
        const layoutDir = join(tempRoot, "isolated-layout");
        const cacheDir = join(tempRoot, "bun-global-cache");
        await Promise.all([
          mkdir(canonicalDir, { recursive: true }),
          mkdir(layoutDir, { recursive: true }),
          mkdir(cacheDir, { recursive: true }),
        ]);
        expectNoAncestorNodeModules(layoutDir);
        expectNoAncestorNodeModules(canonicalDir);

        const canonicalBuild = runBun(
          [
            "build",
            "./src/index.ts",
            "--outdir",
            canonicalDir,
            "--target",
            "bun",
            "--define",
            'process.env.JARVIS_TOKENIZER_PACKAGED="true"',
          ],
          serverDir,
          configPath,
        );
        if (canonicalBuild.exitCode !== 0) {
          throw new Error("canonical entry build failed:\n" + outputOf(canonicalBuild));
        }
        const canonicalEntry = await readFile(join(canonicalDir, "index.js"));
        expect(canonicalEntry.byteLength).toBeLessThan(2_000_000);

        const artifactBuild = runBun(
          [
            "build",
            "./src/tokenizer-entry.ts",
            "--outfile",
            join(layoutDir, "tokenizer.cjs"),
            "--target",
            "bun",
            "--format",
            "cjs",
          ],
          serverDir,
          configPath,
        );
        if (artifactBuild.exitCode !== 0) {
          throw new Error("tokenizer artifact build failed:\n" + outputOf(artifactBuild));
        }

        const tokenModuleBuild = runBun(
          [
            "build",
            "./src/tokens.ts",
            "--outfile",
            join(layoutDir, "index.js"),
            "--target",
            "bun",
            "--define",
            'process.env.JARVIS_TOKENIZER_PACKAGED="true"',
          ],
          serverDir,
          configPath,
        );
        if (tokenModuleBuild.exitCode !== 0) {
          throw new Error("token module build failed:\n" + outputOf(tokenModuleBuild));
        }

        // This cache copy is deliberately outside the resolution tree. It gives
        // the child a populated Bun cache path while --no-install forbids Bun
        // from using it to satisfy an uninstalled package import.
        const cachedPackage = join(cacheDir, "gpt-tokenizer@3.4.0@@@1");
        await mkdir(cachedPackage, { recursive: true });
        await Bun.write(
          join(cachedPackage, "package.json"),
          JSON.stringify({ name: "gpt-tokenizer", version: "3.4.0", main: "index.js" }),
        );
        await Bun.write(join(cachedPackage, "index.js"), "module.exports = { encode: () => [1] };");
        expect(existsSync(join(cachedPackage, "package.json"))).toBe(true);

        const code =
          "function add(a: number, b: number): number {\n  return a + b;\n}\n".repeat(15);
        const nonAscii = "🦊 café 你好 नमस्ते".repeat(25);
        const expectedCode = Math.ceil(encode(code).length * 1.1);
        const expectedNonAscii = Math.ceil(encode(nonAscii).length * 1.1);
        const probe = [
          'import { countTokens, getTokenizerLoadAttemptsForTest } from "./index.js";',
          "const code = " + JSON.stringify(code) + ";",
          "const nonAscii = " + JSON.stringify(nonAscii) + ";",
          "const before = getTokenizerLoadAttemptsForTest();",
          "const codeCount = countTokens(code);",
          "const afterFirst = getTokenizerLoadAttemptsForTest();",
          "const nonAsciiCount = countTokens(nonAscii);",
          "const afterSecond = getTokenizerLoadAttemptsForTest();",
          "if (before !== 0 || afterFirst !== 1 || afterSecond !== afterFirst) {",
          "  throw new Error(JSON.stringify({ before, afterFirst, afterSecond }));",
          "}",
          "console.log(JSON.stringify({ codeCount, nonAsciiCount, afterFirst, afterSecond }));",
        ].join("\n");
        const probePath = join(layoutDir, "probe.mjs");
        await Bun.write(probePath, probe);
        expectNoAncestorNodeModules(probePath);

        const isolatedEnv = {
          BUN_CONFIG_NO_INSTALL: "1",
          BUN_INSTALL_CACHE_DIR: cacheDir,
        };
        const isolatedRun = runBun(
          [probePath],
          layoutDir,
          configPath,
          isolatedEnv,
        );
        if (isolatedRun.exitCode !== 0) {
          throw new Error("isolated shipped-layout probe failed:\n" + outputOf(isolatedRun));
        }
        const resultLine = new TextDecoder()
          .decode(isolatedRun.stdout)
          .trim()
          .split(/\r?\n/)
          .at(-1);
        const observed = JSON.parse(resultLine ?? "{}") as {
          codeCount: number;
          nonAsciiCount: number;
          afterFirst: number;
          afterSecond: number;
        };
        expect(observed.codeCount).toBe(expectedCode);
        expect(observed.nonAsciiCount).toBe(expectedNonAscii);
        expect(observed.afterFirst).toBe(1);
        expect(observed.afterSecond).toBe(observed.afterFirst);

        const rejectedProbe = join(layoutDir, "rejected-require.mjs");
        await Bun.write(
          rejectedProbe,
          [
            'import { createRequire } from "node:module";',
            "function countTokens(text) {",
            '  const { encode } = createRequire(import.meta.url)("gpt-tokenizer");',
            "  return encode(text).length;",
            "}",
            'console.log(countTokens("function add(a: number) { return a + 1; }"));',
          ].join("\n"),
        );
        const rejectedRun = runBun(
          [rejectedProbe],
          layoutDir,
          configPath,
          isolatedEnv,
        );
        expect(rejectedRun.exitCode).not.toBe(0);
        expect(outputOf(rejectedRun)).toContain("gpt-tokenizer");
      } finally {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    },
    120_000,
  );

  test("keeps the tokenizer in the scoped offline packaging and copy paths", async () => {
    const [
      buildFrontend,
      packageJsonText,
      tauriText,
      deployScript,
      releaseBuild,
    ] = await Promise.all([
      readFile(join(serverDir, "src", "build-frontend.ts"), "utf8"),
      readFile(join(serverDir, "package.json"), "utf8"),
      readFile(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
      readFile(join(repoRoot, "scripts", "build-and-deploy.ps1"), "utf8"),
      readFile(join(repoRoot, "scripts", "release-build.ps1"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText);
    const tauri = JSON.parse(tauriText);

    expect(buildFrontend).toContain("./src/tokenizer-entry.ts");
    expect(buildFrontend).toContain("./dist/tokenizer.cjs");
    expect(packageJson.scripts.build).toContain("build-frontend.ts");
    expect(tauri.bundle.resources["../server-jarvis/dist/tokenizer.cjs"]).toBe("tokenizer.cjs");
    expect(deployScript).toContain("Deploy-File $distTokenizer 'tokenizer.cjs'");
    expect(deployScript).toContain("tokenizer_js_sha256");
    expect(releaseBuild).toContain("dist\\tokenizer.cjs");
    expect(releaseBuild).toContain("role = 'tokenizer'");
  });
});
