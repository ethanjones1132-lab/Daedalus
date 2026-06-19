import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, StatusDot, Pill, SectionHeader, AnimatedGrid, LoadingState, ErrorState, ProgressBar, useToast } from '../ui';
import type { DiscoveredModel, JarvisBackend, JarvisConfig, JarvisStatus } from './types';
import { OPENROUTER_MODELS, RECOMMENDED_OLLAMA_MODELS } from './types';

type ControlTab = 'overview' | 'settings' | 'profiles' | 'diagnostics';

interface ModelProfile {
  id: string;
  name: string;
  provider: JarvisBackend;
  model: string;
  api_base: string;
  api_key: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  system_prompt: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface TestResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

interface SystemHealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
}

interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
}

interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warn: number; error: number; overall: string };
  timestamp: string;
}

interface ControlCenterViewProps {
  config: JarvisConfig | null;
  status: JarvisStatus | null;
  setConfig: (config: JarvisConfig) => void;
  onRefresh: () => void;
}

const CONTROL_TABS: Array<{ id: ControlTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Config' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'diagnostics', label: 'Status' },
];

function activeModel(config: JarvisConfig): string {
  if (config.active_backend === 'ollama') return config.ollama.model;
  if (config.active_backend === 'openrouter') return config.openrouter.model;
  return 'claude-local';
}

type CatalogFilter = 'free' | 'routers' | 'paid' | 'all';
type CatalogBucket = 'free' | 'router' | 'paid';

function parseCatalogPrice(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreeCatalogModel(model: DiscoveredModel): boolean {
  if (model.is_free || model.id === 'openrouter/free' || model.id.endsWith(':free')) return true;
  const prompt = parseCatalogPrice(model.pricing_prompt);
  const completion = parseCatalogPrice(model.pricing_completion);
  return prompt === 0 && completion === 0;
}

function isRouterCatalogModel(model: DiscoveredModel): boolean {
  return Boolean(model.is_router) || model.id === 'openrouter/free' || model.id === 'openrouter/fusion';
}

function catalogBucket(model: DiscoveredModel): CatalogBucket {
  if (isFreeCatalogModel(model)) return 'free';
  if (isRouterCatalogModel(model)) return 'router';
  return 'paid';
}

function displayPrice(model: DiscoveredModel): string {
  if (isFreeCatalogModel(model)) return 'free';
  const prompt = parseCatalogPrice(model.pricing_prompt);
  const completion = parseCatalogPrice(model.pricing_completion);
  if (prompt === null && completion === null) return 'pricing unknown';
  const input = prompt === null ? '?' : `$${prompt.toExponential(2)}`;
  const output = completion === null ? '?' : `$${completion.toExponential(2)}`;
  return `${input} in / ${output} out`;
}

function normalizeDiscoveredModel(model: DiscoveredModel): DiscoveredModel {
  return {
    ...model,
    is_free: isFreeCatalogModel(model),
    is_router: isRouterCatalogModel(model),
    name: model.name || model.id,
    provider: model.provider || 'openrouter',
    size_bytes: model.size_bytes ?? 0,
    context_length: model.context_length ?? 0,
    max_completion_tokens: model.max_completion_tokens ?? 0,
    already_installed: Boolean(model.already_installed),
  };
}

function compareDiscoveredModels(a: DiscoveredModel, b: DiscoveredModel): number {
  const bucketRank: Record<CatalogBucket, number> = { free: 0, router: 1, paid: 2 };
  const bucketDiff = bucketRank[catalogBucket(a)] - bucketRank[catalogBucket(b)];
  if (bucketDiff !== 0) return bucketDiff;
  const contextDiff = (b.context_length || 0) - (a.context_length || 0);
  if (contextDiff !== 0) return contextDiff;
  return a.id.localeCompare(b.id);
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function discoveredMaxTokens(model: DiscoveredModel, backend: JarvisBackend): number {
  if (backend === 'openrouter' && (model.max_completion_tokens ?? 0) > 0) {
    return model.max_completion_tokens!;
  }
  return model.context_length || 4096;
}

function applyProfile(config: JarvisConfig, profile: ModelProfile): JarvisConfig {
  const next: JarvisConfig = {
    ...config,
    active_backend: profile.provider,
    temperature: profile.temperature,
    max_tokens: profile.max_tokens,
    top_p: profile.top_p,
    active_profile: profile.name,
    system_prompt: profile.system_prompt || config.system_prompt,
  };

  if (profile.provider === 'ollama') {
    next.ollama = {
      ...next.ollama,
      model: profile.model,
      base_url: profile.api_base || next.ollama.base_url,
    };
  }

  if (profile.provider === 'openrouter') {
    next.openrouter = {
      ...next.openrouter,
      model: profile.model,
      base_url: profile.api_base || next.openrouter.base_url,
      api_key: profile.api_key || next.openrouter.api_key,
    };
  }

  return next;
}

function backendLabel(backend: JarvisBackend): string {
  if (backend === 'claude_cli') return 'Claude CLI';
  if (backend === 'openrouter') return 'OpenRouter';
  return 'Ollama';
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${bytes} B`;
}

export default function ControlCenterView({ config, status, setConfig, onRefresh }: ControlCenterViewProps) {
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<ControlTab>('overview');
  const [localConfig, setLocalConfig] = useState<JarvisConfig | null>(config);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);