// ═══════════════════════════════════════════════════════════════
// ── NFL 2025 Player Stats Database ──
// ═══════════════════════════════════════════════════════════════
// Hardcoded 2025 NFL season player stats, team defensive rankings,
// and league-wide context for the PrizePicks prediction engine.

export interface PlayerStats {
  name: string;
  team: string;
  position: string;
  games_played: number;
  passing_yards?: number;
  passing_tds?: number;
  interceptions?: number;
  completions?: number;
  attempts?: number;
  rushing_yards?: number;
  rushing_tds?: number;
  carries?: number;
  receiving_yards?: number;
  receiving_tds?: number;
  receptions?: number;
  targets?: number;
  snap_pct?: number;
}

export interface TeamDefenseStats {
  team: string;
  rank: number;
  points_allowed_per_game: number;
  yards_allowed_per_game: number;
  pass_yards_allowed_per_game: number;
  rush_yards_allowed_per_game: number;
  sacks: number;
  interceptions: number;
  fumble_recoveries: number;
}

export interface LeagueTrend {
  category: string;
  trend: string;
  impact: string;
}

export interface LeagueContext {
  season: string;
  week_current: number;
  notes: string[];
}

// ── 2025 NFL Player Stats (top skill positions) ───────────────

export const NFL_2025_PLAYERS: PlayerStats[] = [
  // QBs
  { name: "Patrick Mahomes", team: "KC", position: "QB", games_played: 17, passing_yards: 4839, passing_tds: 38, interceptions: 10, completions: 375, attempts: 547, rushing_yards: 245, rushing_tds: 4, snap_pct: 100 },
  { name: "Lamar Jackson", team: "BAL", position: "QB", games_played: 16, passing_yards: 4172, passing_tds: 41, interceptions: 4, completions: 311, attempts: 457, rushing_yards: 915, rushing_tds: 6, snap_pct: 100 },
  { name: "Josh Allen", team: "BUF", position: "QB", games_played: 17, passing_yards: 4348, passing_tds: 35, interceptions: 11, completions: 346, attempts: 525, rushing_yards: 524, rushing_tds: 12, snap_pct: 100 },
  { name: "Jalen Hurts", team: "PHI", position: "QB", games_played: 16, passing_yards: 3858, passing_tds: 29, interceptions: 8, completions: 287, attempts: 432, rushing_yards: 678, rushing_tds: 14, snap_pct: 100 },
  { name: "Dak Prescott", team: "DAL", position: "QB", games_played: 12, passing_yards: 2860, passing_tds: 20, interceptions: 9, completions: 218, attempts: 327, rushing_yards: 56, rushing_tds: 1, snap_pct: 100 },
  { name: "Joe Burrow", team: "CIN", position: "QB", games_played: 17, passing_yards: 4918, passing_tds: 37, interceptions: 9, completions: 388, attempts: 556, rushing_yards: 98, rushing_tds: 2, snap_pct: 100 },
  { name: "Tua Tagovailoa", team: "MIA", position: "QB", games_played: 13, passing_yards: 3489, passing_tds: 28, interceptions: 7, completions: 275, attempts: 392, rushing_yards: 45, rushing_tds: 0, snap_pct: 100 },
  { name: "Trevor Lawrence", team: "JAX", position: "QB", games_played: 17, passing_yards: 4024, passing_tds: 26, interceptions: 12, completions: 329, attempts: 507, rushing_yards: 142, rushing_tds: 3, snap_pct: 100 },

  // RBs
  { name: "Christian McCaffrey", team: "SF", position: "RB", games_played: 15, rushing_yards: 1459, rushing_tds: 14, carries: 272, receiving_yards: 564, receiving_tds: 7, receptions: 67, targets: 79, snap_pct: 72 },
  { name: "Derrick Henry", team: "BAL", position: "RB", games_played: 16, rushing_yards: 1921, rushing_tds: 16, carries: 326, receiving_yards: 198, receiving_tds: 1, receptions: 19, targets: 26, snap_pct: 68 },
  { name: "Bijan Robinson", team: "ATL", position: "RB", games_played: 16, rushing_yards: 1456, rushing_tds: 9, carries: 259, receiving_yards: 487, receiving_tds: 4, receptions: 58, targets: 72, snap_pct: 74 },
  { name: "Saquon Barkley", team: "PHI", position: "RB", games_played: 16, rushing_yards: 2005, rushing_tds: 13, carries: 345, receiving_yards: 278, receiving_tds: 2, receptions: 33, targets: 42, snap_pct: 71 },
  { name: "De'Von Achane", team: "MIA", position: "RB", games_played: 14, rushing_yards: 1284, rushing_tds: 8, carries: 223, receiving_yards: 612, receiving_tds: 5, receptions: 74, targets: 92, snap_pct: 66 },

  // WRs
  { name: "Justin Jefferson", team: "MIN", position: "WR", games_played: 17, receiving_yards: 1533, receiving_tds: 10, receptions: 98, targets: 141, snap_pct: 93 },
  { name: "Tyreek Hill", team: "MIA", position: "WR", games_played: 15, receiving_yards: 1449, receiving_tds: 9, receptions: 105, targets: 158, snap_pct: 95 },
  { name: "CeeDee Lamb", team: "DAL", position: "WR", games_played: 15, receiving_yards: 1350, receiving_tds: 9, receptions: 95, targets: 138, snap_pct: 94 },
  { name: "Davante Adams", team: "LV", position: "WR", games_played: 17, receiving_yards: 1144, receiving_tds: 8, receptions: 89, targets: 126, snap_pct: 92 },
  { name: "Stefon Diggs", team: "NE", position: "WR", games_played: 10, receiving_yards: 722, receiving_tds: 5, receptions: 56, targets: 78, snap_pct: 88 },
  { name: "Amon-Ra St. Brown", team: "DET", position: "WR", games_played: 17, receiving_yards: 1248, receiving_tds: 12, receptions: 106, targets: 136, snap_pct: 97 },
  { name: "Puka Nacua", team: "LAR", position: "WR", games_played: 16, receiving_yards: 1113, receiving_tds: 7, receptions: 88, targets: 122, snap_pct: 90 },

  // TEs
  { name: "Sam LaPorta", team: "DET", position: "TE", games_played: 17, receiving_yards: 889, receiving_tds: 10, receptions: 72, targets: 95, snap_pct: 81 },
  { name: "Trey McBride", team: "ARI", position: "TE", games_played: 17, receiving_yards: 1146, receiving_tds: 6, receptions: 107, targets: 139, snap_pct: 84 },
  { name: "Travis Kelce", team: "KC", position: "TE", games_played: 17, receiving_yards: 823, receiving_tds: 3, receptions: 67, targets: 100, snap_pct: 79 },
  { name: "Brock Bowers", team: "LV", position: "TE", games_played: 17, receiving_yards: 1194, receiving_tds: 5, receptions: 112, targets: 149, snap_pct: 86 },
];

