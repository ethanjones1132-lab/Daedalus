import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import { cn } from './cn';

/*
 * Toasts. Contract (tested by design/toast-*.test.tsx):
 *  - two ALWAYS-mounted live regions: polite (info, success) and assertive (warn, error)
 *  - each toast: role=status (polite) or role=alert (assertive), aria-atomic
 *  - warn, error, and any toast with an action are persistent; others auto-dismiss at 4 s
 *  - an action runs once, then dismisses; it never steals focus
 *  - the API object is referentially stable; useToast() outside a provider is a no-op
 */

export type ToastVariant = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  title?: string;
  variant: ToastVariant;
  action?: ToastAction;
}

type Notify = (message: string, title?: string, options?: unknown, action?: ToastAction) => void;

export interface ToastContextValue {
  info: Notify;
  success: Notify;
  warn: Notify;
  error: Notify;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const noop = () => undefined;
const NOOP_API: ToastContextValue = { info: noop, success: noop, warn: noop, error: noop };

export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? NOOP_API;
}

const isPersistent = (t: Pick<ToastItem, 'variant' | 'action'>) =>
  t.variant === 'warn' || t.variant === 'error' || Boolean(t.action);

const ICONS = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: OctagonAlert } as const;
const ACCENT = { info: 'text-info', success: 'text-ok', warn: 'text-warn', error: 'text-err' } as const;
const RULE = { info: 'bg-info', success: 'bg-ok', warn: 'bg-warn', error: 'bg-err' } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismissed = useRef(new Set<number>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    if (dismissed.current.has(id)) return;
    dismissed.current.add(id);
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const all = timers.current;
    return () => {
      all.forEach((t) => clearTimeout(t));
      all.clear();
    };
  }, []);

  const notify = useCallback(
    (variant: ToastVariant, message: string, title?: string, action?: ToastAction) => {
      const id = Date.now() + Math.random();
      const toast: ToastItem = { id, message, title, variant, action };
      setToasts((prev) => [...prev, toast]);
      if (!isPersistent(toast)) timers.current.set(id, setTimeout(() => dismiss(id), 4000));
    },
    [dismiss],
  );

  const api = useMemo<ToastContextValue>(
    () => ({
      info: (m, t, _o, a) => notify('info', m, t, a),
      success: (m, t, _o, a) => notify('success', m, t, a),
      warn: (m, t, _o, a) => notify('warn', m, t, a),
      error: (m, t, _o, a) => notify('error', m, t, a),
    }),
    [notify],
  );

  const render = (items: ToastItem[]) =>
    items.map((t) => {
      const assertive = t.variant === 'warn' || t.variant === 'error';
      const Icon = ICONS[t.variant];
      return (
        <div
          key={t.id}
          role={assertive ? 'alert' : 'status'}
          aria-live={assertive ? 'assertive' : 'polite'}
          aria-atomic="true"
          className="d-rise pointer-events-auto relative flex w-[340px] gap-3 overflow-hidden rounded-[10px] border border-line-strong bg-overlay py-2.5 pl-3.5 pr-2.5 shadow-pop"
        >
          <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[2px]', RULE[t.variant])} />
          <Icon aria-hidden="true" className={cn('mt-[2px] size-4 shrink-0', ACCENT[t.variant])} />
          <div className="min-w-0 flex-1">
            {t.title && <div className="text-[12.5px] font-semibold text-ink">{t.title}</div>}
            <div className="text-[12.5px] leading-snug text-ink-2">{t.message}</div>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  if (dismissed.current.has(t.id)) return;
                  try {
                    t.action?.onClick();
                  } finally {
                    dismiss(t.id);
                  }
                }}
                className="mt-1.5 text-[12px] font-medium text-accent-hot underline decoration-accent-line underline-offset-[3px] hover:decoration-accent-hot"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded text-ink-4 hover:bg-hover hover:text-ink"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      );
    });

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-10 right-4 z-[80] flex flex-col items-end gap-2">
        <div aria-live="polite" aria-atomic="false" className="flex flex-col items-end gap-2">
          {render(toasts.filter((t) => t.variant === 'info' || t.variant === 'success'))}
        </div>
        <div aria-live="assertive" aria-atomic="false" className="flex flex-col items-end gap-2">
          {render(toasts.filter((t) => t.variant === 'warn' || t.variant === 'error'))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
