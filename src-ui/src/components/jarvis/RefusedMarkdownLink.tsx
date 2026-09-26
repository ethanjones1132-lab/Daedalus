import type { ReactNode } from 'react';
import { REFUSED_LINK_NOTICE } from '../../lib/link-scheme';

/**
 * A link destination the app will not open, rendered as text.
 *
 * It deliberately stops looking like a link: no underline, no hover, no href, and
 * the address printed in a monospace aside beside the text the author gave it, so
 * nothing they wrote disappears and nothing is activatable.
 *
 * `role="note"` is a real choice, not decoration. The `generic` role prohibits
 * naming, so a non-interactive element that must carry an accessible name needs
 * some role, and a refused destination is exactly a parenthetical aside in the
 * flow of a message. The name is the notice, `title` gives the same sentence to a
 * pointer, and the visible text stays the author's own.
 */
export default function RefusedMarkdownLink({
  text,
  address,
}: {
  text: ReactNode;
  address: string;
}) {
  return (
    <span
      role="note"
      aria-label={REFUSED_LINK_NOTICE}
      title={REFUSED_LINK_NOTICE}
      className="text-bone/70"
    >
      {text}
      {address && <span className="font-mono text-[0.85em] text-bone-faint"> ({address})</span>}
    </span>
  );
}
