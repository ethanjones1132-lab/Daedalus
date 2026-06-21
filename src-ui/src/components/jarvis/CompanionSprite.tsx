import { motion } from 'framer-motion';
import { memo } from 'react';
import { cn } from '../ui';
import type {
  CompanionRarity,
  CompanionSpecies,
  CompanionState,
} from './types';
import { RARITY_COLORS, RARITY_STARS } from './types';

// RECOVERY NOTE (2026-06-20):
//   The original CompanionSprite component was truncated in recovery.
//   This is a minimal stub that maintains the same interface so builds pass.
//   The full procedural sprite animation should be restored from transcripts.

interface CompanionSpriteProps {
  species?: CompanionSpecies;
  rarity?: CompanionRarity;
  state?: CompanionState;
  size?: 'sm' | 'md' | 'lg' | number;
  className?: string;
  cronAwareness?: string | null;
}

const sizeMap: Record<string, number> = {
  sm: 32,
  md: 48,
  lg: 64,
};

export const CompanionSprite = memo(function CompanionSprite({
  species = 'cat',
  rarity = 'common',
  state,
  size = 'md',
  className,
  cronAwareness,
}: CompanionSpriteProps) {
  const pixelSize = typeof size === 'number' ? size : sizeMap[size] ?? 48;
  const isHappy = state && state.happiness > 70;
  const isLowEnergy = state && state.energy < 30;

  return (
    <div className={cn('relative flex flex-col items-center', className)}>
      <motion.div
        className="relative"
        animate={{
          scale: isHappy ? [1, 1.05, 1] : 1,
          y: isLowEnergy ? [0, 2, 0] : 0,
        }}
        transition={{
          duration: isHappy ? 2 : 3,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        <svg
          width={pixelSize}
          height={pixelSize}
          viewBox="0 0 64 64"
          className="drop-shadow-lg"
        >
          {/* Simple placeholder sprite - a rounded shape with rarity color */}
          <motion.circle
            cx="32"
            cy="32"
            r="28"
            fill={RARITY_COLORS[rarity]}
            opacity={0.8}
            animate={{
              opacity: [0.7, 0.9, 0.7],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
          {/* Face */}
          <circle cx="24" cy="26" r="4" fill="currentColor" className="text-bone" />
          <circle cx="40" cy="26" r="4" fill="currentColor" className="text-bone" />
          <motion.path
            d={isHappy ? 'M 20 38 Q 32 48 44 38' : 'M 24 42 Q 32 38 40 42'}
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            className="text-bone"
            animate={{
              d: isHappy
                ? ['M 20 38 Q 32 48 44 38', 'M 20 40 Q 32 50 44 40', 'M 20 38 Q 32 48 44 38']
                : 'M 24 42 Q 32 38 40 42',
            }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          {/* Rarity indicator */}
          <text x="32" y="56" textAnchor="middle" fontSize="8" fill="currentColor" className="text-bone/60">
            {RARITY_STARS[rarity]}
          </text>
          {/* Species indicator */}
          <text x="32" y="14" textAnchor="middle" fontSize="6" fill="currentColor" className="text-bone/40 uppercase">
            {species.slice(0, 3)}
          </text>
        </svg>
      </motion.div>
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

export default CompanionSprite;
