import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel } from './types';

/** Channel metadata for the binding picker. A failed refresh keeps the last list as stale. */
export function useChannelList() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      setChannels(await invoke<Channel[]>('list_channels'));
      setError(false);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { channels, loading, error, refresh };
}
