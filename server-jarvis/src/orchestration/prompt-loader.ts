import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Load a prompt markdown file from the canonical prompts directory.
 *
 * Resolution order (first hit wins):
 *   1. $JARVIS_PROMPTS_DIR / <fileName>      — explicit override
 *   2. <__dirname>/../prompts/<fileName>     — sibling of orchestration/
 *   3. <__dirname>/../../src/prompts/<...>  — bundled source layout
 *   4. <cwd>/server-jarvis/src/prompts/<…>   — dev run from repo root
 *   5. <cwd>/src/prompts/<…>                 — dev run from server-jarvis/
 *   6. Walk up from __dirname to 6 levels, look for server-jarvis/src/prompts/<…>
 *
 * The walk-up (6) is the key robustness fix: when Bun bundles the server
 * (e.g. into a Tauri resource or a release binary), `__dirname` resolves to
 * the bundle's resource directory, not the source layout. The fixed
 * candidate list misses in that case, surfacing a `Prompt file not found`
 * error frame to the user. Walking up the tree until we find a
 * `server-jarvis/src/prompts/` directory means the loader works under
 * bundling, source-mapped dev runs, and direct `bun run` invocations.
 */
export function loadPrompt(fileName: string): string {
  const tried: string[] = [];

  // 1. Explicit override
  if (process.env.JARVIS_PROMPTS_DIR) {
    const p = join(process.env.JARVIS_PROMPTS_DIR, fileName);
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }

  // 2-3. Relative to the source file's directory (works in dev with `bun run src/index.ts`)
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
