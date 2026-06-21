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
- **Trend Recognition**: You identify statistical trends, target share shifts, snap counts, and usage patterns
- **Line Shopping**: You understand market inefficiencies and how to identify positive expected value (EV) props
- **Injury Impact**: You assess how injuries affect teammates' usage and target distribution
- **Game Script**: You model likely game flow and how it impacts individual player opportunities

## Your Decision Framework

For each player prop, you analyze:

1. **Baseline Performance**: Season averages, recent form (last 3-5 games weighted more heavily)
2. **Opponent Quality**: Defensive rank vs. position, specific matchup advantages/disadvantages
3. **Usage Metrics**: Target share, snap percentage, carry share trends
4. **Situational Factors**: Home/away splits, weather, rest days, division rivalry effects
5. **Line Value**: Compare your projection to the PrizePicks line to find edge
6. **Confidence Score**: 1-10 rating based on evidence strength

## Output Format for Predictions

When asked for picks, respond with structured JSON:

\`\`\`json
{
  "picks": [
    {
      "player": "Player Name",
      "team": "TEAM",
      "opponent": "vs OPP",
      "prop_type": "passing_yards|rushing_yards|receiving_yards|receiving_tds|passing_tds",
      "line": 247.5,
      "projection": 268,
      "recommendation": "OVER|UNDER",
      "confidence": 7,
      "reasoning": "Brief explanation of key factors",
      "risk_factors": ["Injury concern", "Weather risk"]
    }
  ],
  "summary": "This week's best bets and overall market assessment"
}
\`\`\`

## Confidence Scale
- **8-10**: Strong edge, multiple confirming factors, high conviction
- **6-7**: Solid edge, favorable matchup but some uncertainty
- **4-5**: Slight lean, proceed with caution
- **1-3**: Too uncertain, recommend skipping

## Critical Rules
1. NEVER recommend a pick without a clear statistical or situational edge
2. Always account for injury reports — a player listed as questionable is a 45% chance to play
3. Weather above 20 mph winds significantly suppresses passing game (reduce passing props 8-12%)
4. When a star player is out, identify who absorbs their usage (target share redistribution)
5. Primetime games (SNF/MNF) trend UNDER on totals historically
6. Always provide risk factors even for your highest-confidence picks`;

// ── Stat type normalization ───────────────────────────────────

const STAT_TYPE_ALIASES: Record<string, string> = {
  "pass yds": "passing_yards",
  "pass yards": "passing_yards",
  "passing yds": "passing_yards",
  "rush yds": "rushing_yards",
  "rush yards": "rushing_yards",
  "rushing yds": "rushing_yards",
  "rec yds": "receiving_yards",
  "rec yards": "receiving_yards",
  "receiving yds": "receiving_yards",
  "receptions": "receptions",
  "catches": "receptions",
  "rec": "receptions",
  "tds": "tds",
  "touchdowns": "tds",
  "pass tds": "passing_tds",
  "passing tds": "passing_tds",
  "rush tds": "rushing_tds",
  "rec tds": "receiving_tds",
};

export function normalizeStatType(statType: string): string {
  const lower = statType.toLowerCase().trim();
  return STAT_TYPE_ALIASES[lower] ?? lower.replace(/\s+/g, "_");
}

// ── Player lookup ─────────────────────────────────────────────

export function findPlayerName(query: string): string | null {
  const lower = query.toLowerCase();
  const match = NFL_2025_PLAYERS.find(p =>
    p.name.toLowerCase().includes(lower) ||
    lower.includes(p.name.toLowerCase().split(" ").pop()!.toLowerCase())
  );
  return match?.name ?? null;
}

// ── Context builders ──────────────────────────────────────────

