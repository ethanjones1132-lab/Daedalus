/**
 * 2026-08-04 (run_085afdac): after mid_loop_handoff the native fallback made
 * zero tool calls. It received the delegate transcript but never a fresh read
 * of the file the delegate had failed to write.
 */
import { describe, expect, test } from "bun:test";
import { selectHandoffSeedPaths, MAX_HANDOFF_SEED_PATHS } from "./delegate-handoff-seed";
import type { ToolCallRecord } from "./stage-output";

const call = (
  name: string,
  args: Record<string, unknown>,
  isError = false,
  output = "",
): ToolCallRecord =>
  ({ name, arguments: args, output, is_error: isError, duration_ms: 0 }) as ToolCallRecord;

describe("selectHandoffSeedPaths", () => {
  test("returns the failed write target", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("edit_file", { path: "C:\\p\\PluginEditor.h" }, true, "no match"),
      ],
      carriedWriteTargets: [],
    });
    expect(paths).toEqual(["C:\\p\\PluginEditor.h"]);
  });

  test("skips targets already read successfully in the delegate stream", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("read_file", { path: "C:\\p\\PluginEditor.h" }, false, "contents"),
        call("edit_file", { path: "C:\\p\\PluginEditor.h" }, true, "no match"),
      ],
      carriedWriteTargets: [],
    });
    expect(paths).toEqual([]);
  });

  test("falls back to carried write targets when no write was attempted", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [call("list_directory", { path: "C:\\p" })],
      carriedWriteTargets: ["C:\\p\\PluginProcessor.cpp"],
    });
    expect(paths).toEqual(["C:\\p\\PluginProcessor.cpp"]);
  });

  test("failed write targets rank before carried targets and dedupe", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("write_file", { path: "C:\\p\\A.cpp" }, true, "denied"),
      ],
      carriedWriteTargets: ["C:\\p\\B.cpp", "C:\\p\\A.cpp"],
    });
    expect(paths).toEqual(["C:\\p\\A.cpp", "C:\\p\\B.cpp"]);
  });

  test("is bounded to MAX_HANDOFF_SEED_PATHS", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [],
      carriedWriteTargets: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(paths.length).toBe(MAX_HANDOFF_SEED_PATHS);
    expect(paths.length).toBe(3);
  });
});
