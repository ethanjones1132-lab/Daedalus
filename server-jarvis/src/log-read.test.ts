import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LOG_TAIL_LIMIT_DEFAULT, LOG_TAIL_LIMIT_MAX, type LogLine } from "./log-tail";
import { logReadResponse, readLogTail } from "./log-read";

// A real file on a real filesystem. The reader is the one part of this read that
// touches `fs`, and it is the part whose failure modes matter: a file that is not
// there, a file that cannot be opened, and a file large enough that reading it
// whole would be the wrong thing to do. Mocking `fs` would have asserted the mock.

const ISO = "2026-09-26T09:12:33.123Z";
const selfLine = (level: string, text: string) => `${ISO} ${level} ${text}\n`;

let dir = "";
let logPath = "";
let missingPath = "";
let directoryPath = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-log-read-"));
  logPath = join(dir, "server-jarvis.self.log");
  missingPath = join(dir, "never-written.log");
  directoryPath = join(dir, "a-directory.log");
  mkdirSync(directoryPath);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function write(text: string): void {
  writeFileSync(logPath, text);
}

function texts(lines: LogLine[]): string[] {
  return lines.map((line) => line.text);
}

describe("readLogTail on a file that exists", () => {
  it("returns the log the writer wrote, newest last", () => {
    write([selfLine("INFO", "first"), selfLine("WARN", "second"), selfLine("ERROR", "third")].join(""));
    const result = readLogTail(logPath, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The payload names the file it read, not where it lives: the log directory
    // is under the operator's home, and a path in a response body is the store
    // detail the UI's read-error rule exists to withhold.
    expect(result.tail.source).toBe("server-jarvis.self.log");
    expect(result.tail.format).toBe("self-log");
    expect(result.tail.truncated).toBe(false);
    expect(texts(result.tail.lines)).toEqual(["first", "second", "third"]);
    expect(result.tail.lines.map((line) => line.level)).toEqual(["INFO", "WARN", "ERROR"]);
  });

  it("keeps a final line with no trailing newline, because that is the newest entry", () => {
    write(`${selfLine("INFO", "settled")}${selfLine("ERROR", "mid-write")}`);
    const result = readLogTail(logPath, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(texts(result.tail.lines)).toEqual(["settled", "mid-write"]);
    expect(result.tail.truncated).toBe(false);
  });

  it("reports a confirmed empty file as an empty tail rather than a failure", () => {
    write("");
    const result = readLogTail(logPath, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tail.lines).toEqual([]);
    expect(result.tail.truncated).toBe(false);
  });

  it("returns the newest lines of a longer log and says the read was truncated", () => {
    write(["one", "two", "three", "four", "five"].map((t) => selfLine("INFO", t)).join(""));
    const result = readLogTail(logPath, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(texts(result.tail.lines)).toEqual(["four", "five"]);
    // The only case in which a consumer may call this count the file's.
    expect(result.tail.truncated).toBe(true);
    expect(result.tail.limit).toBe(2);
  });

  it("reads the trailing window of a log larger than that window, not the whole file", () => {
    // Nine lines of 1040 bytes each: a 9,360-byte file read through a 3,000-byte
    // window starts 120 bytes into line 7, so the read can see the whole of lines
    // 8 and 9 and the fragment of line 7. If it did not tail, all nine would come
    // back; if it tailed without dropping the fragment, the first line would be a
    // partial one.
    const filler = "x".repeat(1000);
    write([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => selfLine("INFO", `oldest-${n}-${filler}`)).join(""));
    const result = readLogTail(logPath, 200, 3000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tail.truncated).toBe(true);
    expect(result.tail.lines).toHaveLength(2);
    expect(result.tail.lines.at(-1)!.text).toBe(`oldest-9-${filler}`);
    for (const line of result.tail.lines) expect(line.text.startsWith("oldest-")).toBe(true);
  });

  it("keeps the newest whole line when the window holds only one line", () => {
    const filler = "y".repeat(4000);
    write([selfLine("INFO", `ancient-${filler}`), selfLine("ERROR", `newest-${filler}`)].join(""));
    const result = readLogTail(logPath, 200, 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tail.truncated).toBe(true);
    expect(result.tail.lines).toHaveLength(1);
    expect(result.tail.lines[0].text).toBe(`newest-${filler}`);
  });

  it("answers a limit at or below zero with the default, never with an empty log", () => {
    write(["a", "b", "c"].map((t) => selfLine("INFO", t)).join(""));
    for (const requested of [0, -1, Number.NaN]) {
      const result = readLogTail(logPath, requested);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.tail.limit).toBe(LOG_TAIL_LIMIT_DEFAULT);
      expect(result.tail.lines).toHaveLength(3);
    }
  });

  it("answers the limit the way a query parameter delivers it", () => {
    write(["a", "b", "c", "d"].map((t) => selfLine("INFO", t)).join(""));
    const requested = readLogTail(logPath, "2");
    expect(requested.ok && requested.tail.lines).toHaveLength(2);
    expect(requested.ok && requested.tail.truncated).toBe(true);
    // `?limit=` and `?limit=abc` are a client with no limit, not a client asking
    // for no log. Only a real 0 could have meant that, and it is refused too.
    for (const value of ["", "abc", "0"]) {
      const result = readLogTail(logPath, value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.tail.limit).toBe(LOG_TAIL_LIMIT_DEFAULT);
      expect(result.tail.lines).toHaveLength(4);
    }
  });

  it("clamps a limit above its own cap rather than serving what the client asked for", () => {
    write(["a", "b"].map((t) => selfLine("INFO", t)).join(""));
    const result = readLogTail(logPath, 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tail.limit).toBe(LOG_TAIL_LIMIT_MAX);
  });

  it("follows a log that is being appended to, without caching the first read", () => {
    write(selfLine("INFO", "one"));
    const first = readLogTail(logPath, 10);
    write([selfLine("INFO", "one"), selfLine("INFO", "two")].join(""));
    const second = readLogTail(logPath, 10);
    expect(first.ok && texts(first.tail.lines)).toEqual(["one"]);
    expect(second.ok && texts(second.tail.lines)).toEqual(["one", "two"]);
  });
});

describe("readLogTail on a file that cannot be read", () => {
  it("answers a file that is not there as a missing read, not as an empty log", () => {
    const result = readLogTail(missingPath, 10);
    expect(result).toEqual({ ok: false, failure: "missing" });
    expect(result.ok).toBe(false);
  });

  it("answers a path that cannot be opened as an unreadable read", () => {
    // A directory stands in for a file the OS will not hand over: `stat` accepts
    // it and the read itself fails, which is the shape a permission failure has.
    const result = readLogTail(directoryPath, 10);
    expect(result).toEqual({ ok: false, failure: "unreadable" });
  });

  it("never answers a failure with a body a client could read as lines", async () => {
    for (const path of [missingPath, directoryPath]) {
      const response = logReadResponse(readLogTail(path, 10));
      expect(response.ok).toBe(false);
      const body = (await response.json()) as { ok: boolean; lines?: unknown };
      expect(body.ok).toBe(false);
      expect(body.lines).toBeUndefined();
    }
  });
});

describe("logReadResponse", () => {
  it("answers a confirmed read with 200 and the tail", async () => {
    write(selfLine("INFO", "ok"));
    const response = logReadResponse(readLogTail(logPath, 10));
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; lines: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.lines).toHaveLength(1);
  });

  it("names the failure in the body for a developer, without the reason in it", async () => {
    const response = logReadResponse(readLogTail(missingPath, 10));
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, failure: "missing" });
  });

  it("never leaks the path it tried to read into the response", async () => {
    const response = logReadResponse(readLogTail(missingPath, 10));
    const text = await response.text();
    expect(text).not.toContain(dir);
    expect(text).not.toContain(missingPath);
  });
});
