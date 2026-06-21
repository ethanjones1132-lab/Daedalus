// ═══════════════════════════════════════════════════════════════
// ── MythosCompanionSprite — the luxe drop-in replacement ──
// ═══════════════════════════════════════════════════════════════

import { memo } from 'react';
import { motion } from 'framer-motion';
import type { CompanionRarity, CompanionSpecies, CompanionState } from './types';
import { RARITY_COLORS } from './types';

// RECOVERY NOTE (2026-06-19):
//   The original MythosCompanionSprite wrapped two sibling modules
//   (./CompanionSprite and ./MythosBuddy) that were both lost in
//   the recovered tree. The MythosBuddy asset in particular is a
//   procedural SVG path art, so a future recovery pass should port
//   the transcript-derived file back. For now this stub renders a
//   pulsing rune that respects the rarity / species / state props so
//   the App.tsx layout doesn't crash and the panel animations work.

interface MythosCompanionSpriteProps {
  rarity?: CompanionRarity;
  species?: CompanionSpecies;
  state?: CompanionState;
  size?: number;
  className?: string;
  cronAwareness?: string | null;
}

export const MythosCompanionSprite = memo(function MythosCompanionSprite(
  props: MythosCompanionSpriteProps,
) {
  const { rarity = 'common', state, size = 64, className, cronAwareness } = props;
  const tint = RARITY_COLORS[rarity];
  const isAgitated = state?.mood === 'thinking' || state?.mood === 'excited';

  return (
    <div className="relative flex flex-col items-center">
      <motion.svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      animate={{ rotate: isAgitated ? [0, -3, 3, 0] : 0 }}
      transition={{
        duration: 2.5,
        repeat: isAgitated ? Infinity : 0,
        ease: 'easeInOut',
      }}
    >
      <defs>
        <radialGradient id="mythos-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#mythos-glow)" />
      <path
        d="M32 6 L52 22 L52 42 L32 58 L12 42 L12 22 Z"
        className={tint}
        fillOpacity="0.18"
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="1.2"
      />
      <circle cx="32" cy="32" r="6" className={tint} />
    </motion.svg>
    {cronAwareness && (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-bone/50 font-mono"
      >
        {cronAwareness}
      </motion.div>
    )}
    </div>
  );
});

export default MythosCompanionSprite;
