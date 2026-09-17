import { describe, expect, it } from 'vitest';
import { applySkillListRead, confirmSkillToggle } from './skill-toggle-state';

describe('confirmSkillToggle', () => {
  it('publishes the confirmed value for exactly the target skill and preserves other rows', () => {
    const skills = [
      { id: 'a', name: 'alpha', enabled: false },
      { id: 'b', name: 'beta', enabled: true },
    ];
    const next = confirmSkillToggle(skills, 'a', true);
    expect(next).toEqual([
      { id: 'a', name: 'alpha', enabled: true },
      { id: 'b', name: 'beta', enabled: true },
    ]);
    // Idempotent: re-applying the confirmed value is a no-op.
    expect(confirmSkillToggle(next, 'a', true)).toEqual(next);
    // The input array is never mutated.
    expect(skills[0].enabled).toBe(false);
  });
});

describe('applySkillListRead', () => {
  const incoming = [
    { id: 'a', name: 'alpha', enabled: false },
    { id: 'b', name: 'beta', enabled: true },
  ];

  it('applies the read unchanged when no toggle is protected', () => {
    const { skills, protections } = applySkillListRead(incoming, {}, 3);
    expect(skills).toEqual(incoming);
    expect(protections).toEqual({});
  });

  it('keeps the confirmed submitted value for a read that may predate the write', () => {
    // The write resolved while read 5 was already in flight, so this read
    // (id 4 <= barrier 5) cannot be trusted for the protected skill.
    const { skills, protections } = applySkillListRead(
      incoming,
      { a: { target: true, barrierReadId: 5 } },
      4,
    );
    expect(skills.find((s) => s.id === 'a')?.enabled).toBe(true);
    expect(skills.find((s) => s.id === 'b')?.enabled).toBe(true);
    expect(protections).toEqual({ a: { target: true, barrierReadId: 5 } });
  });

  it('applies a post-resolution read and clears the consumed protection', () => {
    const { skills, protections } = applySkillListRead(
      incoming,
      { a: { target: true, barrierReadId: 5 } },
      6,
    );
    expect(skills.find((s) => s.id === 'a')?.enabled).toBe(false);
    expect(protections).toEqual({});
  });

  it('retains protection for a skill absent from the incoming read', () => {
    const { skills, protections } = applySkillListRead(
      incoming.filter((s) => s.id !== 'a'),
      { a: { target: true, barrierReadId: 5 } },
      4,
    );
    expect(skills.some((s) => s.id === 'a')).toBe(false);
    expect(protections).toEqual({ a: { target: true, barrierReadId: 5 } });
  });
});
