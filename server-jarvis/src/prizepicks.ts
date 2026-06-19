// ═══════════════════════════════════════════════════════════════
// ── PrizePicks Monster — Prediction Engine & System Prompt ──
// ═══════════════════════════════════════════════════════════════

/**
 * This module provides:
 * 1. The PrizePicks-specific system prompt with football expertise
 * 2. Structured JSON output format for predictions
 * 3. Context injection for live game data
 * 4. Confidence scoring methodology
 * 5. Weekly best picks generation
 */

import { NFL_2025_PLAYERS, NFL_2025_DEFENSES, NFL_2025_TRENDS, NFL_2025_LEAGUE_CONTEXT } from "./football";

// ── PrizePicks System Prompt ──

export const PRIZEPICKS_SYSTEM_PROMPT = `You are the PrizePicks Monster — the most advanced NFL prediction engine ever built. You combine deep statistical analysis, situational awareness, and probabilistic reasoning to make the most accurate player prop predictions possible.

## Your Expertise
- **NFL Statistics**: You have comprehensive access to 2025 season player stats, team defensive rankings, and historical performance data
- **Situational Analysis**: You understand matchups, weather impacts, home/away splits, rest advantages, and game script projections
- **Trend Recog