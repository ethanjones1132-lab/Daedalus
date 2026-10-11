import type { CompanionRarity, CompanionState } from '../../domain/types';
import { RARITY_STARS } from '../../domain/types';
import type { CompanionSignals } from './companion-store';

/** Rarity -> token utility (the legacy used a hex value as a class name, which tinted nothing). */
export const RARITY_TEXT: Record<CompanionRarity, string> = {
  common: 'text-ink-3',
  uncommon: 'text-ok',
  rare: 'text-info',
  epic: 'text-accent',
  legendary: 'text-accent-hot',
};

export function rarityOf(value: string | undefined): CompanionRarity {
  return value && value in RARITY_STARS ? (value as CompanionRarity) : 'common';
}

export function raritySentence(rarity: CompanionRarity): string {
  const stars = RARITY_STARS[rarity].length;
  return `${rarity}, ${stars} of 5 stars`;
}

export type CompanionDisplay =
  | { kind: 'pending'; name: string; line: string }
  | { kind: 'unavailable'; name: string; line: string }
  | { kind: 'none'; name: string; line: string }
  | { kind: 'ready'; name: string; line: string; companion: CompanionState };

/** What to call the companion and what to say about it, from the honest load state. */
export function describeCompanion(signals: Pick<CompanionSignals, 'companion' | 'companionLoad' | 'companionStale'>): CompanionDisplay {
  const { companion, companionLoad } = signals;
  if (companion) {
    if (!companion.enabled) return { kind: 'none', name: companion.name || 'Companion', line: 'Companion is switched off.' };
    return { kind: 'ready', name: companion.name || 'Companion', line: `${companion.mood} · Lv ${companion.level}`, companion };
  }
  if (companionLoad === 'pending') return { kind: 'pending', name: 'Companion', line: 'Waking up…' };
  if (companionLoad === 'unavailable') return { kind: 'unavailable', name: 'Companion', line: 'Companion unavailable.' };
  return { kind: 'none', name: 'Companion', line: 'No companion hatched yet.' };
}

export const pct = (value: number, of = 100) => (of > 0 ? Math.max(0, Math.min(100, (value / of) * 100)) : 0);
