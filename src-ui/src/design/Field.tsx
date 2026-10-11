import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Search, X } from 'lucide-react';
import { cn } from './cn';

const control =
  'w-full rounded-[7px] border border-line-strong bg-sunken text-ink placeholder:text-ink-4 ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ' +
  'hover:border-ink-4 focus:outline-none focus-visible:outline-none focus:border-accent-line focus:bg-surface focus:shadow-[0_0_0_3px_var(--d-accent-wash)] ' +
  'disabled:opacity-50 disabled:cursor-not-allowed aria-[invalid=true]:border-err/60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cn(control, 'h-8 px-2.5 text-[13px]', mono && 'font-mono text-[12px]', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(control, 'min-h-20 px-2.5 py-2 text-[13px] leading-relaxed resize-y', mono && 'font-mono text-[12px]', className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'h-8 appearance-none bg-[length:10px] bg-[right_10px_center] bg-no-repeat pl-2.5 pr-8 text-[13px]',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23847b6d' fill='none' stroke-width='1.4'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render-prop receives the generated id so the control can bind to the label. */
  children: (id: string) => ReactNode;
  className?: string;
  inline?: boolean;
}

/** Label + control + hint, with a real <label htmlFor>. */
export function Field({ label, hint, error, children, className, inline }: FieldProps) {
  const id = useId();
  return (
    <div className={cn(inline ? 'flex items-center justify-between gap-4' : 'flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-[11.5px] leading-snug text-ink-3">{hint}</p>}
      {error && <p className="text-[11.5px] leading-snug text-err">{error}</p>}
    </div>
  );
}

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the clear button; omit to hide it. */
  clearLabel?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, clearLabel = 'Clear filter', className, ...rest },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(control, 'h-8 pl-8 pr-7 text-[12.5px]')}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-4 hover:bg-hover hover:text-ink"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
});
