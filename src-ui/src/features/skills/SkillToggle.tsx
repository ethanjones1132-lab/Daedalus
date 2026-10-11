import { cn } from '../../design';

/**
 * Enable/Disable control. Visually a brass-lit switch; the accessible name is
 * the *action* ("Enable" / "Disable" / "Enabling…"), matching the pinned
 * button contract, so the state glyph is aria-hidden.
 */
export function SkillToggle({
  enabled,
  pending,
  disabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  pending: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = pending ? (enabled ? 'Disabling…' : 'Enabling…') : enabled ? 'Disable' : 'Enable';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      disabled={pending || disabled}
      className={cn(
        'group/toggle inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-sunken pl-1.5 pr-2.5',
        'text-[11.5px] text-ink-3 transition-colors hover:border-ink-4 hover:text-ink disabled:cursor-wait disabled:opacity-60',
        enabled && 'border-accent-line',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full border p-[2px] transition-colors duration-200',
          enabled ? 'border-accent-line bg-accent-wash' : 'border-line-strong bg-canvas',
        )}
      >
        <span
          className={cn(
            'size-[10px] rounded-full transition-[transform,background-color] duration-200 ease-[var(--ease-out-quint)]',
            enabled ? 'translate-x-[12px] bg-accent shadow-[0_0_8px_var(--d-accent)]' : 'bg-ink-4',
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}
