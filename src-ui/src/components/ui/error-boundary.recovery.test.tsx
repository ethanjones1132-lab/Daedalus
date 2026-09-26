import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './index';

// The surface an operator sees when a route throws. Fixed vocabulary: it names
// no native command, no schema detail, and no internals text.
const FIXED_MESSAGE = 'This view stopped unexpectedly. Daedalus is still running.';

let shouldThrow = false;
let thrown: unknown = null;
let mounts = 0;
let unmounts = 0;

function RouteSurface({ tick = 0 }: { tick?: number }) {
  useEffect(() => {
    mounts += 1;
    return () => {
      unmounts += 1;
    };
  }, []);
  if (shouldThrow) throw thrown;
  return <div>Route content {tick}</div>;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shouldThrow = false;
  thrown = null;
  mounts = 0;
  unmounts = 0;
  // React logs every caught render error itself; the diagnostic assertion below
  // reads the boundary's own call out of the same spy.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary announced failure', () => {
  it('announces a thrown failure with a fixed message and offers a Retry', () => {
    thrown = new Error('no such column: sessions (src-tauri/src/commands/sessions.rs:88)');
    shouldThrow = true;

    render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(FIXED_MESSAGE);
    expect(alert.textContent).not.toContain('no such column');
    expect(alert.textContent).not.toContain('sessions.rs');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it.each([
    ['a bare string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['an empty string', ''],
    ['an object without a message', { code: 7 }],
    ['an Error with an undefined message', new Error(undefined)],
  ])('never renders an empty region for %s', (_label, value) => {
    thrown = value;
    shouldThrow = true;

    render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(FIXED_MESSAGE)).toBeInTheDocument();
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('keeps the console.error diagnostic for the caught failure', () => {
    const error = new Error('render failed');
    thrown = error;
    shouldThrow = true;

    render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);

    const diagnostic = errorSpy.mock.calls.find(([tag]) => tag === '[ErrorBoundary]');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.[1]).toBe(error);
    expect(diagnostic?.[2]).toBeDefined();
  });
});

describe('ErrorBoundary recovery', () => {
  it('Retry re-mounts the children and renders a recovered route', () => {
    thrown = new Error('render failed');
    shouldThrow = true;

    render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByText('Route content 0')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The failed subtree never committed, so the recovered route is its first
    // committed mount.
    expect(mounts).toBe(1);
  });

  it('Retry mounts a fresh subtree rather than reviving the one that threw', () => {
    const { rerender } = render(<ErrorBoundary><RouteSurface tick={1} /></ErrorBoundary>);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    shouldThrow = true;
    thrown = new Error('render failed');
    rerender(<ErrorBoundary><RouteSurface tick={2} /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveTextContent(FIXED_MESSAGE);
    expect(screen.queryByText('Route content 1')).not.toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByText('Route content 2')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(unmounts).toBe(1);
    expect(mounts).toBe(2);
  });

  it('a Retry that still fails returns to the announced failure, not a blank route', () => {
    thrown = new Error('render failed');
    shouldThrow = true;

    render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(FIXED_MESSAGE);
  });

  it('renders its children and no failure region when nothing throws', () => {
    const { rerender } = render(<ErrorBoundary><RouteSurface /></ErrorBoundary>);

    expect(screen.getByText('Route content 0')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(<ErrorBoundary><RouteSurface tick={1} /></ErrorBoundary>);

    expect(screen.getByText('Route content 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // A healthy route keeps its instance across re-renders: a boundary that
    // "passes by catching nothing" and remounts everything would fail here.
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it('keeps a caller-supplied fallback working', () => {
    thrown = new Error('render failed');
    shouldThrow = true;

    render(
      <ErrorBoundary fallback={<div>Custom recovery surface</div>}>
        <RouteSurface />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom recovery surface')).toBeInTheDocument();
    expect(screen.queryByText(FIXED_MESSAGE)).not.toBeInTheDocument();
  });
});
