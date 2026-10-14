import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_WINDOW,
  anchoredScrollTop,
  extendWindow,
  transcriptCountLabel,
  transcriptWindow,
  transcriptWindowNotice,
  windowSlice,
  windowStart,
} from './transcript-window';

const list = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe('the bound itself', () => {
  it('is a whole number of messages a surface can state in words', () => {
    expect(Number.isInteger(TRANSCRIPT_WINDOW)).toBe(true);
    expect(TRANSCRIPT_WINDOW).toBeGreaterThan(0);
  });
});

describe('transcriptWindow', () => {
  it('withholds nothing for a transcript exactly at the bound', () => {
    expect(transcriptWindow(TRANSCRIPT_WINDOW, TRANSCRIPT_WINDOW)).toEqual({
      shown: TRANSCRIPT_WINDOW,
      withheld: 0,
      total: TRANSCRIPT_WINDOW,
      complete: true,
    });
  });

  it('withholds exactly one message one over the bound', () => {
    expect(transcriptWindow(TRANSCRIPT_WINDOW + 1, TRANSCRIPT_WINDOW)).toEqual({
      shown: TRANSCRIPT_WINDOW,
      withheld: 1,
      total: TRANSCRIPT_WINDOW + 1,
      complete: false,
    });
  });

  it('reports an empty read as a complete window, not a bounded one', () => {
    // A transcript with nothing in it is not hiding anything, so it must not be
    // described as a bound — that is what keeps the notice off a pending and an
    // empty read, which are the two states that already say what they are.
    expect(transcriptWindow(0, TRANSCRIPT_WINDOW)).toEqual({
      shown: 0,
      withheld: 0,
      total: 0,
      complete: true,
    });
  });

  it('keeps the newest message on screen as the list grows', () => {
    const at = transcriptWindow(TRANSCRIPT_WINDOW + 1, TRANSCRIPT_WINDOW);
    const grown = transcriptWindow(TRANSCRIPT_WINDOW + 2, TRANSCRIPT_WINDOW);
    expect(grown.shown).toBe(TRANSCRIPT_WINDOW);
    expect(grown.withheld).toBe(2);
    const messages = list(TRANSCRIPT_WINDOW + 2);
    const slice = windowSlice(messages, TRANSCRIPT_WINDOW);
    expect(slice[slice.length - 1], 'the newest message is never the one withheld').toBe(`m${messages.length - 1}`);
    expect(at.withheld).toBe(1);
  });

  it('does not reduce a window the operator extended when the list grows', () => {
    const extended = 2 * TRANSCRIPT_WINDOW;
    const before = transcriptWindow(250, extended);
    const after = transcriptWindow(251, extended);
    expect(before.shown).toBe(extended);
    expect(after.shown, 'an extended window is a floor on reach, not a fixed set of messages').toBe(extended);
    expect(after.withheld).toBe(51);
    expect(before.withheld).toBe(50);
  });

  it('keeps a stale extension from withholding anything after a Session switch', () => {
    // `visible` is per-surface state, so switching Sessions hands the next read a
    // window sized for the last one. A five-message Session must render all five.
    expect(transcriptWindow(0, 5 * TRANSCRIPT_WINDOW).complete).toBe(true);
    expect(transcriptWindow(5, 5 * TRANSCRIPT_WINDOW)).toEqual({
      shown: 5,
      withheld: 0,
      total: 5,
      complete: true,
    });
  });

  it('treats a count it cannot use as zero rather than rendering it', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(transcriptWindow(342, bad).shown).toBe(0);
      expect(transcriptWindow(342, bad).withheld).toBe(342);
    }
    // A whole number of messages is the only unit a count can be stated in, so a
    // decimal is floored rather than printed as `12.7 of 342 messages.`
    expect(transcriptWindow(342, 12.7).shown).toBe(12);
    expect(transcriptWindow(Number.NaN, 100)).toEqual({ shown: 0, withheld: 0, total: 0, complete: true });
  });
});

describe('windowStart and windowSlice', () => {
  it('starts at the first message when the read fits the window', () => {
    expect(windowStart(3, TRANSCRIPT_WINDOW)).toBe(0);
    expect(windowStart(TRANSCRIPT_WINDOW, TRANSCRIPT_WINDOW)).toBe(0);
  });

  it('starts where the withheld run begins', () => {
    expect(windowStart(342, TRANSCRIPT_WINDOW)).toBe(242);
    expect(windowStart(342, 2 * TRANSCRIPT_WINDOW)).toBe(142);
    expect(windowStart(342, 0)).toBe(342);
  });

  it('returns the very array it was handed for a transcript that fits, untouched', () => {
    // Non-vacuity: a short transcript must not be re-sliced, re-keyed or
    // re-ordered by a rule that exists for long ones.
    const messages = list(3);
    expect(windowSlice(messages, TRANSCRIPT_WINDOW)).toBe(messages);
  });

  it('keeps conversation order in the slice it does return', () => {
    const messages = list(342);
    const slice = windowSlice(messages, TRANSCRIPT_WINDOW);
    expect(slice).toHaveLength(TRANSCRIPT_WINDOW);
    expect(slice[0]).toBe('m242');
    expect(slice[slice.length - 1]).toBe('m341');
  });

  it('renders nothing for a window of nothing, and never drops from the tail', () => {
    const messages = list(5);
    expect(windowSlice(messages, 0)).toEqual([]);
    expect(windowSlice([], TRANSCRIPT_WINDOW)).toEqual([]);
    expect(windowSlice(messages, 5)).toEqual(messages);
  });
});

