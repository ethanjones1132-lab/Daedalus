import { describe, expect, test } from "bun:test";
import {
  trigramsOf,
  jaccard,
  assessRepetition,
  SessionRepetitionStore,
  REPETITION_SIMILARITY_THRESHOLD,
} from "./repetition-guard";

const INCIDENT_TURN_1 =
  "I've started exploring the Versutus repository, but the initial inspection only reached the top-level directory listing. No source files have been read yet, so a comprehensive architectural diagnosis cannot be completed. Ask me to read specific files.";
const INCIDENT_TURN_2 =
  "The previous assistant only examined the top-level directory listing. To provide a thorough and grounded architectural diagnosis I need to inspect the actual source code. I do not have that information — I can't reliably diagnose a system I haven't read. Ask me to read the repo and diagnose again.";

describe("repetition-guard", () => {
  test("jaccard of identical trigram sets is 1", () => {
    const g = trigramsOf("same text here");
    expect(jaccard(g, g)).toBe(1);
  });

  test("incident turns 1 and 2 score above the threshold", () => {
    const sim = jaccard(trigramsOf(INCIDENT_TURN_1), trigramsOf(INCIDENT_TURN_2));
    expect(sim).toBeGreaterThan(REPETITION_SIMILARITY_THRESHOLD);
  });

  test("no-progress repetition is flagged when evidence did not grow", () => {
    const store = new SessionRepetitionStore();
    store.record("s1", INCIDENT_TURN_1, ["list_directory:{\"path\":\"C:\\\\Projects\\\\Versutus\"}"]);
    const verdict = assessRepetition(
      store.lastSignature("s1"),
      INCIDENT_TURN_2,
      ["list_directory:{\"path\":\"C:\\\\Projects\\\\Versutus\"}"],
    );
    expect(verdict.repeated).toBe(true);
    expect(verdict.newEvidence).toBe(false);
  });

  test("similar answer WITH new evidence is not flagged", () => {
    const store = new SessionRepetitionStore();
    store.record("s2", INCIDENT_TURN_1, ["list_directory:{\"path\":\"C:\\\\x\"}"]);
    const verdict = assessRepetition(
      store.lastSignature("s2"),
      INCIDENT_TURN_2,
      ["list_directory:{\"path\":\"C:\\\\x\"}", "read_file:{\"path\":\"C:\\\\x\\\\package.json\"}"],
    );
    expect(verdict.repeated).toBe(false);
    expect(verdict.newEvidence).toBe(true);
  });

  test("dissimilar answers are never flagged", () => {
    const store = new SessionRepetitionStore();
    store.record("s3", INCIDENT_TURN_1, []);
    const verdict = assessRepetition(store.lastSignature("s3"), "Here is the full diagnosis: the gateway lacks a WebSocket transport and message schema.", []);
    expect(verdict.repeated).toBe(false);
  });

  test("two unrelated near-empty answers are not flagged as repeated", () => {
    const store = new SessionRepetitionStore();
    store.record("s4", "No", ["x"]);
    const verdict = assessRepetition(store.lastSignature("s4"), "Ok", ["x"]);
    expect(verdict.repeated).toBe(false);
    expect(verdict.similarity).toBe(0);
  });

  test("store evicts sessions beyond capacity", () => {
    const store = new SessionRepetitionStore(2);
    store.record("a", "one", []);
    store.record("b", "two", []);
    store.record("c", "three", []);
    expect(store.lastSignature("a")).toBeUndefined();
    expect(store.lastSignature("c")).toBeDefined();
  });

  test("re-recording an existing session refreshes its recency and protects it from eviction", () => {
    const store = new SessionRepetitionStore(2);
    store.record("a", "one", []);
    store.record("b", "two", []);
    store.record("a", "one-again", []);
    store.record("c", "three", []);
    expect(store.lastSignature("b")).toBeUndefined();
    expect(store.lastSignature("a")).toBeDefined();
    expect(store.lastSignature("c")).toBeDefined();
  });
});
