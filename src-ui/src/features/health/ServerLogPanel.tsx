import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertLine, Badge, Button, Disclosure, Panel, StatusLine } from '../../design';
import { LOG_RAW_CONTENT_NOTICE, logLevelTone, logTailBound, parseDiagnosticsLogTail, type DiagnosticsLogTail } from '../../domain/diagnostics-log-state';
/** Read only the bounded server-owned log; never manufacture empty success. */
export default function ServerLogPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DiagnosticsLogTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; const id = ++request.current;
    setLoading(true); setFailed(false);
    try {
      const response = await fetch('http://127.0.0.1:19877/diagnostics/log');
      if (!response.ok) throw new Error('Unavailable log');
      const tail = parseDiagnosticsLogTail(await response.json());
      if (!tail) throw new Error('Unreadable log');
      if (id === request.current) setSnapshot(tail);
    } catch { if (id === request.current) setFailed(true); }
    finally { if (id === request.current) { pending.current = false; setLoading(false); } }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => () => { request.current += 1; }, []);
  return <Panel className="p-4"><Disclosure summary="Server log" open={open} onOpenChange={setOpen}>{open && <div className="space-y-3">
    <p className="text-xs text-ink-3">{LOG_RAW_CONTENT_NOTICE}</p>
    <Button disabled={loading} onClick={() => void load()}>Refresh log</Button>
    {loading && <StatusLine label="Server log">{snapshot ? 'Refreshing server log…' : 'Loading server log…'}</StatusLine>}
    {failed && <AlertLine label="Server log" onRetry={() => void load()}>{snapshot ? 'Could not refresh server log. Showing the previous observation; it may be stale.' : 'Could not load server log.'}</AlertLine>}
    {snapshot && <><p className="font-mono text-xs text-ink-3">{snapshot.source} · {snapshot.lines.length} confirmed lines</p><p className="text-xs text-ink-3">{logTailBound(snapshot)}</p>{snapshot.lines.length === 0 ? <p>No lines in this confirmed log read.</p> : <ol className="max-h-96 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs">{snapshot.lines.map((line,index) => { const tone = logLevelTone(line.level); return <li key={index} className="whitespace-pre-wrap break-words py-1">{tone && <Badge tone={tone === 'default' ? 'muted' : tone}>{line.level}</Badge>} {line.text}</li>; })}</ol>}</>}
  </div>}</Disclosure></Panel>;
}
