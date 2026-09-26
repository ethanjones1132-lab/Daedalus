import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MythosCompanionSprite } from './MythosCompanionSprite';

// App.awareness.test.tsx substitutes this component for one that carries
// `role="status" aria-label="Cron awareness"`, so the mock asserts an
// accessibility contract the real caption has to satisfy on its own. These
// contracts render the shipped component so the substitution cannot overstate
// what the app announces.
afterEach(cleanup);

describe('the companion sprite cron caption', () => {
  it('announces the caption it is given', () => {
    render(<MythosCompanionSprite cronAwareness="Tracking 1 self-improvement cron." />);
    const caption = screen.getByRole('status', { name: 'Cron awareness' });
    expect(caption).toHaveTextContent('Tracking 1 self-improvement cron.');
  });

  it('announces an unavailable caption too, so a failed read is not silent', () => {
    render(<MythosCompanionSprite cronAwareness="Cron awareness unavailable. Waiting for the next refresh." />);
    expect(screen.getByRole('status', { name: 'Cron awareness' })).toHaveTextContent(
      'Cron awareness unavailable. Waiting for the next refresh.',
    );
  });

  it('renders no live region when there is no caption to announce', () => {
    render(<MythosCompanionSprite />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders no live region for an explicit null caption', () => {
    render(<MythosCompanionSprite cronAwareness={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
