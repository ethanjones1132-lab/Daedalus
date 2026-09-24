import { isValidElement, memo, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { cn } from '../ui';

interface MarkdownViewProps {
  content: string;
  className?: string;
}

/**
 * Streaming-safe markdown view.
 *
 * Built on react-markdown + remark-gfm + rehype-highlight. Replaces the old
 * hand-rolled MarkdownRenderer which (a) couldn't finish a code block until
 * its fence closed — causing visible reflow mid-stream — and (b) had no
 * syntax highlighting despite the .hljs theme already shipped in index.css.
 *
 * Streaming-safety: `preprocessStreamingMarkdown` closes any open fenced
 * code block before passing to react-markdown so the AST stays well-formed
 * while tokens are still arriving. Without this a partial ``` opening fence
 * would render as a bare paragraph and "snap" into a code block when the
 * closing fence arrives (the original reflow bug).
 */
function preprocessStreamingMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  let openFence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;

    const marker = fence[2][0] as '`' | '~';
    const length = fence[2].length;
    const trailing = fence[3].trim();

    if (!openFence) {
      openFence = { marker, length };
      continue;
    }

    if (marker === openFence.marker && length >= openFence.length && !trailing) {
      openFence = null;
    }
  }

  if (!openFence) return src;
  return `${src}\n${openFence.marker.repeat(openFence.length)}`;
}

function textFromNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return textFromNode(props.children);
  }
  return '';
}

const markdownComponents = {
  // Render `code` inside `pre` with a copy button + language chip. Inline
  // code (no language, single line) gets a lighter treatment.
  code(props: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const { className, children, ...rest } = props;
    const match = /language-([^\s]+)/.exec(className || '');
    const text = textFromNode(children);
    const isBlock = !!match || text.includes('\n');

    if (!isBlock) {
      return (
        <code
          className={cn(
            'px-1.5 py-0.5 rounded bg-iron/40 border border-iron/30',
            'text-cyan-glow font-mono text-[0.85em]',
          )}
          {...rest}
        >
          {children}
        </code>
      );
    }

    const lang = match?.[1] ?? 'text';
    const raw = text.replace(/\n$/, '');
    return <CodeBlock lang={lang} raw={raw}>{children}</CodeBlock>;
  },
  pre(props: React.ComponentPropsWithoutRef<'pre'>) {
    const { children } = props;
    // Pass-through — CodeBlock renders its own <pre> with the toolbar.
    return <>{children}</>;
  },
  a(props: React.ComponentPropsWithoutRef<'a'>) {
    const { href, children } = props;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-cyan-glow underline underline-offset-2 hover:text-cyan-neon transition-colors"
      >
        {children}
      </a>
    );
  },
  table(props: React.ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="my-2 overflow-x-auto rounded-lg border border-iron/40">
        <table className="min-w-full text-[11px] font-mono" {...props} />
      </div>
    );
  },
  th(props: React.ComponentPropsWithoutRef<'th'>) {
    return <th className="px-2 py-1 text-left text-bone-muted bg-iron/30 border-b border-iron/40" {...props} />;
  },
  td(props: React.ComponentPropsWithoutRef<'td'>) {
    return <td className="px-2 py-1 border-b border-iron/20" {...props} />;
  },
};

interface CodeBlockProps {
  lang: string;
  raw: string;
  children: React.ReactNode;
}

function CodeBlock({ lang, raw, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequest = useRef(0);

  const clearCopyTimer = useCallback(() => {
    if (copyTimer.current === null) return;
    clearTimeout(copyTimer.current);
    copyTimer.current = null;
  }, []);

  useEffect(() => {
    copyRequest.current += 1;
    clearCopyTimer();
    setCopied(false);
    setCopyError(false);
    return () => {
      copyRequest.current += 1;
      clearCopyTimer();
    };
  }, [clearCopyTimer, raw]);

  const handleCopy = useCallback(async () => {
    const request = ++copyRequest.current;
    clearCopyTimer();
    setCopyError(false);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(raw);
      if (request !== copyRequest.current) return;
      setCopied(true);
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      if (request !== copyRequest.current) return;
      setCopied(false);
      setCopyError(true);
    }
  }, [clearCopyTimer, raw]);

  return (
    <div className="group relative my-2 rounded-lg border border-iron/40 bg-void/60 overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1 bg-iron/20 border-b border-iron/40">
        <span className="text-[9px] font-mono uppercase tracking-widest text-bone-dim">{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`${copied ? 'Copied' : 'Copy'} ${lang} code`}
          className="text-bone-faint hover:text-cyan-glow transition-colors p-0.5 rounded"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      {copyError && <p role="alert" className="px-2.5 py-1 text-[10px] text-red-300">Could not copy code to clipboard.</p>}
      <pre className="px-3 py-2.5 overflow-x-auto text-[11px] leading-relaxed font-mono">
        <code className={lang ? `hljs language-${lang}` : 'hljs'}>{children}</code>
      </pre>
    </div>
  );
}

function MarkdownView({ content, className }: MarkdownViewProps) {
  // Skip marked-leaf rendering for empty / whitespace-only content. Saves a
  // render pass while the very first token is still in flight.
  const processed = useMemo(() => preprocessStreamingMarkdown(content || ''), [content]);

  if (!content || !content.trim()) return null;

  return (
    <div className={cn('prose-invert max-w-none text-sm leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={markdownComponents}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownView);