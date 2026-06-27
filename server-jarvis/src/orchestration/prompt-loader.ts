import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Load a prompt markdown file from the canonical prompts directory.
 *
 * Resolution order (first hit wins):
 *   1. $JARVIS_PROMPTS_DIR / <fileName>      — explicit override
 *   2. <__dirname>/prompts/<fileName>        — prompts shipped beside the bundle
 *   3. <__dirname>/../prompts/<fileName>     — sibling of orchestration/
 *   4. <__dirname>/../../src/prompts/<...>  — bundled source layout
 *   5. <cwd>/server-jarvis/src/prompts/<…>   — dev run from repo root
 *   6. <cwd>/src/prompts/<…>                 — dev run from server-jarvis/
 *   7. Walk up from __dirname to 6 levels, look for server-jarvis/src/prompts/<…>
 *
 * Candidate (2) is the deployed-bundle case: `bun build` compiles the server to
 * a single `index.js` but does NOT inline the prompt `.md` files (they are read
 * at runtime via readFileSync). When that bundle runs natively next to the app
 * (e.g. `bun.exe <Desktop>/index.js`), `__dirname` is the bundle's directory and
 * there is no `server-jarvis/` source tree anywhere up the ancestry — so the
 * walk-up (7) misses and every orchestrator turn dies with `Prompt file not
 * found: coordinator.md`. Shipping a `prompts/` folder beside `index.js` and
 * checking it first makes the deployed app self-contained.
 *
 * The walk-up (7) is the secondary robustness net: when Bun bundles the server
 * into a Tauri resource directory but the source tree is reachable several levels
 * up, walking until we find a `server-jarvis/src/prompts/` directory means the
 * loader still works under source-mapped dev runs and direct `bun run`.
 */
export function loadPrompt(fileName: string): string {
  const tried: string[] = [];

  // 1. Explicit override
  if (process.env.JARVIS_PROMPTS_DIR) {
    const p = join(process.env.JARVIS_PROMPTS_DIR, fileName);
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }

  // 2. Prompts shipped beside the bundled entry (deployed native install).
  //    `fileName` may be "modes/foo.md", so join() handles the subdir too.
  {
    const p = join(__dirname, "prompts", fileName);
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }

  // 3-4. Relative to the source file's directory (works in dev with `bun run src/index.ts`)
  const relativeCandidates = [
    join(__dirname, "..", "prompts", fileName),
    join(__dirname, "..", "..", "src", "prompts", fileName),
  ];
  for (const p of relativeCandidates) {
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }

  // 4-5. Relative to cwd (works when launching from repo root or server-jarvis/)
  const cwdCandidates = [
    join(process.cwd(), "server-jarvis", "src", "prompts", fileName),
    join(process.cwd(), "src", "prompts", fileName),
  ];
  for (const p of cwdCandidates) {
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }

  // 6. Walk up the tree from __dirname to find a server-jarvis/src/prompts dir.
  //    This is the bundled-binary fallback: when __dirname points at a Bun
  //    resource location, the source tree is several directories up.
  for (let depth = 1; depth <= 6; depth++) {
    const ancestor = join(__dirname, ...Array(depth).fill(".."));
    const candidate = join(ancestor, "server-jarvis", "src", "prompts", fileName);
    tried.push(candidate);
    if (existsSync(candidate)) return readFileSync(candidate, "utf-8");
  }

  throw new Error(
    `Prompt file not found: ${fileName}. Tried paths:\n${tried.join("\n")}\n` +
      `Set JARVIS_PROMPTS_DIR to the prompts directory to override resolution.`,
  );
}