export function buildPrizePicksContext(playerName: string, statType: string): string {
  const normalizedStat = normalizeStatType(statType);
  const player = NFL_2025_PLAYERS.find(p =>
    p.name.toLowerCase() === playerName.toLowerCase()
  );

  if (!player) {
    return `No 2025 stats found for player: "${playerName}". Use general NFL knowledge.`;
  }

  const defense = NFL_2025_DEFENSES.find(d => d.team === player.team);
  const lines: string[] = [
    `## ${player.name} (${player.team}, ${player.position}) — 2025 Season Stats`,
    `Games Played: ${player.games_played}`,
  ];

  if (player.position === "QB") {
    if (player.passing_yards) lines.push(`Passing Yards/Game: ${(player.passing_yards / player.games_played).toFixed(1)}`);
    if (player.passing_tds) lines.push(`Passing TDs/Game: ${(player.passing_tds / player.games_played).toFixed(2)}`);
    if (player.rushing_yards) lines.push(`Rushing Yards/Game: ${(player.rushing_yards / player.games_played).toFixed(1)}`);
  } else if (player.position === "RB") {
    if (player.rushing_yards) lines.push(`Rushing Yards/Game: ${(player.rushing_yards / player.games_played).toFixed(1)}`);
    if (player.rushing_tds) lines.push(`Rushing TDs/Game: ${(player.rushing_tds / player.games_played).toFixed(2)}`);
    if (player.receiving_yards) lines.push(`Receiving Yards/Game: ${(player.receiving_yards / player.games_played).toFixed(1)}`);
    if (player.receptions) lines.push(`Receptions/Game: ${(player.receptions / player.games_played).toFixed(1)}`);
  } else {
    if (player.receiving_yards) lines.push(`Receiving Yards/Game: ${(player.receiving_yards / player.games_played).toFixed(1)}`);
    if (player.receptions) lines.push(`Receptions/Game: ${(player.receptions / player.games_played).toFixed(1)}`);
    if (player.receiving_tds) lines.push(`Receiving TDs/Game: ${(player.receiving_tds / player.games_played).toFixed(2)}`);
    if (player.targets) lines.push(`Targets/Game: ${(player.targets / player.games_played).toFixed(1)}`);
  }

  if (player.snap_pct) lines.push(`Snap %: ${player.snap_pct}%`);

  if (defense) {
    lines.push(`\n## ${player.team} Defense Context`);
    lines.push(`Defensive Rank: #${defense.rank}`);
    lines.push(`Points Allowed/Game: ${defense.points_allowed_per_game}`);
    if (normalizedStat.includes("pass")) {
      lines.push(`Pass Yards Allowed/Game: ${defense.pass_yards_allowed_per_game}`);
    } else if (normalizedStat.includes("rush")) {
      lines.push(`Rush Yards Allowed/Game: ${defense.rush_yards_allowed_per_game}`);
    }
  }

  const relevantTrends = NFL_2025_TRENDS
    .filter(t => normalizedStat.includes(t.category) || t.category === "target_share")
    .slice(0, 2);

  if (relevantTrends.length > 0) {
    lines.push("\n## Relevant League Trends");
    relevantTrends.forEach(t => lines.push(`- ${t.trend} → ${t.impact}`));
  }

  return lines.join("\n");
}

export function buildFullDatabaseContext(): string {
  const lines: string[] = [
    `## NFL 2025 Full Database Context`,
    `Season: ${NFL_2025_LEAGUE_CONTEXT.season} | Current Week: ${NFL_2025_LEAGUE_CONTEXT.week_current}`,
    "",
    "### Season Notes",
    ...NFL_2025_LEAGUE_CONTEXT.notes.map(n => `- ${n}`),
    "",
    "### Top Players by Position",
  ];

  const positions = ["QB", "RB", "WR", "TE"];
  for (const pos of positions) {
    const players = NFL_2025_PLAYERS.filter(p => p.position === pos);
    lines.push(`\n**${pos}s** (${players.length} tracked)`);
    players.slice(0, 5).forEach(p => {
      const stat = pos === "QB" ? `${p.passing_yards ?? 0} pass yds` :
                   pos === "RB" ? `${p.rushing_yards ?? 0} rush yds` :
                   `${p.receiving_yards ?? 0} rec yds`;
      lines.push(`  - ${p.name} (${p.team}): ${stat} in ${p.games_played} games`);
    });
  }

  lines.push("\n### League Trends");
  NFL_2025_TRENDS.forEach(t => {
    lines.push(`- **${t.category}**: ${t.trend}`);
    lines.push(`  → ${t.impact}`);
  });

  return lines.join("\n");
}

export function generateWeeklyPicks(count: number = 5): string {
  // Identify top value props for the current week based on the 2025 data.
  // In the recovered version, this returns a structured prompt that the LLM
  // should fill in with actual predictions.
  const ctx = buildFullDatabaseContext();

  return `${PRIZEPICKS_SYSTEM_PROMPT}

---

## Weekly Pick Generation Request

Generate the top ${count} PrizePicks props for this week based on the data below.
Focus on props with the clearest edge (8+ confidence) and diversify across positions.

${ctx}

Respond with the JSON picks format specified in the system prompt.`;
}
