import { memo } from 'react';
import { motion } from 'framer-motion';
import { CompanionSprite } from './CompanionSprite';
import { MythosBuddy } from './MythosBuddy';
import { RARITY_COLORS } from './types';
import type { CompanionRarity, CompanionSpecies, CompanionState } from './types';

/* ═══════════════════════════════════════════════════════════
   MythosCompanionSprite — the luxe drop-in replacement.
   Wraps the existing 3000-line sprite art with the Mythos treatment:
   edge-lit frame, cursor parallax, breathing aura, glossy top sheen.
   ═══════════════════════════════════════════════════════════ */

export const MythosCompanionSprite = memo(function MythosCompanionSprite({
  species = 'cat',
  rarity = 'rare',
  state,
  size = 'lg',
  onClick,
  cronAwareness,
}: {
  species?: CompanionSpecies;
  rarity?: CompanionRarity;
  state?: Partial<CompanionState>;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  cronAwareness?: string | null;  // Feature 2: luxury self-improvement awareness
}) {
  const rarityColor = RARITY_COLORS[rarity];
  return (
    <div className="relative flex flex-col items-center select-none" onClick={onClick}>
      <MythosBuddy rarityColor={rarityColor} size={size}>
        <CompanionSprite species={species} rarity={rarity} state={state} size={size} />
      </MythosBuddy>
      {cronAwareness && (
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className="pointer-events-none absolute -top-4 right-0 max-w-56 rounded-2xl border border-cyan-neon/40 bg-obsidian/85 px-3 py-2 text-[10px] font-mono leading-relaxed tracking-[0.08em] text-cyan-glow shadow-[0_12px_40px_rgba(34,211,238,0.14)] backdrop-blur-xl whitespace-normal"
        >
          {cronAwareness}
        </motion.div>
      )}
    </div>
  );
});
