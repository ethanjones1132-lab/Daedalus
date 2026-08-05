import { describe, expect, test } from "bun:test";
import {
  findFabricatedSymbolsInText,
  preflightWriteTool,
} from "./write-preflight";

describe("findFabricatedSymbolsInText", () => {
  test("catches juce::isnan and bare identifiers", () => {
    const hits = findFabricatedSymbolsInText(
      "if (juce::isnan(x)) return fastClamp(x);",
      ["juce::isnan", "fastClamp", "clampValue"],
    );
    expect(hits).toContain("juce::isnan");
    expect(hits).toContain("fastClamp");
    expect(hits).not.toContain("clampValue");
  });
});

describe("preflightWriteTool", () => {
  test("denies path out of scope", () => {
    const r = preflightWriteTool(
      "write_file",
      { path: "/etc/passwd", content: "x" },
      { pathInScope: false },
    );
    expect(r.allow).toBe(false);
    expect(r.code).toBe("path_out_of_scope");
  });

  test("denies edit when file not read", () => {
    const r = preflightWriteTool(
      "edit_file",
      { path: "a.ts", old_string: "a", new_string: "b" },
      { pathInScope: true, hasBeenRead: false, fileContent: "a\n" },
    );
    expect(r.allow).toBe(false);
    expect(r.code).toBe("not_read");
  });

  test("repairs whitespace-drifted old_string in-process", () => {
    const content = "def f():\n    return now > expires\n";
    const r = preflightWriteTool(
      "edit_file",
      {
        path: "t.py",
        old_string: "    return now > expires   ",
        new_string: "    return now < expires",
      },
      { pathInScope: true, hasBeenRead: true, fileContent: content },
    );
    expect(r.allow).toBe(true);
    expect(r.repair?.arguments.old_string).toBe("    return now > expires");
    expect(r.repair?.notes.length).toBeGreaterThan(0);
  });

  test("blocks write that reintroduces A1-missing symbols", () => {
    const r = preflightWriteTool(
      "write_file",
      {
        path: "PluginProcessor.cpp",
        content: "if (juce::isnan(sample)) sample = 0;\n",
      },
      {
        pathInScope: true,
        missingSymbols: ["juce::isnan", "StateVariableTPTFilterType::notch"],
      },
    );
    expect(r.allow).toBe(false);
    expect(r.code).toBe("fabricated_symbol");
    expect(r.fabricated).toContain("juce::isnan");
  });

  test("allows write when missing symbols are not used", () => {
    const r = preflightWriteTool(
      "write_file",
      {
        path: "PluginProcessor.cpp",
        content: "if (std::isnan(sample)) sample = 0;\n",
      },
      {
        pathInScope: true,
        missingSymbols: ["juce::isnan"],
      },
    );
    expect(r.allow).toBe(true);
    expect(r.code).toBe("ok");
  });

  test("denies multi_edit when every edit misses", () => {
    const r = preflightWriteTool(
      "multi_edit",
      {
        path: "a.ts",
        edits: [{ old_string: "nope", new_string: "x" }],
      },
      { pathInScope: true, hasBeenRead: true, fileContent: "hello\n" },
    );
    expect(r.allow).toBe(false);
    expect(r.code).toBe("multi_edit_empty");
  });

  test("non-write tools always allow", () => {
    const r = preflightWriteTool("read_file", { path: "a.ts" }, { pathInScope: true });
    expect(r.allow).toBe(true);
    expect(r.code).toBe("not_a_write");
  });

  test("allows a missing symbol the task explicitly requests to create", () => {
    const result = preflightWriteTool(
      "write_file",
      {
        path: "src/BrandNewWidget.ts",
        content: "export class BrandNewWidget {}\n",
      },
      {
        pathInScope: true,
        missingSymbols: ["BrandNewWidget"],
        allowedNewSymbols: ["BrandNewWidget"],
      },
    );

    expect(result.allow).toBe(true);
    expect(result.code).toBe("ok");
  });

  test("does not exempt an unrequested fabricated dependency", () => {
    const result = preflightWriteTool(
      "write_file",
      {
        path: "src/BrandNewWidget.ts",
        content: "export class BrandNewWidget extends ImaginaryFrameworkBase {}\n",
      },
      {
        pathInScope: true,
        missingSymbols: ["BrandNewWidget", "ImaginaryFrameworkBase"],
        allowedNewSymbols: ["BrandNewWidget"],
      },
    );

    expect(result.allow).toBe(false);
    expect(result.code).toBe("fabricated_symbol");
    expect(result.fabricated).toEqual(["ImaginaryFrameworkBase"]);
  });

  test("denies a partial multi_edit instead of dropping failed operations", () => {
    const result = preflightWriteTool(
      "multi_edit",
      {
        path: "a.ts",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "missing", new_string: "SHOULD_NOT_DISAPPEAR" },
        ],
      },
      {
        pathInScope: true,
        hasBeenRead: true,
        fileContent: "alpha\nbeta\n",
      },
    );

    expect(result.allow).toBe(false);
    expect(result.code).toBe("multi_edit_partial");
    expect(result.reason).toContain("edit 2: not_found");
    expect(result.repair).toBeUndefined();
  });

  test("an entirely applicable multi_edit preserves count and order", () => {
    const result = preflightWriteTool(
      "multi_edit",
      {
        path: "a.ts",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "beta", new_string: "BETA" },
        ],
      },
      {
        pathInScope: true,
        hasBeenRead: true,
        fileContent: "alpha\nbeta\n",
      },
    );

    expect(result.allow).toBe(true);
    expect(result.repair?.arguments.edits).toEqual([
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "beta", new_string: "BETA" },
    ]);
  });
});
