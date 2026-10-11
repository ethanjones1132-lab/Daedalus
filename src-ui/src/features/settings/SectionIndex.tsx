import { useEffect, useState } from 'react';
import { cn } from '../../design';
import { sectionDomId, type SectionDef, type SectionId } from './config-draft';

/**
 * Tracks which section is under the top of the viewport. IntersectionObserver
 * is unavailable in some environments (jsdom); the index then simply follows
 * clicks.
 */
function useScrollSpy(ids: SectionId[]): [SectionId | null, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId | null>(ids[0] ?? null);
  const key = ids.join('|');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<SectionId>();
    const first = document.getElementById(sectionDomId(ids[0]));
    const scroller = first?.closest<HTMLElement>('.overflow-y-auto') ?? null;
    const atBottom = () => scroller !== null && scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;

    // The last section (in index order) inside the activation band wins; at the
    // very bottom the final section wins, since it can never reach the band.
    const pick = () => {
      if (atBottom()) return setActive(ids[ids.length - 1]);
      // Above the first section's anchor the first entry is current, not whatever was last in the band.
      if (scroller && scroller.scrollTop <= 4) return setActive(ids[0]);
      const inBand = ids.filter((id) => visible.has(id));
      if (inBand.length > 0) setActive(inBand[inBand.length - 1]);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.settingsSection as SectionId | undefined;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        pick();
      },
      // A thin activation band in the upper part of the scroll viewport.
      { rootMargin: '-14% 0px -76% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(sectionDomId(id));
      if (el) observer.observe(el);
    }
    scroller?.addEventListener('scroll', pick, { passive: true });
    pick();
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', pick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [active, setActive];
}

/** The sticky left-hand index of settings sections, with scroll-spy. */
export function SectionIndex({ sections }: { sections: SectionDef[] }) {
  const [active, setActive] = useScrollSpy(sections.map((s) => s.id));

  const jump = (id: SectionId) => {
    setActive(id);
    const el = document.getElementById(sectionDomId(id));
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <nav aria-label="Settings sections" className="sticky top-8 hidden self-start lg:block">
      <ol className="space-y-px border-l border-line">
        {sections.map((s) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-current={on ? 'location' : undefined}
                onClick={() => jump(s.id)}
                className={cn(
                  '-ml-px block w-full border-l py-1.5 pl-3.5 pr-2 text-left text-[12.5px] transition-colors duration-150',
                  on ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:border-line-strong hover:text-ink-2',
                )}
              >
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
