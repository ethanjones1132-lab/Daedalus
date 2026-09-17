// Pure reconciliation helpers for SkillsView native enablement (enable_skill /
// disable_skill return Result<(), String> — resolution itself is the
// confirmation; see src-tauri/src/commands/skills.rs:561-583).

export interface SkillToggleProtection<T> {
  /** The confirmed value published when the native write resolved. */
  target: T;
  /** Read barrier: reads with an id <= barrierReadId may predate the write. */
  barrierReadId: number;
}

/** Publish the confirmed target for exactly one skill, idempotently. */
export function confirmSkillToggle<T extends { id: string; enabled: boolean }>(
  skills: T[],
  id: string,
  enabled: boolean,
): T[] {
  return skills.map((skill) => (skill.id === id ? { ...skill, enabled } : skill));
}

/**
 * Merge a completed list_skills read into the confirmed skill state without
 * letting a read that may predate a toggle's resolution erase that confirmed
 * value. Reads newer than the write's barrier are trusted and release the
 * protection; older ones are patched per-skill and stay protected until a
 * newer read arrives.
 */
export function applySkillListRead<T extends { id: string; enabled: boolean }>(
  incoming: T[],
  protections: Record<string, SkillToggleProtection<boolean>>,
  readId: number,
): { skills: T[]; protections: Record<string, SkillToggleProtection<boolean>> } {
  const nextProtections: Record<string, SkillToggleProtection<boolean>> = {};
  const skills = incoming.map((skill) => {
    const protection = protections[skill.id];
    if (protection && readId <= protection.barrierReadId) {
      nextProtections[skill.id] = protection;
      return protection.target === skill.enabled ? skill : { ...skill, enabled: protection.target };
    }
    return skill;
  });
  // A skill protected for the view lifetime may have vanished from the read;
  // retain its protection so a later read cannot bypass the barrier.
  for (const id of Object.keys(protections)) {
    if (!nextProtections[id] && !incoming.some((skill) => skill.id === id)) {
      nextProtections[id] = protections[id];
    }
  }
  return { skills, protections: nextProtections };
}
