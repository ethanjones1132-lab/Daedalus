import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import { ToastProvider, useToast, type ToastContextValue } from './index';

describe('ToastProvider', () => {
  // Regression: the action-registry alerts effect in App.tsx lists the toast
  // callbacks (`warn`, `error`) in its dependency array. If those identities
  // change on every render, the effect re-runs and re-fires toasts; each toast
  // re-renders the provider, producing a feedback loop that spams the screen.
  // The provider must therefore expose referentially stable callbacks.
  it('exposes referentially stable toast callbacks across re-renders', () => {
    const captured: ToastContextValue[] = [];
    let forceRerender: () => void = () => {};

    function Capture() {
      captured.push(useToast());
      return null;
    }
    function Harness() {
      const [, setN] = useState(0);
      forceRerender = () => setN((n) => n + 1);
      return (
        <ToastProvider>
          <Capture />
        </ToastProvider>
      );
    }

    render(<Harness />);
    act(() => forceRerender());
    act(() => forceRerender());

    expect(captured.length).toBeGreaterThanOrEqual(3);
    const first = captured[0];
    const last = captured[captured.length - 1];
    expect(last.warn).toBe(first.warn);
    expect(last.error).toBe(first.error);
    expect(last.info).toBe(first.info);
    expect(last.success).toBe(first.success);
  });
});
