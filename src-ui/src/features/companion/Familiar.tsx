import { useId } from 'react';
import { cn } from '../../design';
import type { CompanionRarity, CompanionSpecies, CompanionState } from '../../domain/types';

type CompanionMood = CompanionState['mood'];

/*
 * The Familiar — Jarvis' companion, drawn as a small brass automaton.
 *
 * One parametric body (a soft lozenge on a pedestal) with species "parts"
 * (ears, horns, antenna, shell, cap…) so all nineteen species read as distinct
 * silhouettes without nineteen bespoke illustrations. Mood drives eyes and
 * motion; rarity drives the halo. Purely decorative: callers render the
 * companion's name and state as text.
 */

const RARITY_HALO: Record<CompanionRarity, string> = {
  common: 'var(--d-ink-4)',
  uncommon: 'var(--d-ok)',
  rare: 'var(--d-info)',
  epic: 'var(--d-warn)',
  legendary: 'var(--d-accent-hot)',
};

type Part = 'cat' | 'owl' | 'bat' | 'rabbit' | 'horns' | 'antenna' | 'shell' | 'cap' | 'spikes' | 'fins' | 'tentacles' | 'ghost' | 'beak' | 'none';

const SPECIES_PART: Record<CompanionSpecies, Part> = {
  cat: 'cat',
  owl: 'owl',
  bat: 'bat',
  rabbit: 'rabbit',
  dragon: 'horns',
  robot: 'antenna',
  turtle: 'shell',
  snail: 'shell',
  mushroom: 'cap',
  cactus: 'spikes',
  axolotl: 'fins',
  octopus: 'tentacles',
  ghost: 'ghost',
  duck: 'beak',
  goose: 'beak',
  penguin: 'beak',
  blob: 'none',
  capybara: 'none',
  chonk: 'none',
};

function Parts({ part, stroke }: { part: Part; stroke: string }) {
  const s = { stroke, strokeWidth: 1.4, fill: 'var(--d-raised)', strokeLinejoin: 'round' as const };
  switch (part) {
    case 'cat':
      return (
        <>
          <path d="M19 22 L21 11 L28 19 Z" {...s} />
          <path d="M45 22 L43 11 L36 19 Z" {...s} />
        </>
      );
    case 'owl':
      return (
        <>
          <path d="M18 20 L17 12 L26 17 Z" {...s} />
          <path d="M46 20 L47 12 L38 17 Z" {...s} />
        </>
      );
    case 'bat':
      return (
        <>
          <path d="M18 24 L12 10 L27 18 Z" {...s} />
          <path d="M46 24 L52 10 L37 18 Z" {...s} />
        </>
      );
    case 'rabbit':
      return (
        <>
          <rect x="22" y="2" width="6" height="18" rx="3" {...s} />
          <rect x="36" y="2" width="6" height="18" rx="3" {...s} />
        </>
      );
    case 'horns':
      return (
        <>
          <path d="M22 18 Q18 9 22 5 Q24 12 28 16" {...s} />
          <path d="M42 18 Q46 9 42 5 Q40 12 36 16" {...s} />
        </>
      );
    case 'antenna':
      return (
        <>
          <line x1="32" y1="15" x2="32" y2="6" stroke={stroke} strokeWidth="1.4" />
          <circle cx="32" cy="5" r="2.2" fill={stroke} className="d-pulse" />
        </>
      );
    case 'cap':
      return <path d="M14 26 Q32 2 50 26 Z" {...s} fill="var(--d-accent-wash)" />;
    case 'spikes':
      return (
        <g stroke={stroke} strokeWidth="1.2" strokeLinecap="round">
          <line x1="24" y1="16" x2="22" y2="11" />
          <line x1="32" y1="14" x2="32" y2="8" />
          <line x1="40" y1="16" x2="42" y2="11" />
        </g>
      );
    case 'fins':
      return (
        <g stroke={stroke} strokeWidth="1.3" strokeLinecap="round" fill="none">
          <path d="M17 26 l-6 -3 M17 30 l-7 0 M17 34 l-6 3" />
          <path d="M47 26 l6 -3 M47 30 l7 0 M47 34 l6 3" />
        </g>
      );
    case 'shell':
      return <path d="M40 46 Q56 44 52 30 Q50 22 42 24" {...s} fill="var(--d-accent-wash)" />;
    default:
      return null;
  }
}

