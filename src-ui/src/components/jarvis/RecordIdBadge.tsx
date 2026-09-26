// ── RecordIdBadge — the id Native assigned a stored record, copyable ──

import { useCallback, useState } from 'react';

export default function RecordIdBadge({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copy = useCallback(async () => {
    setCopyError(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }, [id]);

  return (
    <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono text-bone/30">
      <span data-testid="record-id" className="select-all">{id}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`${copied ? 'Copied' : 'Copy'} ${label} id`}
        className="underline underline-offset-2 hover:text-bone/60 transition-colors"
      >
        {copied ? 'Copied' : 'Copy id'}
      </button>
      {copyError && <span role="alert" className="text-red-200">Could not copy the id.</span>}
    </div>
  );
}
