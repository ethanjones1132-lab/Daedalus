import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, StatusDot, Pill, SectionHeader, LoadingState } from '../ui';
import type { JarvisConfig, JarvisStatus, PrizePicksPlayer, PrizePicksDefense } from './types';

const JARVIS_API = 'http://localhost:19877';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
const STAT_TYPES = [
  { value: 'pass_yards', label: 'Pass Yards' },
  { value: 'rush_yards', label: 'Rush Yards' },
  { value: 'rec_yards', label: 'Rec Yards' },
  { value: 'receptions', label: 'Receptions' },
  { value: 'targets', label: 'Targets' },
  { value: 'pass_tds', label: 'Pass TDs' },
  { value: 'rush_tds', label: 'Rush TDs' },
  { value: 'rec_tds', label: 'Rec TDs' },
  { value: 'total_tds', label: 'Total TDs' },
  { value: 'fantasy_points', label: 'Fantasy PPR' },
];

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN',
  'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA',
  'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB',
  'TEN', 'WAS'
];

type PrizePicksTab = 'analyze' | 'compare' | 'weekly' | 'trends' | 'paste-lines';

interface ParsedLine {
  player_name: string;
  stat_type: string;
  line_value: number;
}

interface PredictionResult {
  prediction: {
    player: string;
    team: string;
    position: string;
    stat_type: string;
    line: number;
    projection: number;
    confidence_pct: number;
    recommendation: 'over' | 'under';
    ev_score: number;
    risk_level: 'low' | 'medium' | 'high';
  };
  reasoning: string[];
  key_stats: Record<string, number>;
  context_factors: string[];
}

interface WeeklyPick {
  player: string;
  team: string;
  position: string;
  stat_type: string;
  line: number;
  projection: number;
  confidence: number;
  recommendation: 'over' | 'under';
  reasoning: string;
  ev_score: number;
}

export default function PrizePicksPanel({
  config: _config,
  status,
}: {
  config?: JarvisConfig | null;
  status: JarvisStatus | null;
}) {
  void _config; // Reserved for future live data integration
  const [activeTab, setActiveTab] = useState<PrizePicksTab>('analyze');
  const [players, setPlayers] = useState<PrizePicksPlayer[]>([]);
  const [defenses, setDefenses] = useState<PrizePicksDefense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Analyze tab state
  const [searchQuery, setSearchQuery] = useState('');
  const [positionFilter, setPositionFilter] = useState<string>('ALL');
  const [selectedPlayer, setSelectedPlayer] = useState<string>('');
  const [selectedStat, setSelectedStat] = useState('pass_yards');
  const [line, setLine] = useState<string>('0');
  const [opponent, setOpponent] = useState('KC');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [quickQuestion, setQuickQuestion] = useState('');

  // Compare tab state
  const [comparePlayer1, setComparePlayer1] = useState<string>('');
  const [comparePlayer2, setComparePlayer2] = useState<string>('');
  const [compareStat, setCompareStat] = useState('pass_yards');
  const [compareResult1, setCompareResult1] = useState<PrizePicksPlayer | null>(null);
  const [compareResult2, setCompareResult2] = useState<PrizePicksPlayer | null>(null);

  // Weekly picks state
  const [weeklyPicks, setWeeklyPicks] = useState<WeeklyPick[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);

  // Paste Lines tab state
  const [pasteText, setPasteText] = useState('');
  const [parsedLines, setParsedLines] = useState<ParsedLine[]>([]);
  const [pasteStreaming, setPasteStreaming] = useState(false);
  const [pasteStreamedText, setPasteStreamedText] = useState('');
  const pasteEndRef = useRef<HTMLDivElement>(null);

  const [sessionId] = useState(() => crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load player and defense data
  useEffect(() => { loadData(); }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [playersRes, defenseRes] = await Promise.all([
        fetch(`${JARVIS_API}/football/players`).then(r => r.json()).catch(() => null),
        fetch(`${JARVIS_API}/football/defense`).then(r => r.json()).catch(() => null),
      ]);
      if (playersRes?.players) setPlayers(playersRes.players);
      if (defenseRes?.teams) setDefenses(defenseRes.teams);
    } catch (e) {
      console.error('Failed to load football data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load compare player data
  useEffect(() => {
    if (comparePlayer1) {
      const p = players.find(pl => pl.name === comparePlayer1);
      setCompareResult1(p || null);
    } else {
      setCompareResult1(null);
    }
  }, [comparePlayer1, players]);

  useEffect(() => {
    if (comparePlayer2) {
      const p = players.find(pl => pl.name === comparePlayer2);
      setCompareResult2(p || null);
    } else {
      setCompareResult2(null);
    }
  }, [comparePlayer2, players]);

  // Filter players
  const filteredPlayers = useMemo(() => {
    let result = players;
    if (positionFilter !== 'ALL') {
      result = result.filter(p => p.position === positionFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.team.toLowerCase().includes(q)
      );
    }
    return result;
  }, [players, positionFilter, searchQuery]);

  // Listen for streaming events
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen<{ text: string; session_id: string }>('jarvis://token', (e) => {
      setStreamedText(prev => prev + e.payload.text);
    }).then(f => unsubs.push(f));

    listen<{ session_id: string }>('jarvis://done', () => {
      setIsStreaming(false);
      try {
        const jsonMatch = streamedText.match(/\{[\s\S]*"prediction"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.prediction) {
            setPrediction(parsed);
          }
        }
      } catch {
        // If JSON parsing fails, that's ok — the text response is still shown
      }
    }).then(f => unsubs.push(f));

    listen<{ error: string; session_id: string }>('jarvis://error', (e) => {
      setIsStreaming(false);
      setError(e.payload.error);
    }).then(f => unsubs.push(f));

    return () => { unsubs.forEach(f => f()); };
  }, [streamedText]);