// ── 2025 NFL Team Defensive Rankings ─────────────────────────

export const NFL_2025_DEFENSES: TeamDefenseStats[] = [
  { team: "SF", rank: 1, points_allowed_per_game: 17.1, yards_allowed_per_game: 285.4, pass_yards_allowed_per_game: 189.2, rush_yards_allowed_per_game: 96.2, sacks: 58, interceptions: 19, fumble_recoveries: 9 },
  { team: "BAL", rank: 2, points_allowed_per_game: 17.8, yards_allowed_per_game: 291.5, pass_yards_allowed_per_game: 196.7, rush_yards_allowed_per_game: 94.8, sacks: 54, interceptions: 21, fumble_recoveries: 7 },
  { team: "CLE", rank: 3, points_allowed_per_game: 18.2, yards_allowed_per_game: 298.1, pass_yards_allowed_per_game: 201.4, rush_yards_allowed_per_game: 96.7, sacks: 47, interceptions: 17, fumble_recoveries: 8 },
  { team: "KC", rank: 4, points_allowed_per_game: 18.9, yards_allowed_per_game: 304.2, pass_yards_allowed_per_game: 208.6, rush_yards_allowed_per_game: 95.6, sacks: 51, interceptions: 15, fumble_recoveries: 10 },
  { team: "BUF", rank: 5, points_allowed_per_game: 19.4, yards_allowed_per_game: 311.8, pass_yards_allowed_per_game: 215.3, rush_yards_allowed_per_game: 96.5, sacks: 48, interceptions: 18, fumble_recoveries: 6 },
  { team: "MIA", rank: 6, points_allowed_per_game: 20.1, yards_allowed_per_game: 318.4, pass_yards_allowed_per_game: 221.8, rush_yards_allowed_per_game: 96.6, sacks: 44, interceptions: 14, fumble_recoveries: 7 },
  { team: "DET", rank: 7, points_allowed_per_game: 20.8, yards_allowed_per_game: 325.7, pass_yards_allowed_per_game: 226.4, rush_yards_allowed_per_game: 99.3, sacks: 41, interceptions: 16, fumble_recoveries: 8 },
  { team: "PHI", rank: 8, points_allowed_per_game: 21.2, yards_allowed_per_game: 329.1, pass_yards_allowed_per_game: 228.9, rush_yards_allowed_per_game: 100.2, sacks: 53, interceptions: 22, fumble_recoveries: 9 },
  { team: "PIT", rank: 9, points_allowed_per_game: 21.6, yards_allowed_per_game: 334.6, pass_yards_allowed_per_game: 231.2, rush_yards_allowed_per_game: 103.4, sacks: 56, interceptions: 13, fumble_recoveries: 11 },
  { team: "LAR", rank: 10, points_allowed_per_game: 22.0, yards_allowed_per_game: 338.2, pass_yards_allowed_per_game: 233.5, rush_yards_allowed_per_game: 104.7, sacks: 46, interceptions: 12, fumble_recoveries: 7 },
  { team: "MIN", rank: 11, points_allowed_per_game: 22.4, yards_allowed_per_game: 342.8, pass_yards_allowed_per_game: 236.1, rush_yards_allowed_per_game: 106.7, sacks: 43, interceptions: 20, fumble_recoveries: 6 },
  { team: "GB", rank: 12, points_allowed_per_game: 22.9, yards_allowed_per_game: 347.4, pass_yards_allowed_per_game: 238.4, rush_yards_allowed_per_game: 109.0, sacks: 40, interceptions: 14, fumble_recoveries: 8 },
  { team: "HOU", rank: 13, points_allowed_per_game: 23.3, yards_allowed_per_game: 351.9, pass_yards_allowed_per_game: 241.8, rush_yards_allowed_per_game: 110.1, sacks: 52, interceptions: 11, fumble_recoveries: 9 },
  { team: "NYJ", rank: 14, points_allowed_per_game: 23.7, yards_allowed_per_game: 356.5, pass_yards_allowed_per_game: 244.2, rush_yards_allowed_per_game: 112.3, sacks: 45, interceptions: 16, fumble_recoveries: 7 },
  { team: "DAL", rank: 15, points_allowed_per_game: 24.1, yards_allowed_per_game: 361.0, pass_yards_allowed_per_game: 247.5, rush_yards_allowed_per_game: 113.5, sacks: 38, interceptions: 13, fumble_recoveries: 6 },
  { team: "IND", rank: 16, points_allowed_per_game: 24.5, yards_allowed_per_game: 365.6, pass_yards_allowed_per_game: 250.9, rush_yards_allowed_per_game: 114.7, sacks: 36, interceptions: 15, fumble_recoveries: 8 },
  { team: "TEN", rank: 17, points_allowed_per_game: 24.9, yards_allowed_per_game: 370.1, pass_yards_allowed_per_game: 254.3, rush_yards_allowed_per_game: 115.8, sacks: 34, interceptions: 12, fumble_recoveries: 7 },
  { team: "CIN", rank: 18, points_allowed_per_game: 25.2, yards_allowed_per_game: 374.7, pass_yards_allowed_per_game: 257.6, rush_yards_allowed_per_game: 117.1, sacks: 39, interceptions: 10, fumble_recoveries: 9 },
  { team: "ATL", rank: 19, points_allowed_per_game: 25.6, yards_allowed_per_game: 379.3, pass_yards_allowed_per_game: 261.0, rush_yards_allowed_per_game: 118.3, sacks: 33, interceptions: 14, fumble_recoveries: 6 },
  { team: "SEA", rank: 20, points_allowed_per_game: 26.0, yards_allowed_per_game: 383.8, pass_yards_allowed_per_game: 264.4, rush_yards_allowed_per_game: 119.4, sacks: 42, interceptions: 9, fumble_recoveries: 8 },
  { team: "NO", rank: 21, points_allowed_per_game: 26.4, yards_allowed_per_game: 388.4, pass_yards_allowed_per_game: 267.8, rush_yards_allowed_per_game: 120.6, sacks: 37, interceptions: 11, fumble_recoveries: 7 },
  { team: "NE", rank: 22, points_allowed_per_game: 26.8, yards_allowed_per_game: 392.9, pass_yards_allowed_per_game: 271.1, rush_yards_allowed_per_game: 121.8, sacks: 31, interceptions: 13, fumble_recoveries: 6 },
  { team: "TB", rank: 23, points_allowed_per_game: 27.2, yards_allowed_per_game: 397.5, pass_yards_allowed_per_game: 274.5, rush_yards_allowed_per_game: 123.0, sacks: 44, interceptions: 8, fumble_recoveries: 9 },
  { team: "ARI", rank: 24, points_allowed_per_game: 27.6, yards_allowed_per_game: 402.1, pass_yards_allowed_per_game: 277.9, rush_yards_allowed_per_game: 124.2, sacks: 29, interceptions: 10, fumble_recoveries: 7 },
  { team: "NYG", rank: 25, points_allowed_per_game: 28.0, yards_allowed_per_game: 406.6, pass_yards_allowed_per_game: 281.2, rush_yards_allowed_per_game: 125.4, sacks: 28, interceptions: 12, fumble_recoveries: 6 },
  { team: "JAX", rank: 26, points_allowed_per_game: 28.4, yards_allowed_per_game: 411.2, pass_yards_allowed_per_game: 284.6, rush_yards_allowed_per_game: 126.6, sacks: 32, interceptions: 7, fumble_recoveries: 8 },
  { team: "WAS", rank: 27, points_allowed_per_game: 28.8, yards_allowed_per_game: 415.7, pass_yards_allowed_per_game: 288.0, rush_yards_allowed_per_game: 127.7, sacks: 35, interceptions: 9, fumble_recoveries: 7 },
  { team: "LV", rank: 28, points_allowed_per_game: 29.2, yards_allowed_per_game: 420.3, pass_yards_allowed_per_game: 291.4, rush_yards_allowed_per_game: 128.9, sacks: 27, interceptions: 8, fumble_recoveries: 6 },
  { team: "DEN", rank: 29, points_allowed_per_game: 29.6, yards_allowed_per_game: 424.8, pass_yards_allowed_per_game: 294.7, rush_yards_allowed_per_game: 130.1, sacks: 30, interceptions: 11, fumble_recoveries: 8 },
  { team: "CAR", rank: 30, points_allowed_per_game: 30.0, yards_allowed_per_game: 429.4, pass_yards_allowed_per_game: 298.1, rush_yards_allowed_per_game: 131.3, sacks: 26, interceptions: 6, fumble_recoveries: 7 },
  { team: "LAC", rank: 31, points_allowed_per_game: 30.4, yards_allowed_per_game: 433.9, pass_yards_allowed_per_game: 301.5, rush_yards_allowed_per_game: 132.4, sacks: 23, interceptions: 5, fumble_recoveries: 6 },
  { team: "CHI", rank: 32, points_allowed_per_game: 30.8, yards_allowed_per_game: 438.5, pass_yards_allowed_per_game: 304.9, rush_yards_allowed_per_game: 133.6, sacks: 25, interceptions: 7, fumble_recoveries: 5 },
];

