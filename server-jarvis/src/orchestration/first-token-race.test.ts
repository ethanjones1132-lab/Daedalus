import { describe, expect, test } from "bun:test";
import { raceFirstToken } from "./first-token-race";

function launcher(id: string, firstTokenMs: number, opts: { fail?: boolean } = {}) {
  return (signal: AbortSignal) =>
    new Promise<{ id: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (opts.fail) reject(new Error(`${id} failed`));
        else resolve({ id });
      }, firstTokenMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
}

describe("raceFirstToken", () => {
  test("returns the fastest candidate", async () => {
    const result = await raceFirstToken([
      { id: "slow", launch: launcher("slow", 60) },
      { id: "fast", launch: launcher("fast", 10) },
    ]);
    expect(result.winnerId).toBe("fast");
    expect(result.value).toEqual({ id: "fast" });
  });

  test("aborts the losers", async () => {
    const aborted: string[] = [];
    await raceFirstToken([
      { id: "fast", launch: launcher("fast", 10) },
      {
        id: "slow",
        launch: (signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted.push("slow");
              reject(new Error("aborted"));
            });
          }),
      },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toEqual(["slow"]);
  });

  test("a failing candidate does not sink the race", async () => {
    const result = await raceFirstToken([
      { id: "broken", launch: launcher("broken", 5, { fail: true }) },
      { id: "good", launch: launcher("good", 40) },
    ]);
    expect(result.winnerId).toBe("good");
  });

  test("rejects only when every candidate fails", async () => {
    await expect(
      raceFirstToken([
        { id: "a", launch: launcher("a", 5, { fail: true }) },
        { id: "b", launch: launcher("b", 10, { fail: true }) },
      ]),
    ).rejects.toThrow();
  });

  test("a single candidate is passed through without racing overhead", async () => {
    const result = await raceFirstToken([{ id: "only", launch: launcher("only", 5) }]);
    expect(result.winnerId).toBe("only");
    expect(result.raced).toBe(false);
  });
});
