// Contracts for the shared clipboard copy-outcome decision.
//
// The bug class this exists for: a copy control that is told nothing when the
// clipboard refuses. Two controls in this tree kept the outcome as a fact and
// announced the refusal (`RecordIdBadge`, the `MarkdownView` code block); two
// did not — the hand-rolled `MarkdownRenderer` swallowed the rejection into
// `setCopied(false)`, and the Jarvis transcript's icon-only per-message control
// logged it and changed nothing on screen. A 1.5s success label that reverts is
// the same pixels as a failure, so "it did nothing" and "it worked and I missed
// it" were the same observation.
//
// These are pure contracts over one attempt-fenced reducer, so both surfaces
// read the same decision and neither can drift into claiming a copy that the
// clipboard refused.
import { describe, expect, it } from 'vitest';
import {
  COPY_FAILED_COPY,
  COPY_SUCCESS_TIMEOUT_MS,
  initialCopyOutcome,
  projectCopyOutcome,
  reduceCopyOutcome,
  type CopyOutcomeEvent,
  type CopyOutcomeState,
} from './copy-outcome';

function run(events: CopyOutcomeEvent[], from: CopyOutcomeState = initialCopyOutcome()): CopyOutcomeState {
  return events.reduce(reduceCopyOutcome, from);
}

const view = (events: CopyOutcomeEvent[]) => projectCopyOutcome(run(events));

describe('copy outcome: an attempt and its settlement are separate facts', () => {
  it('claims nothing before the operator clicks', () => {
    const projected = projectCopyOutcome(initialCopyOutcome());
    expect(projected.phase).toBe('idle');
    expect(projected.copied).toBe(false);
    expect(projected.failed).toBe(false);
    expect(projected.message).toBeNull();
    expect(projected.attempted).toBe(false);
    expect(projected.settled).toBe(false);
    expect(projected.confirmed).toBe(false);
  });

  it('makes no claim while the write is in flight', () => {
    const projected = view([{ type: 'attempt', attempt: 1 }]);
    expect(projected.phase).toBe('copying');
    expect(projected.attempted).toBe(true);
    expect(projected.settled).toBe(false);
    expect(projected.confirmed).toBe(false);
    expect(projected.copied).toBe(false);
    expect(projected.message).toBeNull();
  });

  it('confirms only when the write came back resolved', () => {
    const projected = view([{ type: 'attempt', attempt: 1 }, { type: 'confirmed', attempt: 1 }]);
    expect(projected.phase).toBe('copied');
    expect(projected.copied).toBe(true);
    expect(projected.settled).toBe(true);
    expect(projected.confirmed).toBe(true);
    expect(projected.message).toBeNull();
  });

  it('reports a refusal with one fixed sentence that names no cause', () => {
    const projected = view([{ type: 'attempt', attempt: 1 }, { type: 'failed', attempt: 1 }]);
    expect(projected.phase).toBe('failed');
    expect(projected.failed).toBe(true);
    expect(projected.copied).toBe(false);
    expect(projected.confirmed).toBe(false);
    expect(projected.message).toBe('Could not copy the message to clipboard.');
    expect(projected.message).toBe(COPY_FAILED_COPY);
    for (const leaked of ['Error', 'clipboard unavailable', 'not allowed', 'undefined']) {
      expect(projected.message).not.toContain(leaked);
    }
  });

  it('keeps the success timeout at the 1.5s every control already used', () => {
    expect(COPY_SUCCESS_TIMEOUT_MS).toBe(1500);
  });
});

describe('copy outcome: the success label expires, the fact does not', () => {
  it('drops the label on expiry while keeping the write confirmed', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'confirmed', attempt: 1 },
      { type: 'expired', attempt: 1 },
    ]);
    expect(projected.phase).toBe('idle');
    expect(projected.copied).toBe(false);
    expect(projected.message).toBeNull();
    expect(projected.confirmed).toBe(true);
    expect(projected.settled).toBe(true);
  });

  it('ignores an expiry that was never preceded by a confirmed write', () => {
    const state = run([{ type: 'attempt', attempt: 1 }]);
    expect(reduceCopyOutcome(state, { type: 'expired', attempt: 1 })).toBe(state);
  });

  it('ignores an expiry for an attempt that has been superseded', () => {
    const state = run([
      { type: 'attempt', attempt: 1 },
      { type: 'confirmed', attempt: 1 },
      { type: 'attempt', attempt: 2 },
      { type: 'confirmed', attempt: 2 },
    ]);
    // A timer from the first write must not clear the second write's label.
    expect(reduceCopyOutcome(state, { type: 'expired', attempt: 1 })).toBe(state);
    expect(projectCopyOutcome(state).copied).toBe(true);
  });
});

