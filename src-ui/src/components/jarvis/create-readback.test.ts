import { describe, expect, it } from 'vitest';
import {
  createFailureSentence,
  decodeCreatedRecord,
  decideCreateReadback,
  type CreateFailure,
} from './create-readback';

const DEVICE = { id: 'dev-1', name: 'studio-mac' };

describe('decodeCreatedRecord', () => {
  it('returns the record Native returned when it carries a usable id', () => {
    const returned = { id: 'dev-1', name: 'studio-mac', status: 'online' };
    expect(decodeCreatedRecord(returned)).toBe(returned);
  });

  it('rejects anything without a non-blank string id', () => {
    for (const value of [
      null,
      undefined,
      'dev-1',
      7,
      true,
      [{ id: 'dev-1' }],
      {},
      { id: null },
      { id: 7 },
      { id: '' },
      { id: '   ' },
    ]) {
      expect(decodeCreatedRecord(value)).toBeNull();
    }
  });
});

describe('decideCreateReadback', () => {
  it('confirms on the stored row, not on the value the write returned', () => {
    const stored = { id: 'dev-1', name: 'studio-mac (renamed)' };
    const verdict = decideCreateReadback<{ id: string; name: string }>({ id: 'dev-1', name: 'studio-mac' }, [stored]);
    expect(verdict).toEqual({ status: 'confirmed', row: stored });
    if (verdict.status === 'confirmed') expect(verdict.row.name).toBe('studio-mac (renamed)');
  });

  it('reports unconfirmed when the read succeeds without the record', () => {
    expect(decideCreateReadback(DEVICE, [])).toEqual({ status: 'unconfirmed' });
    expect(decideCreateReadback(DEVICE, [{ id: 'dev-2', name: 'other' }])).toEqual({ status: 'unconfirmed' });
  });

  it('never confirms a partial id match', () => {
    expect(decideCreateReadback(DEVICE, [{ id: 'dev-10', name: 'other' }])).toEqual({ status: 'unconfirmed' });
    expect(decideCreateReadback(DEVICE, [{ id: 'prefix-dev-1', name: 'other' }])).toEqual({ status: 'unconfirmed' });
  });

  it('reports unavailable when the confirming read produced no list at all', () => {
    for (const snapshot of [null, undefined, { rows: [] }, '[]', 0, false]) {
      expect(decideCreateReadback(DEVICE, snapshot as never)).toEqual({ status: 'unavailable' });
    }
  });

  it('reports unreadable before consulting the list when the write returned no identity', () => {
    expect(decideCreateReadback(null, [])).toEqual({ status: 'unreadable' });
    expect(decideCreateReadback({ name: 'studio-mac' }, [])).toEqual({ status: 'unreadable' });
    // A list that happens to contain a same-named row is not a confirmation.
    expect(decideCreateReadback({ id: '' }, [{ id: 'dev-9', name: 'studio-mac' }])).toEqual({ status: 'unreadable' });
  });

  it('does not confirm against a non-object list row carrying the id', () => {
    expect(decideCreateReadback(DEVICE, ['dev-1', null, 3])).toEqual({ status: 'unconfirmed' });
  });
});

describe('createFailureSentence', () => {
  const failures: CreateFailure[] = ['write-failed', 'unreadable', 'unavailable', 'unconfirmed'];
  const resources = ['device', 'node', 'hook', 'commitment'] as const;

  it('gives every failure its own fixed sentence naming the resource', () => {
    const sentences = new Set<string>();
    for (const failure of failures) {
      for (const resource of resources) {
        const sentence = createFailureSentence(resource, failure);
        sentences.add(sentence);
        expect(sentence).toContain(resource);
        expect(sentence).toMatch(/draft was kept/);
        expect(sentence).toMatch(/[.!]$/);
      }
    }
    // 4 distinct reasons x 4 resources; no reason reuses another resource's sentence.
    expect(sentences.size).toBe(failures.length * resources.length);
  });

  it('keeps each surface existing write-failed wording verbatim', () => {
    // A hook is registered, not added. These strings were already on screen and
    // must not be rewritten by a read-back change.
    expect(createFailureSentence('device', 'write-failed')).toBe('Could not add the device. Your draft was kept.');
    expect(createFailureSentence('node', 'write-failed')).toBe('Could not add the node. Your draft was kept.');
    expect(createFailureSentence('hook', 'write-failed')).toBe('Could not register the hook. Your draft was kept.');
    expect(createFailureSentence('commitment', 'write-failed')).toBe('Could not add the commitment. Your draft was kept.');
  });

  it('never interpolates caller or server text into a sentence', () => {
    for (const failure of failures) {
      const sentence = createFailureSentence('device', failure);
      expect(sentence).not.toMatch(/Error|undefined|NaN|\{|\}/);
    }
  });
});