export interface FamiliarProps {
  species?: CompanionSpecies | string;
  rarity?: CompanionRarity | string;
  mood?: CompanionMood | string;
  size?: number;
  className?: string;
  /** Show the turn-is-running glow. */
  live?: boolean;
}

export function Familiar({ species = 'cat', rarity = 'rare', mood = 'idle', size = 48, className, live }: FamiliarProps) {
  const gid = `fam${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const part = SPECIES_PART[species as CompanionSpecies] ?? 'none';
  const halo = RARITY_HALO[rarity as CompanionRarity] ?? RARITY_HALO.common;
  const stroke = 'var(--d-accent)';
  const sleeping = mood === 'sleeping';
  const happy = mood === 'happy' || mood === 'excited';
  const thinking = mood === 'thinking';
  const bodyPath =
    part === 'ghost'
      ? 'M17 32 Q17 16 32 16 Q47 16 47 32 L47 46 L43 43 L39 46 L35 43 L32 46 L29 43 L25 46 L21 43 L17 46 Z'
      : part === 'tentacles'
        ? 'M17 32 Q17 15 32 15 Q47 15 47 32 Q47 40 44 42 L45 49 M40 43 L40 50 M32 44 L32 51 M24 43 L24 50 M20 42 L19 49 Q17 40 17 32 Z'
        : 'M16 33 Q16 16 32 16 Q48 16 48 33 Q48 46 32 46 Q16 46 16 33 Z';

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cn('shrink-0 overflow-visible', (thinking || mood === 'excited') && 'animate-[d-bob_2.4s_ease-in-out_infinite]', className)}
      style={{ ['--tw' as string]: 0 }}
    >
      <defs>
        <radialGradient id={gid} cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor={halo} stopOpacity={live ? 0.45 : 0.22} />
          <stop offset="100%" stopColor={halo} stopOpacity="0" />
        </radialGradient>
      </defs>
      <style>{`@keyframes d-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}`}</style>
      <circle cx="32" cy="32" r="30" fill={`url(#${gid})`} className={live ? 'd-pulse' : undefined} />
      {/* pedestal */}
      <path d="M22 52 H42 L40 56 H24 Z" fill="var(--d-raised)" stroke="var(--d-line-strong)" strokeWidth="1" />
      <line x1="20" y1="52" x2="44" y2="52" stroke={halo} strokeWidth="1" opacity="0.8" />
      <Parts part={part} stroke={stroke} />
      <path d={bodyPath} fill="var(--d-raised)" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      {/* engraved seam */}
      <path d="M21 38 Q32 42 43 38" stroke="var(--d-line-strong)" strokeWidth="1" fill="none" />
      {part === 'beak' && <path d="M29 33 L35 33 L32 36.5 Z" fill={stroke} />}
      {/* eyes */}
      {sleeping ? (
        <g stroke="var(--d-ink-2)" strokeWidth="1.5" strokeLinecap="round" fill="none">
          <path d="M23.5 29 q2.5 2 5 0" />
          <path d="M35.5 29 q2.5 2 5 0" />
        </g>
      ) : happy ? (
        <g stroke="var(--d-accent-hot)" strokeWidth="1.7" strokeLinecap="round" fill="none">
          <path d="M23.5 30 q2.5 -3 5 0" />
          <path d="M35.5 30 q2.5 -3 5 0" />
        </g>
      ) : (
        <g>
          <circle cx="26" cy="29" r="2.6" fill="var(--d-accent-hot)" />
          <circle cx="38" cy="29" r="2.6" fill="var(--d-accent-hot)" />
          {thinking && <circle cx="27" cy="28" r="0.9" fill="var(--d-accent-ink)" />}
          {thinking && <circle cx="39" cy="28" r="0.9" fill="var(--d-accent-ink)" />}
        </g>
      )}
      {sleeping && (
        <text x="46" y="16" fontFamily="var(--font-mono)" fontSize="7" fill="var(--d-ink-3)">
          z
        </text>
      )}
    </svg>
  );
}
