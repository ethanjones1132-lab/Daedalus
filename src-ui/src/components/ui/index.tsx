import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { Component as ReactComponent, ReactNode, useEffect, useState, useCallback, useMemo, createContext, useContext } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ═══════════════════════════════════════════════════════════════
// ── Utility ──
// ═══════════════════════════════════════════════════════════════

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ═══════════════════════════════════════════════════════════════
// ── Motion / transitions ──
// ═══════════════════════════════════════════════════════════════

export function PageTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className={cn('h-full', className)}
    >
      {children}
    </motion.div>
  );
}

const gridContainerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};

const gridItemVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

export function AnimatedGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={gridContainerVariants}
      initial="hidden"
      animate="visible"
      className={cn('grid gap-4', className)}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.ul
      variants={gridContainerVariants}
      initial="hidden"
      animate="visible"
      className={cn('space-y-2', className)}
    >
      {children}
    </motion.ul>
  );
}

export function AnimatedListItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.li
      variants={gridItemVariants}
      className={cn(className)}
    >
      {children}
    </motion.li>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Card primitives ──
// ═══════════════════════════════════════════════════════════════

export function GlassCard({
  children,
  className,
  onClick,
  hover = false,
  hoverable = false,
  glowOnHover = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
  hoverable?: boolean;
  glowOnHover?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm',
        'shadow-[0_8px_24px_rgba(0,0,0,0.25)]',
        (hover || hoverable) && 'transition-colors hover:bg-white/[0.06] hover:border-white/20 cursor-pointer',
        onClick && 'cursor-pointer',
        glowOnHover && 'hover:shadow-[0_0_24px_rgba(124,92,255,0.18)] transition-shadow',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TiltCard({
  children,
  className,
  intensity = 'subtle',
  accent,
  glow,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  intensity?: 'subtle' | 'medium' | 'strong';
  accent?: 'cyan' | 'royal' | 'aurora' | string;
  glow?: boolean;
  onClick?: () => void;
}) {
  const intensityMap = {
    subtle: { rotateX: 2, rotateY: -2, scale: 1.01 },
    medium: { rotateX: 4, rotateY: -4, scale: 1.02 },
    strong: { rotateX: 6, rotateY: -6, scale: 1.03 },
  };

  const accentStyles: Record<string, string> = {
    cyan: 'hover:shadow-[0_0_24px_rgba(34,211,238,0.18)]',
    royal: 'hover:shadow-[0_0_24px_rgba(124,92,255,0.18)]',
    aurora: 'hover:shadow-[0_0_24px_rgba(139,92,246,0.18)]',
  };

  return (
    <motion.div
      whileHover={intensityMap[intensity]}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      onClick={onClick}
      className={cn(
        'transform-gpu',
        glow && 'shadow-[0_0_24px_rgba(124,92,255,0.12)]',
        accent && accentStyles[accent],
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Status indicators ──
// ═══════════════════════════════════════════════════════════════

export type StatusVariant = 'success' | 'info' | 'warn' | 'warning' | 'error' | 'default';

export function StatusDot({
  variant = 'default',
  pulse = false,
  ok,
  warn,
  size,
  className,
}: {
  variant?: StatusVariant;
  pulse?: boolean;
  ok?: boolean;
  warn?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const colorByVariant: Record<StatusVariant, string> = {
    success: 'bg-emerald-400',
    info: 'bg-cyan-400',
    warn: 'bg-amber-400',
    warning: 'bg-amber-400',
    error: 'bg-red-400',
    default: 'bg-bone/40',
  };
  // Allow boolean sugar: <StatusDot ok={...} warn={...} /> maps to variant.
  const resolvedVariant: StatusVariant = ok === true
    ? 'success'
    : warn === true
    ? 'warning'
    : variant;
  const sizeClass = size === 'sm' ? 'h-1.5 w-1.5' : size === 'lg' ? 'h-3 w-3' : 'h-2 w-2';
  return (
    <span
      className={cn(
        'inline-block rounded-full',
        sizeClass,
        colorByVariant[resolvedVariant],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

export function Pill({
  children,
  variant = 'default',
  className,
}: {
  children: ReactNode;
  variant?: StatusVariant;
  className?: string;
}) {
  const styles: Record<StatusVariant, string> = {
    success: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    info: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/30',
    warn: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    warning: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    error: 'bg-red-500/15 text-red-200 border-red-500/30',
    default: 'bg-white/5 text-bone/70 border-white/10',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        styles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Layout ──
// ═══════════════════════════════════════════════════════════════

export function SectionHeader({
  title,
  subtitle,
  count,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-end justify-between mb-4 gap-3',
        className,
      )}
    >
      <div>
        <h2 className="text-lg font-semibold text-bone tracking-tight">
          {title}
          {typeof count === 'number' && (
            <span className="ml-2 text-sm text-bone/40 font-normal">
              ({count})
            </span>
          )}
        </h2>
        {subtitle && (
          <p className="text-xs text-bone/50 mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

export function Label({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'muted' | 'faint' | 'dim';
}) {
  const toneStyles: Record<string, string> = {
    default: 'text-bone/60',
    muted: 'text-bone/40',
    faint: 'text-bone/30',
    dim: 'text-bone/50',
  };

  return (
    <span
      className={cn(
        'inline-block text-[10px] font-mono uppercase tracking-[0.18em]',
        toneStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── States ──
// ═══════════════════════════════════════════════════════════════

export function LoadingState({
  message = 'Loading…',
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center py-12 text-bone/40 text-sm',
        className,
      )}
    >
      <span className="animate-pulse">{message}</span>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 text-bone/50 text-sm gap-2',
        className,
      )}
    >
      <div className="text-red-300/80 text-xs">Error</div>
      <div className="text-bone/70 max-w-md text-center">{error}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 px-3 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  message = 'Nothing here yet.',
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center py-12 text-bone/40 text-sm',
        className,
      )}
    >
      {message}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Error boundary ──
// ═══════════════════════════════════════════════════════════════

export class ErrorBoundary extends ReactComponent<
  { children: ReactNode; fallback?: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <ErrorState error={this.state.error.message} />
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════
// ── Toast ──
// ═══════════════════════════════════════════════════════════════

export type ToastVariant = 'info' | 'success' | 'warn' | 'error';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  title?: string;
  variant: ToastVariant;
  action?: ToastAction;
}

export interface ToastContextValue {
  info: (message: string, title?: string, options?: unknown, action?: ToastAction) => void;
  success: (message: string, title?: string, options?: unknown, action?: ToastAction) => void;
  warn: (message: string, title?: string, options?: unknown, action?: ToastAction) => void;
  error: (message: string, title?: string, options?: unknown, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // No-op fallback so components can call useToast() outside a provider.
    const noop = () => undefined;
    return { info: noop, success: noop, warn: noop, error: noop };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Single stable notifier. Its identity (and the memoized `value` below) must NOT
  // change across renders: App.tsx lists `warn`/`error` in effect deps, so unstable
  // identities re-run that effect every render and re-fire toasts in a feedback loop.
  const notify = useCallback(
    (variant: ToastVariant, message: string, title?: string, _options?: unknown, action?: ToastAction) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, message, title, variant, action }]);
      // Auto-dismiss after 4s.
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      info: (message, title, options, action) => notify('info', message, title, options, action),
      success: (message, title, options, action) => notify('success', message, title, options, action),
      warn: (message, title, options, action) => notify('warn', message, title, options, action),
      error: (message, title, options, action) => notify('error', message, title, options, action),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className={cn(
                'pointer-events-auto rounded-xl border px-3 py-2 text-sm shadow-lg backdrop-blur',
                t.variant === 'success' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100',
                t.variant === 'error' && 'bg-red-500/10 border-red-500/30 text-red-100',
                t.variant === 'warn' && 'bg-amber-500/10 border-amber-500/30 text-amber-100',
                t.variant === 'info' && 'bg-cyan-500/10 border-cyan-500/30 text-cyan-100',
              )}
            >
              {t.title && <div className="text-xs font-semibold opacity-80 mb-0.5">{t.title}</div>}
              <div>{t.message}</div>
              {t.action && (
                <button
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="mt-2 text-xs font-medium underline underline-offset-2 hover:opacity-80 transition-opacity"
                >
                  {t.action.label}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Metric blocks ──
// ═══════════════════════════════════════════════════════════════

export function MetricBlock({
  label,
  value,
  hint,
  icon,
  variant: _variant = 'default',
  tone,
  className,
  size,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: string;
  variant?: StatusVariant;
  tone?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClass =
    size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-2xl' : 'text-lg';
  const toneColor = tone === 'cyan' ? 'text-cyan-neon' : tone === 'royal' ? 'text-royal-light' : tone === 'bone' ? 'text-bone' : 'text-bone';
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <Label>{label}</Label>
      <div className="flex items-baseline gap-1.5">
        {icon && <span className="text-[10px] opacity-50">{icon}</span>}
        <span className={cn('font-semibold', toneColor, sizeClass)}>
          {value}
        </span>
        {hint && <span className="text-[10px] text-bone/40">{hint}</span>}
      </div>
    </div>
  );
}

export function AnimatedNumber({
  value,
  duration = 0.6,
  className,
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    const start = display;
    const startTime = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - startTime) / (duration * 1000));
      setDisplay(start + (value - start) * t);
      if (t < 1) requestAnimationFrame(step);
    };
    step();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);
  return <span className={cn('tabular-nums', className)}>{Math.round(display)}</span>;
}

// ═══════════════════════════════════════════════════════════════
// ── Progress Bar ──
// ═══════════════════════════════════════════════════════════════

export function ProgressBar({
  percent,
  className,
  size = 'md',
  variant = 'default',
}: {
  percent: number;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'warning' | 'error';
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const sizeClass = {
    sm: 'h-1',
    md: 'h-2',
    lg: 'h-3',
  }[size];

  const variantColor = {
    default: 'bg-cyan-neon',
    success: 'bg-emerald-400',
    warning: 'bg-amber-400',
    error: 'bg-red-400',
  }[variant];

  return (
    <div className={cn('w-full bg-white/10 rounded-full overflow-hidden', sizeClass, className)}>
      <motion.div
        className={cn('h-full rounded-full', variantColor)}
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Sidebar Navigation Item ──
// ═══════════════════════════════════════════════════════════════

export function SidebarNavItem({
  icon,
  label,
  isActive,
  onClick,
  className,
}: {
  icon: string;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
        isActive
          ? 'bg-cyan-neon/15 text-cyan-neon border border-cyan-neon/30'
          : 'text-bone-dim hover:text-bone hover:bg-white/[0.04] border border-transparent',
        className
      )}
    >
      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-mono opacity-70">
        {icon}
      </span>
      <span>{label}</span>
      {isActive && (
        <motion.div
          layoutId="activeIndicator"
          className="ml-auto w-1 h-1 rounded-full bg-cyan-neon"
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      )}
    </motion.button>
  );
}
