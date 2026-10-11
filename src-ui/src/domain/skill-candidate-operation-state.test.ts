import { describe, expect, it } from "vitest";
import {
  skillCandidateMutationConfirmed,
  skillCandidateMutationLocked,
  startSkillCandidateMutation,
  transitionSkillCandidateMutation,
} from "./skill-candidate-operation-state";

describe("skill candidate operation state", () => {
  it("locks the same candidate through write and reconciliation", () => {
    const mutation = startSkillCandidateMutation("candidate-1", "promote", 3, 1);
    expect(skillCandidateMutationLocked(mutation)).toBe(true);
    expect(transitionSkillCandidateMutation(mutation, "write-succeeded")?.phase).toBe("reconciling");
    expect(skillCandidateMutationLocked(transitionSkillCandidateMutation(mutation, "write-succeeded")!)).toBe(true);
  });

  it("keeps a rejected write retryable while making an unconfirmed accepted write read-only", () => {
    const writing = startSkillCandidateMutation("candidate-1", "reject", 0, 1);
    const rejected = transitionSkillCandidateMutation(writing, "write-failed")!;
    expect(rejected.phase).toBe("write-failed");
    expect(skillCandidateMutationLocked(rejected)).toBe(false);

    const reconciling = transitionSkillCandidateMutation(writing, "write-succeeded")!;
    const unconfirmed = transitionSkillCandidateMutation(reconciling, "read-failed")!;
    expect(unconfirmed.phase).toBe("read-failed");
    expect(skillCandidateMutationLocked(unconfirmed)).toBe(true);
  });

  it("confirms only the next authoritative version and expected lifecycle status", () => {
    const mutation = transitionSkillCandidateMutation(
      startSkillCandidateMutation("candidate-1", "demote", 2, 1),
      "write-succeeded",
    )!;
    expect(skillCandidateMutationConfirmed(mutation, { id: "candidate-1", status: "candidate", lifecycle_version: 3 })).toBe(true);
    expect(skillCandidateMutationConfirmed(mutation, { id: "candidate-1", status: "promoted", lifecycle_version: 3 })).toBe(false);
    expect(skillCandidateMutationConfirmed(mutation, { id: "candidate-1", status: "candidate", lifecycle_version: 2 })).toBe(false);
    expect(skillCandidateMutationConfirmed(mutation, { id: "candidate-2", status: "candidate", lifecycle_version: 3 })).toBe(false);
  });

  it("accepts a promote request that authoritatively resolves to rejection", () => {
    const mutation = transitionSkillCandidateMutation(
      startSkillCandidateMutation("candidate-1", "promote", 0, 1),
      "write-succeeded",
    )!;
    expect(skillCandidateMutationConfirmed(mutation, { id: "candidate-1", status: "rejected", lifecycle_version: 1 })).toBe(true);
  });

  it("rejects invalid phase transitions instead of reviving settled work", () => {
    const mutation = startSkillCandidateMutation("candidate-1", "promote", 0, 1);
    expect(transitionSkillCandidateMutation(mutation, "read-failed")).toBeNull();
    const failed = transitionSkillCandidateMutation(mutation, "write-failed")!;
    expect(transitionSkillCandidateMutation(failed, "write-succeeded")).toBeNull();
  });
});
