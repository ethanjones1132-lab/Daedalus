import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn, Meter, VisuallyHidden } from '../../design';
import { useNavigation } from '../../shell/navigation';
import { Familiar } from './Familiar';
import { useCompanionSignals, useRefreshOn } from './companion-store';
import { describeCompanion, pct, RARITY_TEXT, raritySentence, rarityOf } from './companion-view';
import { RARITY_STARS } from '../../domain/types';

/*
 * The companion dock sits at the bottom of the rail: the Familiar, its name and
 * the cron-awareness sentence. The awareness sentence lives in a polite
 * live region (always mounted, visually hidden when the rail is collapsed) so
 * changes are announced without stealing focus. Clicking opens a read-only card.
 */

export default function CompanionDock({ collapsed }: { collapsed: boolean }) {
  const signals = useCompanionSignals();
  const { route } = useNavigation();
  useRefreshOn(route === 'cron');
  const display = describeCompanion(signals);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const companion = display.kind === 'ready' ? display.companion : null;

  return (
    <div className={cn('flex min-w-0 flex-col', collapsed ? 'items-center' : 'gap-1')}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={collapsed ? `${display.name}, companion. ${display.line}` : undefined}
        title={collapsed ? `${display.name} · ${display.line}` : undefined}
        className={cn(
          'group flex min-w-0 items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-hover',
          collapsed ? 'p-0.5' : 'w-full p-1',
          open && 'bg-hover',
        )}
      >
        <Familiar
          size={collapsed ? 36 : 40}
          species={companion?.species}
          rarity={companion?.rarity}
          mood={companion?.mood}
        />
        {!collapsed && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[13px] font-medium text-ink">{display.name}</span>
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{display.line}</span>
          </span>
        )}
      </button>

      <div
        role="status"
        aria-live="polite"
        aria-label="Cron awareness"
        className={cn(collapsed ? 'sr-only' : 'line-clamp-2 px-1 text-[11px] leading-snug text-ink-3')}
      >
        {signals.awareness}
      </div>

      {open && (
        <CompanionCard
          id={cardId}
          anchor={triggerRef}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          awareness={signals.awareness}
          stale={signals.companionStale}
          display={display}
        />
      )}
    </div>
  );
}

function CompanionCard({
  id,
  anchor,
  onClose,
  awareness,
  stale,
  display,
}: {
  id: string;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  awareness: string;
  stale: boolean;
  display: ReturnType<typeof describeCompanion>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 16, bottom: 16 });
  const companion = display.kind === 'ready' ? display.companion : null;

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    // Open beside the rail (not over it) so the nav stays readable.
    const rail = anchor.current?.closest('aside')?.getBoundingClientRect();
    setPos({ left: Math.max(12, (rail?.right ?? rect.right) + 10), bottom: Math.max(12, window.innerHeight - rect.bottom) });
  }, [anchor]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    const onClose = () => closeRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [anchor]);

  const rarity = rarityOf(companion?.rarity);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={`${display.name} companion`}
      tabIndex={-1}
      style={{ left: pos.left, bottom: pos.bottom }}
      className="d-rise fixed z-50 w-[300px] rounded-xl border border-line-strong bg-overlay p-4 text-ink shadow-pop outline-none"
    >
      <div className="flex items-center gap-3">
        <Familiar size={64} species={companion?.species} rarity={companion?.rarity} mood={companion?.mood} />
        <div className="min-w-0">
          <p className="d-display truncate text-[26px] leading-none">{display.name}</p>
          {companion ? (
            <p className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-2">
              <span className="capitalize">{companion.species}</span>
              <span aria-label={`Rarity ${raritySentence(rarity)}`} className={cn('font-mono tracking-[0.12em]', RARITY_TEXT[rarity])}>
                {RARITY_STARS[rarity]}
              </span>
            </p>
          ) : (
            <p className="mt-1.5 text-[12px] text-ink-3">{display.line}</p>
          )}
        </div>
      </div>

      {companion && (
        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="d-label">Level {companion.level}</span>
              <span className="font-mono text-[11px] text-ink-3 tabular">
                {companion.xp} / {companion.xp_to_next} XP
              </span>
            </div>
            <Meter value={pct(companion.xp, companion.xp_to_next)} tone="accent" label={`Level ${companion.level} experience`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="d-label">Happiness</span>
                <span className="font-mono text-[11px] text-ink-3 tabular">{Math.round(companion.happiness)}%</span>
              </div>
              <Meter value={companion.happiness} tone="ok" label="Happiness" />
            </div>
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="d-label">Energy</span>
                <span className="font-mono text-[11px] text-ink-3 tabular">{Math.round(companion.energy)}%</span>
              </div>
              <Meter value={companion.energy} tone="info" label="Energy" />
            </div>
          </div>
          <p className="text-[12px] text-ink-2">
            <span className="d-label mr-2">Mood</span>
            <span className="capitalize">{companion.mood}</span>
          </p>
          {companion.current_message && (
            <blockquote className="border-l-2 border-accent-line pl-3 text-[12.5px] italic leading-snug text-ink-2">
              {companion.current_message}
            </blockquote>
          )}
        </div>
      )}

      <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-snug text-ink-3">{awareness}</p>
      {stale && <p className="mt-1.5 text-[11.5px] text-warn">Could not refresh the companion; showing the last observation.</p>}
      <VisuallyHidden>Press Escape to close.</VisuallyHidden>
    </div>,
    document.body,
  );
}
