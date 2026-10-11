import { invoke } from '@tauri-apps/api/core';
import { RotateCw } from 'lucide-react';
import { useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { initialBindingState, reduceBindingState } from '../../domain/agent-binding-state';
import type { Agent } from '../../domain/agent-operation-state';
import { AlertLine, Badge, Button, cn, StatusLine } from '../../design';
import type { Channel } from './types';

/*
 * Which Channels one Agent is bound to. Only a retrieved snapshot establishes
 * whether a channel is bound: while the snapshot is loading, updating, or
 * failed, the toggles are disabled and carry no pressed state. One Agent's
 * writes and reads are serialized; other Agents are independent.
 */
export function ChannelBindings({
  agent,
  channels,
  channelsReady,
  locked = false,
}: {
  agent: Agent;
  channels: Channel[];
  channelsReady: boolean;
  locked?: boolean;
}) {
  const [state, dispatch] = useReducer(reduceBindingState, initialBindingState);
  const pending = useRef(false);

  const readBindings = useCallback(async () => {
    try {
      const ids = await invoke<string[]>('list_agent_channel_bindings', { agentId: agent.id });
      dispatch({ type: 'success', ids });
    } catch {
      dispatch({ type: 'failure', error: 'read' });
    }
  }, [agent.id]);

  const refreshBindings = useCallback(async () => {
    if (locked || pending.current) return;
    pending.current = true;
    dispatch({ type: 'pending', phase: 'loading' });
    try {
      await readBindings();
    } finally {
      pending.current = false;
    }
  }, [readBindings, locked]);

  // A layout effect, so the first read is issued in the same commit that mounts
  // the picker: the 'loading' status it shows is then never ahead of the request.
  useLayoutEffect(() => {
    void refreshBindings();
    // Only (re)read when the Agent changes; `locked` flipping must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const toggle = async (channel: Channel) => {
    if (locked || pending.current || !channelsReady || state.phase !== 'ready' || state.bound === null) return;
    pending.current = true;
    dispatch({ type: 'pending', phase: 'updating' });
    try {
      await invoke(state.bound.includes(channel.id) ? 'unbind_agent_channel' : 'bind_agent_channel', {
        agentId: agent.id,
        channelId: channel.id,
      });
      // This read catches its own error: a failed reconciliation is not a
      // failed write, and Retry must never blindly repeat a settled mutation.
      await readBindings();
    } catch {
      dispatch({ type: 'failure', error: 'write' });
    } finally {
      pending.current = false;
    }
  };

  const busy = locked || state.phase === 'loading' || state.phase === 'updating';
  return (
    <div className="space-y-3">
      {busy && (
        <StatusLine label={`Channel bindings for ${agent.name}`}>
          {state.phase === 'updating' ? 'Updating channel bindings…' : 'Loading channel bindings…'}
        </StatusLine>
      )}
      {state.error && (
        <AlertLine tone={state.bound !== null ? 'warn' : 'error'}>
          {state.error === 'write' ? 'Could not change channel binding. Reload bindings before trying again. ' : 'Channel bindings are unavailable. '}
          {state.bound !== null && 'Showing previously loaded bindings; they may be stale.'}
        </AlertLine>
      )}

      {channels.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-sunken/50">
          {channels.map((c) => {
            const isBound = state.bound?.includes(c.id);
            const disabled = locked || !channelsReady || state.phase !== 'ready';
            return (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={isBound}
                  onClick={() => void toggle(c)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                    'enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative h-[14px] w-[25px] shrink-0 rounded-full border transition-colors',
                      isBound ? 'border-accent-line bg-accent-wash' : 'border-line-strong bg-sunken',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-[2px] size-[8px] rounded-full transition-all duration-200',
                        isBound ? 'left-[13px] bg-accent' : isBound === false ? 'left-[2px] bg-ink-4' : 'left-[7px] bg-line-strong',
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{c.name}</span>
                    <span className="block font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{c.type}</span>
                  </span>
                  {!c.enabled && <Badge tone="muted" size="xs">channel off</Badge>}
                  <span aria-hidden={isBound === undefined ? undefined : true} className={cn('shrink-0 text-[11.5px]', isBound ? 'text-accent-hot' : 'text-ink-3')}>
                    {isBound === undefined ? 'unknown' : isBound ? 'bound' : 'not bound'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => void refreshBindings()}
        aria-label={`${state.error ? 'Retry' : 'Refresh'} bindings for ${agent.name}`}
        icon={<RotateCw aria-hidden="true" />}
      >
        {state.error ? 'Retry bindings' : 'Refresh bindings'}
      </Button>
    </div>
  );
}
