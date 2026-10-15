import { describe, expect, it } from "bun:test";
import {
  LOG_READ_FAILURE_STATUS,
  LOG_TAIL_FORMAT,
  LOG_TAIL_LIMIT_DEFAULT,
  LOG_TAIL_LIMIT_MAX,
  LOG_TAIL_READ_BYTES,
  buildLogTail,
  logLineCount,
  parseSelfLogLine,
  resolveLogLimit,
  tailLogLines,
  tailReadStart,
} from "./log-tail";

// The self-log's own line shape, verbatim from self-log.ts `formatLine`:
// `${new Date().toISOString()} ${level} ${text}\n`, with the level one of
// INFO / WARN / ERROR. Everything below is built from that writer, not from a
// shape a reader wished the file had.

const ISO = "2026-09-26T09:12:33.123Z";

function selfLine(level: string, text: string): string {
  return `${ISO} ${level} ${text}`;
}

describe("resolveLogLimit", () => {
  it("uses the default when the caller asked for nothing usable", () => {
    // A limit of zero is not a request to read no log. Answering `ok: true`
    // with zero lines would be the one thing this read must never do: a
    // confirmed empty log. An absent, unparseable, zero or negative limit is
    // the caller not having a limit, so it gets the default.
    expect(resolveLogLimit(undefined)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    expect(resolveLogLimit(null)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    expect(resolveLogLimit(0)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    expect(resolveLogLimit(-5)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    expect(resolveLogLimit(Number.NaN)).toBe(LOG_TAIL_LIMIT_DEFAULT);
  });

  it("refuses a non-integer or non-finite limit the same way", () => {
    expect(resolveLogLimit(12.7)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    expect(resolveLogLimit(Number.POSITIVE_INFINITY)).toBe(LOG_TAIL_LIMIT_DEFAULT);
  });

  it("caps a limit above the server's own hard cap rather than trusting it", () => {
    // The cap is the server's, not the client's: a caller that asks for a
    // million lines gets the cap, because the cap is what makes a read of an
    // append-only log bounded rather than a way to pull the file into memory.
    expect(resolveLogLimit(LOG_TAIL_LIMIT_MAX + 1)).toBe(LOG_TAIL_LIMIT_MAX);
    expect(resolveLogLimit(1_000_000)).toBe(LOG_TAIL_LIMIT_MAX);
    expect(LOG_TAIL_LIMIT_MAX).toBeLessThan(1_000_000);
  });

  it("keeps a usable limit exactly as asked", () => {
    expect(resolveLogLimit(1)).toBe(1);
    expect(resolveLogLimit(37)).toBe(37);
    expect(resolveLogLimit(LOG_TAIL_LIMIT_MAX)).toBe(LOG_TAIL_LIMIT_MAX);
  });

  it("reads the limit the way it arrives, as a query parameter", () => {
    expect(resolveLogLimit("50")).toBe(50);
    expect(resolveLogLimit(" 50 ")).toBe(50);
    expect(resolveLogLimit("1")).toBe(1);
  });

  it("treats a limit that is not a number as no limit at all", () => {
    // `?limit=abc` is a client that did not state a limit, not a client that
    // asked for something strange. And an empty query value is the same request
    // as an absent one, which `Number` alone would have read as a zero.
    for (const requested of ["", "   ", "abc", "12.7", "0", "-3", "NaN", "Infinity"]) {
      expect(resolveLogLimit(requested)).toBe(LOG_TAIL_LIMIT_DEFAULT);
    }
  });

  it("clamps a limit that arrives as a string above its own cap", () => {
    expect(resolveLogLimit("100000")).toBe(LOG_TAIL_LIMIT_MAX);
  });
});

describe("tailReadStart", () => {
  it("reads nothing before the file begins", () => {
    expect(tailReadStart(0, LOG_TAIL_READ_BYTES)).toBe(0);
    expect(tailReadStart(10, LOG_TAIL_READ_BYTES)).toBe(0);
    expect(tailReadStart(LOG_TAIL_READ_BYTES, LOG_TAIL_READ_BYTES)).toBe(0);
  });

  it("reads only the trailing window of a file larger than it", () => {
    expect(tailReadStart(LOG_TAIL_READ_BYTES + 1, LOG_TAIL_READ_BYTES)).toBe(1);
    expect(tailReadStart(4096, 1024)).toBe(3072);
  });

  it("never reports a negative offset, whatever it is handed", () => {
    expect(tailReadStart(-99, LOG_TAIL_READ_BYTES)).toBe(0);
    // A window of nothing reads nothing, from the end of the file. The route
    // always passes LOG_TAIL_READ_BYTES; this pins that a smaller constant
    // cannot produce a negative read length at the `fs` call.
    expect(tailReadStart(100, 0)).toBe(100);
    expect(tailReadStart(100, -1)).toBe(100);
  });
});

describe("tailLogLines", () => {
  it("returns nothing for an empty file, which is a confirmed empty read", () => {
    // An empty file is not a failure and not a lie: the writer exists, the read
    // succeeded, and the file held no lines. The route reports it as `ok: true`
    // with zero lines and `truncated: false`, which the UI states as a real `0`.
    expect(tailLogLines("", 10)).toEqual([]);
    expect(tailLogLines("\n", 10)).toEqual([""]);
  });

  it("keeps a final line that has no trailing newline", () => {
    // The last line of a file being appended to is almost always mid-write.
    // Dropping it because it lacks a newline would hide the newest entry, which
    // is the whole reason an operator opens this read.
    expect(tailLogLines("a\nb", 10)).toEqual(["a", "b"]);
    expect(tailLogLines("a\nb\n", 10)).toEqual(["a", "b"]);
  });

  it("returns the newest lines in the order the file wrote them", () => {
    const text = ["one", "two", "three", "four", "five"].join("\n") + "\n";
    expect(tailLogLines(text, 2)).toEqual(["four", "five"]);
    expect(tailLogLines(text, 5)).toEqual(["one", "two", "three", "four", "five"]);
    expect(tailLogLines(text, 99)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("keeps a blank line that is in the file, because it is in the file", () => {
    // Not a filtering decision: a line of only whitespace is still a line the
    // writer produced, and hiding it would make the count disagree with the
    // file. What is *not* in the file is the empty segment after a trailing
    // newline, and that one is dropped.
    expect(tailLogLines("a\n\nb\n", 10)).toEqual(["a", "", "b"]);
  });

  it("returns nothing for a non-positive limit, which the route never asks for", () => {
    // `resolveLogLimit` is what makes this unreachable from the route. The
    // contract is pinned anyway, because a zero here would be a confirmed
    // empty log produced by arithmetic rather than by a read.
    expect(tailLogLines("a\nb\n", 0)).toEqual([]);
    expect(tailLogLines("a\nb\n", -1)).toEqual([]);
  });

  it("reads a real appended log the way the writer wrote it", () => {
    // Non-vacuity: the writer's own `formatLine` output, tailed.
    const written = [
      selfLine("INFO", "[SelfLog] guaranteed server log active: /home/op/.openclaw/jarvis/logs/server-jarvis.self.log"),
      selfLine("INFO", "[Jarvis API] Listening on http://localhost:19877"),
      selfLine("ERROR", "chat stream failed: upstream 503"),
    ].map((line) => `${line}\n`).join("");
    const tail = tailLogLines(written, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0]).toBe(selfLine("INFO", "[Jarvis API] Listening on http://localhost:19877"));
    expect(tail[1]).toBe(selfLine("ERROR", "chat stream failed: upstream 503"));
  });
});

describe("logLineCount", () => {
  it("counts the lines the file holds, so a read can say whether it saw them all", () => {
    // This is the question the payload's `truncated` answers. A consumer may
    // call its count the file's only when the read reached the first line, so
    // the count has to be a fact about the text rather than an inference from
    // how many lines came back.
    expect(logLineCount("")).toBe(0);
    expect(logLineCount("\n")).toBe(1);
    expect(logLineCount("a\nb\n")).toBe(2);
    expect(logLineCount("a\nb")).toBe(2);
    expect(logLineCount("a\n\nb\n")).toBe(3);
  });

  it("agrees with the tail it bounds, at and above the limit", () => {
    const text = ["a", "b", "c", "d", "e"].join("\n") + "\n";
    expect(logLineCount(text)).toBe(5);
    expect(tailLogLines(text, 5)).toHaveLength(5);
    expect(tailLogLines(text, 4)).toHaveLength(4);
    expect(logLineCount(text) > 4).toBe(true);
    expect(logLineCount(text) > 5).toBe(false);
  });

  it("counts a file whose last line is still being written", () => {
    expect(logLineCount("done\nin progress")).toBe(2);
  });
});

describe("parseSelfLogLine", () => {
  it("splits the writer's timestamp, level and text", () => {
    expect(parseSelfLogLine(selfLine("WARN", "conductor warm-up skipped"))).toEqual({
      timestamp: ISO,
      level: "WARN",
      text: "conductor warm-up skipped",
    });
  });

  it("keeps a text that itself contains spaces and colons", () => {
    expect(parseSelfLogLine(selfLine("INFO", "[Jarvis API] GET /status -> 200 in 12ms"))).toEqual({
      timestamp: ISO,
      level: "INFO",
      text: "[Jarvis API] GET /status -> 200 in 12ms",
    });
  });

  it("accepts a line whose text is empty rather than throwing it away", () => {
    expect(parseSelfLogLine(selfLine("INFO", ""))).toEqual({ timestamp: ISO, level: "INFO", text: "" });
  });

  it("invents no timestamp and no level for a line the writer could not have written", () => {
    // Decision (c): the level is a property of the file, not of the line. A
    // line that is not the self-log's shape is shown as the text it is, with
    // no level and no time invented for it.
    expect(parseSelfLogLine("just some child output")).toEqual({
      timestamp: null,
      level: null,
      text: "just some child output",
    });
    expect(parseSelfLogLine("")).toEqual({ timestamp: null, level: null, text: "" });
  });

  it("rejects a prefix that only looks like a timestamp", () => {
    expect(parseSelfLogLine("2026-09-26 not-a-real-time INFO hello").level).toBeNull();
    expect(parseSelfLogLine(`${ISO} lowercase hello`).level).toBeNull();
  });

  it("rejects a level the writer never emits", () => {
    expect(parseSelfLogLine(`${ISO} TRACE hello`).level).toBeNull();
    expect(parseSelfLogLine(`${ISO} DEBUG hello`).level).toBeNull();
  });
});

describe("buildLogTail", () => {
  it("parses every tailed line and reports the bound it could support", () => {
    const text = [selfLine("INFO", "one"), selfLine("ERROR", "two"), selfLine("INFO", "three")]
      .map((line) => `${line}\n`)
      .join("");
    const tail = buildLogTail("server-jarvis.self.log", text, { limit: 2, truncated: true });
    expect(tail.source).toBe("server-jarvis.self.log");
    expect(tail.format).toBe(LOG_TAIL_FORMAT);
    expect(tail.limit).toBe(2);
    expect(tail.truncated).toBe(true);
    expect(tail.lines.map((line) => line.text)).toEqual(["two", "three"]);
    expect(tail.lines.map((line) => line.level)).toEqual(["ERROR", "INFO"]);
  });

  it("reports an untruncated read so the caller can say the count is the file's", () => {
    const text = `${selfLine("INFO", "only")}\n`;
    const tail = buildLogTail("server-jarvis.self.log", text, { limit: 200, truncated: false });
    expect(tail.truncated).toBe(false);
    expect(tail.lines).toHaveLength(1);
  });

  it("reports a confirmed empty file as an empty tail, not as a failure", () => {
    const tail = buildLogTail("server-jarvis.self.log", "", { limit: 200, truncated: false });
    expect(tail.lines).toEqual([]);
    expect(tail.truncated).toBe(false);
  });
});

describe("LOG_READ_FAILURE_STATUS", () => {
  it("answers a file that is not there as missing and one that cannot be read as unreadable", () => {
    // Both are read failures. Neither is an empty list: `ok: true` with zero
    // lines is the app saying "this log is empty", which for a file that was
    // never opened is the one sentence this read must never produce.
    expect(LOG_READ_FAILURE_STATUS.missing).toBe(404);
    expect(LOG_READ_FAILURE_STATUS.unreadable).toBe(500);
  });

  it("gives both failures a status the client cannot mistake for a read", () => {
    for (const status of Object.values(LOG_READ_FAILURE_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });
});
