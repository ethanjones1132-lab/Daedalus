// server-jarvis/src/orchestration/pipeline-preflight.test.ts
import { describe, expect, test } from "bun:test";
import { selectAnchorFiles } from "./pipeline";

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
