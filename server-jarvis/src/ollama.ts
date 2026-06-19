// ═══════════════════════════════════════════════════════════════
// ── Ollama Integration ──
// ═══════════════════════════════════════════════════════════════
// Manages connection to Ollama running on the Windows host from WSL2.
// Handles model discovery, health checks, auto-pull, and URL resolution.

import { spawn, execSync } from "child_process";
import { readFileSync } from "fs";
import type { JarvisConfig, OllamaConfig } from "./config";

// ── WSL2 → Windows Host IP Resolution ──

let cachedHostIP: string | null = null;
let cachedHostIPTimestamp = 0;
const HOST_IP_CACHE_TTL = 30_000;

export function resolveWindowsHostIP(): string {
  const now = Date.now();
  if (cachedHostIP && (now - cachedHostIPTimestamp) < HOST_IP_CACHE_TTL) {
    return cachedHostIP;
  }

  // Method 1: /proc/net/route default gateway. On this WSL setup, resolv.conf
  // points at a DNS proxy that does not expose Ollama, while the gateway does.
  try {
    const route = readFileSync("/proc/net/route", "utf-8");
    for (const line of route.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === "00000000" && parts[7] === "00000000") {
       
        if (hex && hex.length === 8) {
          const ip = [
            parseInt(hex.substring(6, 8), 16),
            parseInt(hex.substring(4, 6), 16),
            parseInt(hex.substring(2, 4), 16),
            parseInt(hex.substring(0, 2), 16),
          ].join(".");
          cachedHostIP = ip;
          cachedHostIPTimestamp = now;
          console.log(`[Ollama] Resolved Windows host IP via route: ${cachedHostIP}`);
          return cachedHostIP;
        }
      }
    }
  } catch { /* ignore */ }

  // Method 2: /etc/resolv.conf nameserver
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf-8");
    const match = resolv.match(/nameserver\s+(\S+)/);
    if (match && match[1]) {
      cachedHostIP = match[1];
      cachedHostIPTimestamp = now;
      console.log(`[Ollama] Resolved Windows host IP via resolv.conf: ${cachedHostIP}`);
      return cachedHostIP;
    }
  } catch { /* ignore */ }

  // Method 4: ip route command
  try {
    const result = require("child_process").execSync("ip route show default", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const match = result.match(/default via (\S+)/);
    if (match && match[1]) {
      cachedHostIP = match[1];
      cachedHostIPTimestamp = now;
      console.log(`[Ollama] Resolved Windows host IP via ip route: ${cachedHostIP}`);
      return cachedHostIP;
    }
  } catch { /* ignore */ }

  // Fallback
  cachedHostIP = "172.17.0.1";
  cachedHostIPTimestamp = now;
  console.warn("[Ollama] Could not resolve Windows host IP, using fallback 172.17.0.1");
  return cachedHostIP;
}

// ── Effective Base URL ──

export function effectiveOllamaUrl(cfg: OllamaConfig): string {
  const hostIP = resolveWindowsHostIP();
  return cfg.base_url.replace(/localhost|127\.0\.0\.1/g, hostIP);
}

function cleanOllamaBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function ollamaBaseUrlCandidates(cfg: OllamaConfig): string[] {
  return uniqueStrings([
    cleanOllamaBaseUrl(cfg.base_url),
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    cleanOllamaBaseUrl(effectiveOllamaUrl(cfg)),
  ]);
}

function modelAvailable(models: string[], requested: string): boolean {
  const modelBase = requested.split(":")[0];
  return models.some((name: string) => name === requested || name.startsWith(modelBase));
}

// ── Health Check ──

export interface OllamaHealth {
  running: boolean;
  modelAvailable: boolean;
  latencyMs: number;
  error?: string;
  lastChecked: number;
  models: string[];
}

let cachedHealth: OllamaHealth | null = null;
let cachedHealthKey: string | null = null;
const HEALTH_CACHE_TTL = 10_000;

export function __resetOllamaHealthCacheForTests(): void {
  cachedHealth = null;
  cachedHealthKey = null;
}

function healthCacheKey(cfg: OllamaConfig): string {
  return `${cfg.base_url}|${cfg.model}`;
}

export async function checkOllamaHealth(cfg: OllamaConfig): Promise<OllamaHealth> {
  const now = Date.now();
  const cacheKey = healthCacheKey(cfg);
  if (cachedHealth && cachedHealthKey === cacheKey && (now - cachedHealth.lastChecked) < HEALTH_CACHE_TTL) {
    return cachedHealth;
  }

  const urlsToTry = ollamaBaseUrlCandidates(cfg);
  let bestReachable: OllamaHealth | null = null;

  for (const cleanUrl of urlsToTry) {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);

      const tagsResp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timeout);

      if (!tagsResp.ok) continue;

      const tagsJson = await tagsResp.json();
      const models: string[] = (tagsJson.models || []).map((m: any) => m.name || "");
      const hasRequestedModel = modelAvailable(models, cfg.model);

      const health: OllamaHealth = {
        running: true,
        modelAvailable: hasRequestedModel,
        latencyMs: Date.now() - start,
        lastChecked: now,
        models,
      };

      if (hasRequestedModel) {
        cachedHealth = health;
        cachedHealthKey = cacheKey;
        return cachedHealth;
      }

      if (!bestReachable || (bestReachable.models.length === 0 && models.length > 0)) {
        bestReachable = health;
      }
    } catch { /* try next URL */ }
  }

  if (bestReachable) {
    cachedHealth = bestReachable;
    cachedHealthKey = cacheKey;
    return cachedHealth;
  }

  const start = Date.now();
  cachedHealth = {
    running: false,
    modelAvailable: false,
    latencyMs: Date.now() - start,
    error: `Unreachable. Tried: ${urlsToTry.join(", ")}`,
    lastChecked: now,
    models: [],
  };
  cachedHealthKey = cacheKey;
  return cachedHealth;
}

