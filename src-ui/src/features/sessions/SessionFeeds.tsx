import { TRANSCRIPT_WINDOW, extendWindow, transcriptWindow, windowSlice } from '../../lib/transcript-window';
import { TranscriptWindowNotice } from './TranscriptWindowNotice';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, BookOpenText, Wrench } from 'lucide-react';
import { AlertLine, Badge, Button, EmptyState, SearchInput, Skeleton, StatusDot, StatusLine, cn, formatIsoAge } from '../../design';
import { usePolling } from '../../hooks/usePolling';
import { createReadGuard, type ReadIdentity } from '../../lib/read-identity';
import type { BackendSession, SessionMessage } from '../../types';
import MarkdownView from './MarkdownView';
import { clockTime } from './outcome';

/*
 * Feeds — read-only transcript browsing of native Sessions (`list_sessions` +
 * `get_session_history`), ported from the legacy ChatFeedsView.
 *
 *  · The list is polled every 15s and every poll is its own read: a hung
 *    read never blocks a newer one, and a read that resolves after a newer
 *    one is dropped (newest confirmed list wins).
 *  · The transcript read is started by a selection and owns its own read
 *    identity, so a superseded read can neither publish one Session's
 *    transcript under another Session's header nor end the newer read's
 *    pending state.
 */

export interface FeedReader {
  selected: BackendSession | null;
  history: SessionMessage[] | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
  open: (session: BackendSession) => void;
  close: () => void;
}

export function useFeedReader(): FeedReader {
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<BackendSession | null>(null);
  const [history, setHistory] = useState<SessionMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const historyRead = useMemo(() => createReadGuard(), []);

  const open = useCallback(
    async (session: BackendSession) => {
      const request = historyRead.issue();
      setSelected(session);
      setLoading(true);
      setError(false);
      setHistory(null);
      try {
        const messages = await invoke<SessionMessage[]>('get_session_history', { sessionId: session.id });
        historyRead.publish(request.id, () => setHistory(messages));
      } catch {
        historyRead.publish(request.id, () => setError(true));
      } finally {
        historyRead.publish(request.id, () => setLoading(false));
      }
    },
    [historyRead],
  );

  const close = useCallback(() => {
    historyRead.issue();
    setSelected(null);
    setHistory(null);
    setLoading(false);
  }, [historyRead]);

  return { selected, history, loading, error, retry: () => { if (selected) void open(selected); }, open: (s) => void open(s), close };
}

