import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JarvisMessage } from '../../domain/types';
import { TurnMessage } from './TurnMessage';

function partialMessage(errorCode?: string): JarvisMessage {
  return {
    role: 'assistant',
    content: 'The answer.',
    isStreaming: false,
    terminalOutcome: 'partial',
    ...(errorCode ? { errorCode } : {}),
  };
}

describe('TurnMessage partial reason reporting', () => {
  it('says the reason was not reported when a partial result carries no code', () => {
    // Audit item 2: the client used to invent `inference_partial` for this
    // case; it now reports the absence of a reason instead of showing nothing.
    render(<TurnMessage message={partialMessage()} index={0} />);

    const badge = screen.getByLabelText('Partial result');
    expect(badge).toHaveTextContent('partial');
    expect(badge).toHaveTextContent('reason not reported');
  });

  it('shows the server-reported code instead of the fallback text', () => {
    render(<TurnMessage message={partialMessage('upstream_stage_failed')} index={1} />);

    const badge = screen.getByLabelText('Partial result');
    expect(badge).toHaveTextContent('partial');
    expect(badge).toHaveTextContent('upstream_stage_failed');
    expect(badge).not.toHaveTextContent('reason not reported');
  });
});