describe('copy outcome: a superseded write cannot speak for the current one', () => {
  it('drops a refusal that lands after a newer click', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'attempt', attempt: 2 },
      { type: 'failed', attempt: 1 },
    ]);
    // The operator's newest click is in flight and has said nothing yet.
    expect(projected.phase).toBe('copying');
    expect(projected.failed).toBe(false);
    expect(projected.message).toBeNull();
    expect(projected.settled).toBe(false);
  });

  it('drops a confirmation that lands after a newer click', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'attempt', attempt: 2 },
      { type: 'confirmed', attempt: 1 },
    ]);
    expect(projected.copied).toBe(false);
    expect(projected.confirmed).toBe(false);
    expect(projected.message).toBeNull();
  });

  it('ignores a settlement for an attempt that was never issued', () => {
    const state = initialCopyOutcome();
    expect(reduceCopyOutcome(state, { type: 'confirmed', attempt: 7 })).toBe(state);
    expect(reduceCopyOutcome(state, { type: 'failed', attempt: 7 })).toBe(state);
  });

  it('ignores a repeated dispatch of the attempt already in flight', () => {
    const state = run([{ type: 'attempt', attempt: 1 }]);
    expect(reduceCopyOutcome(state, { type: 'attempt', attempt: 1 })).toBe(state);
  });

  it('lets a second click after a refusal attempt again and clears the stale sentence', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'failed', attempt: 1 },
      { type: 'attempt', attempt: 2 },
    ]);
    expect(projected.phase).toBe('copying');
    expect(projected.message).toBeNull();
    expect(projected.failed).toBe(false);
    expect(projected.confirmed).toBe(false);
  });

  it('lets a second click after a success attempt again', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'confirmed', attempt: 1 },
      { type: 'attempt', attempt: 2 },
    ]);
    expect(projected.phase).toBe('copying');
    expect(projected.copied).toBe(false);
    expect(projected.confirmed).toBe(false);
  });
});

describe('copy outcome: a claim about text that is no longer on screen', () => {
  it('clears a refusal and re-fences when the copied text changes', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'failed', attempt: 1 },
      { type: 'reset', attempt: 2 },
    ]);
    expect(projected.phase).toBe('idle');
    expect(projected.message).toBeNull();
    expect(projected.copied).toBe(false);
    expect(projected.failed).toBe(false);
  });

  it('drops the settlement of a write whose text has been replaced', () => {
    const projected = view([
      { type: 'attempt', attempt: 1 },
      { type: 'reset', attempt: 2 },
      { type: 'confirmed', attempt: 1 },
    ]);
    expect(projected.phase).toBe('idle');
    expect(projected.copied).toBe(false);
    expect(projected.confirmed).toBe(false);
  });

  it('leaves the state alone when there is no claim to clear', () => {
    const idle = initialCopyOutcome();
    expect(reduceCopyOutcome(idle, { type: 'reset', attempt: 1 })).toBe(idle);
    const copying = run([{ type: 'attempt', attempt: 1 }]);
    expect(reduceCopyOutcome(copying, { type: 'reset', attempt: 2 })).not.toBe(copying);
  });
});

describe('copy outcome: the projection states exactly one thing at a time', () => {
  it('says something only while a refusal is on screen', () => {
    const phases = [
      view([]).phase,
      view([{ type: 'attempt', attempt: 1 }]).phase,
      view([{ type: 'attempt', attempt: 1 }, { type: 'confirmed', attempt: 1 }]).phase,
      view([{ type: 'attempt', attempt: 1 }, { type: 'failed', attempt: 1 }]).phase,
      view([
        { type: 'attempt', attempt: 1 },
        { type: 'confirmed', attempt: 1 },
        { type: 'expired', attempt: 1 },
      ]).phase,
    ];
    const states = [
      view([]),
      view([{ type: 'attempt', attempt: 1 }]),
      view([{ type: 'attempt', attempt: 1 }, { type: 'confirmed', attempt: 1 }]),
      view([{ type: 'attempt', attempt: 1 }, { type: 'failed', attempt: 1 }]),
      view([
        { type: 'attempt', attempt: 1 },
        { type: 'confirmed', attempt: 1 },
        { type: 'expired', attempt: 1 },
      ]),
    ];
    expect(phases).toEqual(['idle', 'copying', 'copied', 'failed', 'idle']);
    for (const state of states) {
      expect(state.message !== null).toBe(state.failed);
      expect(state.copied && state.failed).toBe(false);
    }
  });
});
