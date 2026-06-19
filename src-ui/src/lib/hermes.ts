import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

export type HermesState = 'cold' | 'starting' | 'ready' | 'draining' | 'crashed';
export interface HermesStatus { state: HermesState; reason?: string | null }

// Manifest of which methods are long-running. Kept in sync with src-tauri/hermes_protocol.yaml.
// Frontend hard-codes the list rather than fetching the YAML at runtime — the CI invariant
// (src-tauri/tests/hermes_protocol_manifest.rs) ensures both stay in sync with Hermes.
const LONG_METHODS = new Set([
  'session.resume', 'session.compress', 'session.steer',
  'prompt.submit', 'prompt.background',
  'reload.mcp', 'cli.exec', 'command.dispatch', 'slash.exec',
  'voice.record', 'voice.tts', 'browser.manage',
  'skills.reload', 'shell.exec',
]);

export interface HermesEvent {
  type: string;
  session_id: string | null;
  params: Record<string, unknown>;
}

// ── Low-level command surface ────────────────────────────────────────

export async function hermesStatus(): Promise<HermesStatus> {
  return invoke('hermes_status');
}
export async function hermesSpawn(): Promise<void> {
  await invoke('hermes_spawn');
}
export async function hermesShutdown(): Promise<void> {
  await invoke('herme