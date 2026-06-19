import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
              />
  SectionHeader,
  Pill,
  cn,
  useToast,
} from '../ui';
import { RECOMMENDED_OLLAMA_MODELS } from './types';

// ── Types ──

interface OllamaConfig {
  base_url: string;
  model: string;
  auto_pull: boolean;
  health_check_interval_ms: number;
  options: {
    num_ctx: number;
    num_gpu: number;
    num_thread: number;
  };
}

interface OpenRouterConfig {
  base_url: string;
  api_key: string;
  model: string;
  site_url: string;
  site_name: string;
  fallbacks: string[];
  enable_fallbacks: boolean;
  enable_paid_fallbacks: boolean;
  max_retries: number;
  timeout_ms: number;
}

interface ClaudeCliConfig {
  enabled: boolean;
  path: string;
  args: string[];
  timeout_ms: number;
  cwd: string;
}

interface JarvisConfig {
  version: string;
  active_backend: string;
  ollama: OllamaConfig;
  openrouter: OpenRouterConfig;
  claude_cli: ClaudeCliConfig;
  system_prompt: string;
  mode: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
  bridge_port: number;
  bridge_enabled: boolean;
  jarvis_path: string;
  active_profile: string;

}

interface OpenRouterCatalogModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens: number;
  pricing_prompt?: string;
  pricing_completion?: string;
  is_free?: boolean;
  is_router?: boolean;
  modality?: string;
  supported_parameters?: string[];
}

type OpenRouterCatalogFilter = 'free' | 'routers' | 'paid' | 'all';

const DEFAULT_CONFIG: JarvisConfig = {
  version: '3.0.0',
  active_backend: 'ollama',
  ollama: {
    base_url: 'http://localhost:11434/v1',
    model: 'qwen3.5-9b:latest',
    auto_pull: true,
    health_check_interval_ms: 10000,
    options: { num_ctx: 8192, num_gpu: 99, num_thread: 8 },
  },
  openrouter: {
    base_url: 'https://openrouter.ai/api/v1',
    api_key: '',
    model: 'openrouter/free',
    site_url: 'http://localhost:19877',
    site_name: 'Jarvis Home-Base',
    fallbacks: [
      'openrouter/free',
      'openrouter/owl-alpha',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'qwen/qwen3-coder:free',
    ],
    enable_fallbacks: true,
    enable_paid_fallbacks: false,
    max_retries: 3,
    timeout_ms: 60000,
  },
  claude_cli: {
    enabled: true,
    path: 'claude',
    args: ['--bare', '--print', '--output-format', 'stream-json', '--no-telemetry'],
    timeout_ms: 120000,
    cwd: '',
  },
  system_prompt: '',
  mode: 'chat',
  temperature: 0.7,
  max_tokens: 8192,
  top_p: 0.95,
  bridge_port: 19876,
  bridge_enabled: true,
  jarvis_path: '',
  active_profile: 'quality',
  api_sports_key: '',
};

// ── Debounce helper ──
function useDebouncedCallback<T extends (...args: any[]) => void>(
  callback: T,
  delay: number,
): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef(callback);
  cb.current = callback;
  return useCallback(
    ((...args: any[]) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => cb.current(...args), delay);
    }) as T,
    [delay],
  );
}

// ── Slider component ──
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-mono text-bone-dim">{label}</label>
        <span className="text-xs font-mono text-cyan-neon">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-iron/30 rounded-full appearance-none cursor-pointer accent-cyan-neon"
      />
    </div>
  );
}

// ── Number input ──
function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <label className="text-xs font-mono text-bone-dim block mb-1">{label}</label>
      <input
        type="number"