describe('extendWindow', () => {
  it('adds one step and never more than the read returned', () => {
    expect(extendWindow(TRANSCRIPT_WINDOW, 250)).toBe(2 * TRANSCRIPT_WINDOW);
    expect(extendWindow(2 * TRANSCRIPT_WINDOW, 250), 'the last press cannot claim reach past the messages that exist').toBe(250);
  });

  it('cannot grow a window that is already showing everything', () => {
    expect(extendWindow(TRANSCRIPT_WINDOW, TRANSCRIPT_WINDOW)).toBe(TRANSCRIPT_WINDOW);
    expect(extendWindow(TRANSCRIPT_WINDOW, 0)).toBe(0);
  });

  it('starts from nothing rather than from a count it cannot use', () => {
    expect(extendWindow(Number.NaN, 250)).toBe(TRANSCRIPT_WINDOW);
    expect(extendWindow(-1, 250)).toBe(TRANSCRIPT_WINDOW);
  });
});

describe('the reading position when earlier messages arrive above it', () => {
  it('offsets the scroll by exactly the height that was inserted above', () => {
    expect(anchoredScrollTop({ scrollHeight: 1000, scrollTop: 200 }, 1400)).toBe(600);
    expect(anchoredScrollTop({ scrollHeight: 1000, scrollTop: 0 }, 1500)).toBe(500);
  });

  it('leaves the offset alone when nothing was inserted', () => {
    expect(anchoredScrollTop({ scrollHeight: 1000, scrollTop: 200 }, 1000)).toBe(200);
  });

  it('does not invent an offset from a container that has no layout yet', () => {
    // jsdom reports zero for every scroll metric, and so does a container that
    // has not been laid out. Neither may produce a scroll jump.
    expect(anchoredScrollTop({ scrollHeight: 0, scrollTop: 0 }, 900)).toBe(0);
    expect(anchoredScrollTop({ scrollHeight: 0, scrollTop: 120 }, 0)).toBe(120);
  });
});

describe('what a bounded transcript says about itself', () => {
  it('says nothing when nothing is withheld', () => {
    // Preservation, stated as a contract: a Session at or under the bound renders
    // exactly as it did before this rule existed, and the header that used to
    // read `342 msgs` still reads it.
    expect(transcriptWindowNotice(transcriptWindow(342, 342))).toBeNull();
    expect(transcriptWindowNotice(transcriptWindow(0, 342))).toBeNull();
    expect(transcriptCountLabel(transcriptWindow(342, 342))).toBe('342 msgs');
    expect(transcriptCountLabel(transcriptWindow(0, 342))).toBe('0 msgs');
  });

  it('states the bound it is showing and how much of the Session is off screen', () => {
    expect(transcriptWindowNotice(transcriptWindow(342, TRANSCRIPT_WINDOW))).toEqual({
      notice: 'Showing the newest 100 of 342 messages.',
      extendLabel: 'Show 100 earlier messages',
    });
  });

  it('asks for only the messages that are actually left', () => {
    expect(transcriptWindowNotice(transcriptWindow(102, TRANSCRIPT_WINDOW))?.extendLabel).toBe('Show 2 earlier messages');
    expect(transcriptWindowNotice(transcriptWindow(101, TRANSCRIPT_WINDOW))?.extendLabel).toBe('Show 1 earlier message');
  });

  it('counts what is on screen in the pill rather than what the read returned', () => {
    expect(transcriptCountLabel(transcriptWindow(342, TRANSCRIPT_WINDOW))).toBe('100 of 342 msgs');
    expect(transcriptCountLabel(transcriptWindow(342, 2 * TRANSCRIPT_WINDOW))).toBe('200 of 342 msgs');
  });

  it('never states a number the read did not return', () => {
    for (const total of [0, 1, 100, 101, 342, 5000]) {
      for (const visible of [0, 1, 100, 200, 5000]) {
        const w = transcriptWindow(total, visible);
        const label = transcriptCountLabel(w);
        if (w.withheld === 0) {
          expect(label).toBe(`${total} msgs`);
        } else {
          expect(label).toBe(`${w.shown} of ${w.total} msgs`);
          expect(w.shown + w.withheld, 'shown and withheld must account for the whole read').toBe(total);
        }
      }
    }
  });
});
