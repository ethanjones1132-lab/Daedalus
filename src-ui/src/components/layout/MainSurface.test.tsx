import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MainSurface } from './MainSurface';

describe('MainSurface viewport contract', () => {
  it('constrains feature views to the app viewport so nested transcripts own scrolling', () => {
    render(<MainSurface><div data-testid="feature-view">content</div></MainSurface>);

    const surface = screen.getByRole('main', { name: 'Application workspace' });
    const viewport = screen.getByTestId('main-surface-viewport');

    expect(surface).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto');
    expect(viewport).toHaveClass('h-full', 'min-h-0');
    expect(viewport).toContainElement(screen.getByTestId('feature-view'));
  });
});
