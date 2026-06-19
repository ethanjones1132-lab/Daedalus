import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, StatusDot, Pill, SectionHeader, AnimatedGrid, LoadingState, ErrorState, ProgressBar, useToast } from '../ui';
import type { JarvisStatus } from './types';
import { RECOMMENDED_OLLAMA_MODELS } from './types';

// ─── DB-backed Profile Types ─────────────────────────────────────────────

interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  system_prompt: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  size_bytes: number;
  context_length: number;
  max_completion_tokens: number;
  already_installed: boolean;
  pricing_prompt?: string;
  pricing_completion?: string;
  latency_ms: number;
  models: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatContext(n: number): string {
  if (n >= 1_000_0