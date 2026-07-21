import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEEP_READ_MIN_CONTENT_READS } from "./evidence-sufficiency";

describe("executor prompt contract", () => {
  test("pins stage-ending and research-depth contract text", () => {
    const prompt = readFileSync(join(import.meta.dir, "..", "prompts", "modes", "executor.md"), "utf8");

    expect(prompt).toContain("Ending your turn ends the stage");
    expect(prompt).toContain("only stop when tasks are DONE/BLOCKED and evidence covers the request");
    expect(prompt).toContain("Research-depth contract");
    expect(prompt).toContain(`>=${DEEP_READ_MIN_CONTENT_READS} distinct source-file reads`);
    expect(prompt).toContain("listings/manifests do not count");
    expect(prompt).toContain("never repeat a call");
    // Tool names are no longer hand-listed in the prose (P2.4) — they are
    // rendered from the live registry via this marker, so `grep` and every
    // other tool appear in the resolved prompt without drifting here.
    // tool-guidelines.test.ts pins that the marker expands to the real tools.
    expect(prompt).toContain("{{TOOL_GUIDELINES}}");
    expect(prompt).not.toContain("search_files");
    expect(prompt).not.toContain("`patch`");
    expect(prompt).not.toContain("`terminal`");
    expect(prompt).not.toContain("web_extract");
    expect(prompt).not.toContain("browser_");
    expect(prompt).not.toContain("delegate_task");
    expect(prompt).not.toContain("reasoning without a tool call is fine");
  });
});
