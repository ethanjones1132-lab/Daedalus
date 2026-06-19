import { AnimatePresence, motion } from 'framer-motion';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../ui';
import type {
  CompanionRarity,
  CompanionSpecies,
  CompanionState,
} from './types';
import { RARITY_COLORS, RARITY_STARS } from './types';

type ToneKey =
  | 'body'
  | 'bodyLight'
  | 'bodyDark'
  | 'belly'
  | 'accent'
  | 'accentLight'
  | 'accentDark'
  | 'line'
  | 'face'
  | 'cheek';

type PaintToken =
  | ToneKey
  | 'rarity'
  | 'none'
  | 'bodyGradient'
  | 'accentGradient'
  | 'rarityGradient'
  | (string & {});

type Palette = Record<ToneKey, string>;

type LayerMotion =
  | 'none'
  | 'breathe'
  | 'bob'
  | 'sway'
  | 'tail'
  | 'wing'
  | 'pulse'
  | 'tentacle'
  | 'antenna';

type BaseLayer = {
  id: string;
  fill?: PaintToken;
  stroke?: PaintToken;
  strokeWidth?: number;
  opacity?: number;
  motion?: LayerMotion;
  origin?: string;
  delay?: number;
  linecap?: 'butt' | 'round' | 'square';
  linejoin?: 'round' | 'miter' | 'bevel';
  filter?: 'softGlow' | 'inkShadow';
};

type EllipseLayer = BaseLayer & {
  kind: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

type CircleLayer = BaseLaye