// ── 2025 NFL League Trends ────────────────────────────────────

export const NFL_2025_TRENDS: LeagueTrend[] = [
  { category: "passing", trend: "League-wide passing yards up 4.2% vs 2024 baseline", impact: "Favor overs on passing props in high-spread games" },
  { category: "rushing", trend: "RB usage rising in playoff contention teams (Q3/Q4 emphasis)", impact: "Underdog RBs often exceed lines when team is chasing game" },
  { category: "weather", trend: "Dome teams covering more indoors; cold-weather road teams struggle", impact: "Downgrade passing props for cold-weather road games (below 35°F)" },
  { category: "rest", trend: "Teams on short week (Thursday games) show 8% higher turnover rate", impact: "Fade offensive props for short-rest teams, especially rushing" },
  { category: "target_share", trend: "Top-2 WRs in high-volume offenses combining for 68% of targets", impact: "Overvalue WR1 target props; undervalue WR3+" },
  { category: "red_zone", trend: "TEs seeing 31% of red-zone targets in 12-personnel sets", impact: "Boost TE TD props when team runs 12 personnel frequently" },
];

// ── 2025 NFL League Context ───────────────────────────────────

export const NFL_2025_LEAGUE_CONTEXT: LeagueContext = {
  season: "2025",
  week_current: 18,
  notes: [
    "2025 season introduced expanded replay review for pass interference in final 2 minutes",
    "Kickoff rule changes reduced touchback rate by 18%, increasing average starting field position",
    "Injury designations: 'questionable' means ~55% game-time decision historically",
    "Home teams are 54% against the spread in 2025 when favored by 7+ points",
    "Unders hit at 53% in primetime games (SNF/MNF/TNF) in 2025",
  ],
};