/** The Feeds list (index column). */
export function FeedList({ reader }: { reader: FeedReader }) {
  const [sessions, setSessions] = useState<BackendSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [observed, setObserved] = useState(false);
  const [retry, setRetry] = useState(0);

  const fetchSessions = useCallback(async (read: ReadIdentity) => {
    setLoading(true);
    try {
      const result = await invoke<BackendSession[]>('list_sessions');
      const sorted = [...result].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      if (!read.isCurrent()) return; // a newer poll has already read this list
      setSessions(sorted);
      setObserved(true);
      setError(null);
    } catch {
      if (!read.isCurrent()) return;
      setError('Could not read Sessions. Retry the read.');
    } finally {
      if (read.isCurrent()) setLoading(false);
    }
  }, []);

  usePolling(fetchSessions, 15000, [fetchSessions, retry]);

  const filtered = sessions.filter((session) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return [session.agent_id, session.id, session.title, session.model, session.backend].some((value) =>
      (value ?? '').toLowerCase().includes(q),
    );
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter sessions..." aria-label="Filter feeds" />
      </div>
      {error && <div className="px-3"><AlertLine onRetry={() => setRetry(value => value + 1)}>{observed ? 'Could not refresh sessions. Showing previously loaded sessions; they may be stale.' : 'Could not load sessions.'}</AlertLine></div>}
      {loading && !observed ? <div className="px-3"><StatusLine label="Feeds loading">Loading native Sessions…</StatusLine></div> : (
        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-3">
          {filtered.map((session) => {
            const selected = reader.selected?.id === session.id;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => reader.open(session)}
                  aria-pressed={selected}
                  className={cn(
                    'relative flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors',
                    selected ? 'bg-raised' : 'hover:bg-hover',
                  )}
                >
                  {selected && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-accent" />}
                  <span className="flex items-center gap-2">
                    <StatusDot tone={session.archived ? 'warn' : 'ok'} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{session.title || session.agent_id}</span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-4">{formatIsoAge(session.updated_at)}</span>
                  </span>
                  <span className="truncate pl-[15px] font-mono text-[10.5px] text-ink-3">
                    {session.message_count} messages - {session.backend}
                  </span>
                  <span className="truncate pl-[15px] font-mono text-[10.5px] text-ink-4">{session.model}</span>
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && observed && <EmptyState compact title={sessions.length === 0 ? 'No sessions yet.' : `No sessions match "${query}".`} />}
        </ul>
      )}
    </div>
  );
}

/** The read-only transcript of the selected feed, laid over the center pane. */
export function FeedTranscript({ reader, onReturn, liveTurn }: { reader: FeedReader; onReturn: () => void; liveTurn: boolean }) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);

  const { selected, history, loading } = reader;
  useEffect(() => setVisible(TRANSCRIPT_WINDOW), [selected?.id]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [history]);

  return (
    <section aria-label="Read-only Session feed" className="absolute inset-0 z-20 flex flex-col bg-canvas">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-8 py-3.5">
        <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden="true" />} onClick={onReturn}>
          Back to Session
        </Button>
        {liveTurn && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent">
            <StatusDot tone="accent" live /> A Session turn is still running
          </span>
        )}
        <Badge tone="info" className="ml-auto">
          read-only
        </Badge>
      </header>
      {!selected ? (
        <EmptyState
          icon={<BookOpenText />}
          title="Select a session to view its chat feed"
          description="Feeds are native Sessions from every Agent and channel, shown read-only."
          className="flex-1"
        />
      ) : loading ? (
        <div className="mx-auto w-full max-w-[760px] space-y-4 px-8 pt-10">
          <StatusLine label="Session transcript">Loading transcript…</StatusLine>
          <Skeleton className="w-2/3" />
          <Skeleton className="w-5/6" />
          <Skeleton className="w-1/2" />
        </div>
      ) : history ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-8 pb-12 pt-8">
            <div className="mb-8 border-b border-line pb-5">
              <div className="flex items-center gap-2.5">
                <StatusDot tone={selected.archived ? 'warn' : 'ok'} />
                <h2 className="d-display text-[26px] text-ink">{selected.title || selected.agent_id || 'Session'}</h2>
                <Badge tone="info">{history.length} msgs</Badge>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-ink-3">{selected.id}</div>
            </div>
            <div className="space-y-7"><TranscriptWindowNotice window={transcriptWindow(history.length, visible)} onExtend={() => setVisible(current => extendWindow(current, history.length))} />
              {windowSlice(history, visible).map((msg, index) => {
                const isUser = msg.role === 'user';
                const isTool = msg.role === 'tool' || msg.content.startsWith('[tool:') || msg.content.startsWith('[result:');
                const content = msg.content;
                return (
                  <article key={msg.id || index}>
                    <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
                      {isTool && <Wrench aria-hidden="true" className="size-3" />}
                      <span className={isUser ? 'text-accent' : undefined}>{isUser ? 'USER' : isTool ? 'TOOL' : 'ASSISTANT'}</span>
                      {msg.created_at && <span className="tabular text-ink-4">· {clockTime(msg.created_at)}</span>}
                    </div>
                    {isUser ? (
                      <div className="whitespace-pre-wrap break-words rounded-r-lg rounded-l-[3px] border border-l-2 border-line border-l-accent bg-surface px-4 py-3 text-[14px] text-ink">
                        {content}
                      </div>
                    ) : isTool ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11.5px] text-ink-2">
                        {content}
                      </pre>
                    ) : (
                      <MarkdownView content={content} />
                    )}
                  </article>
                );
              })}
              {history.length === 0 && <EmptyState compact title="No messages in this session" />}
              <div ref={endRef} />
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8"><AlertLine onRetry={reader.retry} retryLabel="Retry transcript" retryText="Retry transcript">Could not load this session's transcript.</AlertLine></div>
      )}
    </section>
  );
}