// ── Model Pull ──

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

export async function pullModel(
  cfg: OllamaConfig,
  onProgress?: (progress: PullProgress) => void,
): Promise<boolean> {
  console.log(`[Ollama] Pulling model: ${cfg.model}`);

  for (const cleanUrl of ollamaBaseUrlCandidates(cfg)) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 600_000); // 10 min timeout

      const res = await fetch(`${cleanUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cfg.model, stream: true }),
        signal: ctrl.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        console.error(`[Ollama] Pull failed at ${cleanUrl}: HTTP ${res.status}`);
        continue;
      }

      const reader = res.body?.getReader();
      if (!reader) continue;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const json = JSON.parse(trimmed);
            const progress: PullProgress = {
              status: json.status || "unknown",
              digest: json.digest,
              total: json.total,
              completed: json.completed,
              percent: json.total && json.completed ? Math.round((json.completed / json.total) * 100) : undefined,
            };
            onProgress?.(progress);
          } catch { /* skip bad JSON */ }
        }
      }

      console.log(`[Ollama] Model ${cfg.model} pulled successfully`);
      return true;
    } catch (e: any) {
      console.error(`[Ollama] Pull error at ${cleanUrl}: ${e.message}`);
    }
  }

  return false;
}

// ── Model Discovery ──

export interface OllamaModel {
  id: string;
  name: string;
  size: number;
  context_length: number;
  digest: string;
  modified_at: string;
  source: "ollama";
  description: string;
  parameter_size: string;
  quantization_level: string;
}

export async function listOllamaModels(cfg: OllamaConfig): Promise<OllamaModel[]> {
  const urlsToTry = ollamaBaseUrlCandidates(cfg);
  let emptyReachable = false;

  for (const cleanUrl of urlsToTry) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);

   
      clearTimeout(timeout);
      if (!res.ok) continue;

      const json = await res.json();
      const models = json.models || [];
      if (models.length === 0) {
        emptyReachable = true;
        continue;
      }

      return models.map((m: any) => ({
        id: m.name,
        name: m.name,
        size: m.size || 0,
        context_length: m.details?.context_length || m.context_length || 32768,
        digest: m.digest || "",
        modified_at: m.modified_at || "",
        source: "ollama" as const,
        description: `${((m.size || 0) / 1e9).toFixed(1)}B params · ${m.details?.quantization_level || "unknown"}`,
        parameter_size: m.details?.parameter_size || "",
        quantization_level: m.details?.quantization_level || "",
      }));
    } catch { /* try next URL */ }
  }

  if (emptyReachable) {
    console.warn("[Ollama] Model listing found only empty model stores");
    return [];
  }

  console.error("[Ollama] Model listing failed: all URLs unreachable");
  return [];
}

// ── Model Capability Check ──
//
// /api/tags does not include a capabilities field on its model entries —
// that field is only returned by /api/show for a specific model. Callers
// that need to know whether a model supports native tool calling must
// query /api/show.

export async function checkOllamaModelSupportsTools(baseUrl: string, modelName: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;

    const json = await res.json();
    return Array.isArray(json.capabilities) && json.capabilities.includes("tools");
  } catch {
    return false;
  }
}

// ── Ensure Model ──

export interface ModelStatus {
  ok: boolean;
  model: string;
  pulled?: boolean;
  error?: string;
}

export async function ensureModel(
  cfg: JarvisConfig,
  onProgress?: (p: PullProgress) => void,
): Promise<ModelStatus> {
  const health = await checkOllamaHealth(cfg.ollama);

  if (!health.running) {
    return {
      ok: false,
      model: cfg.ollama.model,
      error: `Ollama is not running. Start it on Windows with: ollama serve\nResolved host IP: ${resolveWindowsHostIP()}`,
    };
  }

  if (health.modelAvailable) {
    return { ok: true, model: cfg.ollama.model };
  }

  if (cfg.ollama.auto_pull) {
    console.log(`[Ollama] Model ${cfg.ollama.model} not found, auto-pulling...`);
    const pulled = await pullModel(cfg.ollama, onProgress);
    if (pulled) {
      return { ok: true, model: cfg.ollama.model, pulled: true };
    }
    return {
      ok: false,
      model: cfg.ollama.model,
      error: `Failed to pull model ${cfg.ollama.model}. Run manually: ollama pull ${cfg.ollama.model}`,
    };
  }

  return {
    ok: false,
    model: cfg.ollama.model,
    error: `Model ${cfg.ollama.model} not available. Run: ollama pull ${cfg.ollama.model}`,
  };
}

export interface VramInfo {
  totalMiB: number;
  isRtx4060: boolean;
}

export function detectVramInfo(): VramInfo {
  try {
    const output = execSync("/usr/lib/wsl/lib/nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const totalMiB = parseInt(output.trim(), 10);
    if (!isNaN(totalMiB)) {
      const isRtx4060 = totalMiB > 7000 && totalMiB < 9000;
      return { totalMiB, isRtx4060 };
    }
  } catch {
    // Fail silently
  }

  // Fallback to env variable
  const envVram = process.env.GPU_VRAM_MB;
  if (envVram) {
    const totalMiB = parseInt(envVram, 10);
    return { totalMiB, isRtx4060: totalMiB > 7000 && totalMiB < 9000 };
  }

  return { totalMiB: 8188, isRtx4060: true };
}
