import { describe, expect, test, beforeEach } from "bun:test";
import {
  __clearModelToolFormatsForTests,
  __resetModelToolFormatsForTests,
  detectTextToolFormat,
  getModelToolFormat,
  listModelToolFormats,
  observeModelToolFormatFromTurn,
  recordModelToolFormat,
  seedModelToolFormats,
} from "./model-tool-format";

describe("model-tool-format (W3.3)", () => {
  beforeEach(() => {
    __resetModelToolFormatsForTests();
  });

  test("seeds document minimax as native and free pool as text_xml", () => {
    expect(getModelToolFormat("minimax-m3")).toBe("native");
    expect(getModelToolFormat("cohere/north-mini-code:free")).toBe("text_xml");
    expect(getModelToolFormat("never-seen-model")).toBe("unknown");
  });

  test("detectTextToolFormat classifies DSML (fullwidth and ASCII)", () => {
    const fw = "\uFF5C";
    expect(
      detectTextToolFormat(
        `<${fw}DSML${fw}invoke name="read_file"><${fw}DSML${fw}parameter name="path">a.md</${fw}DSML${fw}parameter></${fw}DSML${fw}invoke>`,
      ),
    ).toBe("dsml");
    expect(
      detectTextToolFormat(
        `<|DSML|invoke name="write_file"><|DSML|parameter name="path">a.md</|DSML|parameter></|DSML|invoke>`,
      ),
    ).toBe("dsml");
  });

  test("detectTextToolFormat classifies <tool_call> as text_xml", () => {
    expect(
      detectTextToolFormat(
        `<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>`,
      ),
    ).toBe("text_xml");
  });

  test("detectTextToolFormat returns null for plain prose", () => {
    expect(detectTextToolFormat("Just thinking, no tools.")).toBeNull();
  });

  test("observe records native when native calls are present", () => {
    __clearModelToolFormatsForTests();
    expect(
      observeModelToolFormatFromTurn({
        model: "vendor/new-native",
        nativeCallCount: 1,
        fullText: "",
        textParseFoundCalls: false,
      }),
    ).toBe("native");
    expect(getModelToolFormat("vendor/new-native")).toBe("native");
  });

  test("observe records dsml when text parse succeeds with DSML content", () => {
    __clearModelToolFormatsForTests();
    const text =
      `<|DSML|invoke name="read_file"><|DSML|parameter name="path">x.md</|DSML|parameter></|DSML|invoke>`;
    expect(
      observeModelToolFormatFromTurn({
        model: "vendor/dsml-model",
        nativeCallCount: 0,
        fullText: text,
        textParseFoundCalls: true,
      }),
    ).toBe("dsml");
    expect(getModelToolFormat("vendor/dsml-model")).toBe("dsml");
  });

  test("observe records text_xml for <tool_call> dialect", () => {
    __clearModelToolFormatsForTests();
    const text =
      `<tool_call>{"name":"write_file","arguments":{"path":"a.md","content":"hi"}}</tool_call>`;
    expect(
      observeModelToolFormatFromTurn({
        model: "vendor/xml-model",
        nativeCallCount: 0,
        fullText: text,
        textParseFoundCalls: true,
      }),
    ).toBe("text_xml");
    expect(getModelToolFormat("vendor/xml-model")).toBe("text_xml");
  });

  test("native observation overrides a prior text seed for that model", () => {
    recordModelToolFormat("flip-model", "text_xml");
    observeModelToolFormatFromTurn({
      model: "flip-model",
      nativeCallCount: 2,
      fullText: "",
      textParseFoundCalls: false,
    });
    expect(getModelToolFormat("flip-model")).toBe("native");
  });

  test("seedModelToolFormats is merge-only and does not overwrite live observations", () => {
    __clearModelToolFormatsForTests();
    recordModelToolFormat("minimax-m3", "dsml");
    seedModelToolFormats();
    expect(getModelToolFormat("minimax-m3")).toBe("dsml");
    // Missing seed still applied for other models.
    expect(getModelToolFormat("deepseek-v4-flash")).toBe("native");
  });

  test("listModelToolFormats returns sorted snapshot", () => {
    const list = listModelToolFormats();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((e) => e.model === "minimax-m3" && e.format === "native")).toBe(true);
    const models = list.map((e) => e.model);
    expect(models).toEqual([...models].sort((a, b) => a.localeCompare(b)));
  });

  test("empty model id is unknown and not recorded", () => {
    expect(getModelToolFormat("")).toBe("unknown");
    expect(
      observeModelToolFormatFromTurn({
        model: "  ",
        nativeCallCount: 1,
        textParseFoundCalls: false,
      }),
    ).toBe("unknown");
  });
});
