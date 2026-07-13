// server-jarvis/src/orchestration/pipeline-preflight.test.ts
import { describe, expect, test } from "bun:test";
import { partitionToolCalls, selectAnchorFiles } from "./pipeline";

describe("selectAnchorFiles", () => {
  test("picks known anchors from a directory listing, capped at 5", () => {
    const listing = ["src/", "package.json", "README.md", "tsconfig.json", "eas.json", "app.json", "Cargo.toml"];
    const anchors = selectAnchorFiles(listing);
    expect(anchors).toContain("package.json");
    expect(anchors).toContain("README.md");
    expect(anchors.length).toBeLessThanOrEqual(5);
  });
  test("returns empty for a listing with no anchors", () => {
    expect(selectAnchorFiles(["photos/", "video.mp4"])).toEqual([]);
  });
});

describe("partitionToolCalls", () => {
  const call = (name: string, i: number) => ({ name, id: `c${i}` });

  test("read-only calls form parallel batches; writes are serial barriers in order", () => {
    const batches = partitionToolCalls([
      call("read_file", 0), call("grep", 1), call("write_file", 2), call("read_file", 3), call("edit_file", 4),
    ]);
    expect(batches.map((b) => b.map((c) => c.name))).toEqual([
      ["read_file", "grep"],
      ["write_file"],
      ["read_file"],
      ["edit_file"],
    ]);
  });

  test("all-read input is a single batch", () => {
    const batches = partitionToolCalls([call("read_file", 0), call("glob", 1), call("list_directory", 2)]);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(3);
  });

  test("all-write input is one barrier per call", () => {
    const batches = partitionToolCalls([call("write_file", 0), call("write_file", 1)]);
    expect(batches.length).toBe(2);
  });

  test("empty input yields no batches", () => {
    expect(partitionToolCalls([])).toEqual([]);
  });
});
