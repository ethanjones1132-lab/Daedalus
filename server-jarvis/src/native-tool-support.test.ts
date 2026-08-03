import { describe, expect, test } from "bun:test";
import {
  __resetNativeToolSupportForTests,
  markNativeToolProtocolUnsupported,
  supportsNativeToolsForProvider,
} from "./native-tool-support";

describe("native tool capability cache", () => {
  test("optimistically enables Zen per model until the provider rejects tools", () => {
    __resetNativeToolSupportForTests();
    expect(supportsNativeToolsForProvider("opencode_zen", "model-a")).toBe(true);

    markNativeToolProtocolUnsupported("opencode_zen", "model-a");

    expect(supportsNativeToolsForProvider("opencode_zen", "model-a")).toBe(false);
    expect(supportsNativeToolsForProvider("opencode_zen", "model-b")).toBe(true);
  });

  test("keeps OpenCode Go on its existing conservative protocol", () => {
    expect(supportsNativeToolsForProvider("opencode_go", "model-a")).toBe(false);
  });
});
