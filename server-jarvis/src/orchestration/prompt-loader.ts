import { readFileSync, existsSync } from "fs";
import { join } from "path";

export function loadPrompt(fileName: string): string {
  const possiblePaths = [
    join(__dirname, "../prompts", fileName),
    join(__dirname, "../../src/prompts", fileName),
    join(process.cwd(), "src/prompts", fileName),
    join(process.cwd(), "server-jarvis/src/prompts", fileName),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }
  throw new Error(`Prompt file not found: ${fileName}. Tried paths:\n${possiblePaths.join("\n")}`);
}
