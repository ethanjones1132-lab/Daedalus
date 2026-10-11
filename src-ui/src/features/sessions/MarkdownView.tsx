import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../design';

interface MarkdownViewProps {
  content: string;
  className?: string;
}

/**
 * Streaming-safe markdown for Session answers.
 *
 * react-markdown + remark-gfm + rehype-highlight, typeset with the Daedalus
 * `.d-prose` measure. `preprocessStreamingMarkdown` closes any open fenced
 * block before parsing so a code block never "snaps" into place when its
 * closing fence finally streams in.
 */
export function preprocessStreamingMarkdown(src: string): string {
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

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return textFromNode(props.children);
  }
  return '';
}

const markdownComponents = {
  code(props: ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const { className, children, ...rest } = props;
    const match = /language-([^\s]+)/.exec(className || '');
    const text = textFromNode(children);
    const isBlock = !!match || text.includes('\n');

    if (!isBlock) {
      // Inline code is styled by `.d-prose :not(pre) > code`.
      return <code {...rest}>{children}</code>;
    }

    const lang = match?.[1] ?? 'text';
    const raw = text.replace(/\n$/, '');
    return (
      <CodeBlock lang={lang} raw={raw}>
        {children}
      </CodeBlock>
    );
  },
  pre(props: ComponentPropsWithoutRef<'pre'>) {
    // Pass-through — CodeBlock renders its own <pre> with the toolbar.
    return <>{props.children}</>;
  },
  a(props: ComponentPropsWithoutRef<'a'>) {
    const { href, children } = props;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table(props: ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-line bg-surface">
        <table {...props} />
      </div>
    );
  },
};

interface CodeBlockProps {
  lang: string;
  raw: string;
  children: ReactNode;
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
    <div className="group/code relative my-3 overflow-hidden rounded-lg border border-line bg-sunken not-italic">
      <div className="flex h-8 items-center justify-between border-b border-line pl-3 pr-1.5">
        <span className="d-label text-[9.5px] text-ink-3">{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`${copied ? 'Copied' : 'Copy'} ${lang} code`}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10.5px] transition-colors',
            copied ? 'text-ok' : 'text-ink-4 hover:bg-hover hover:text-ink',
          )}
        >
          {copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
          <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {copyError && (
        <p role="alert" className="border-b border-line bg-err-wash px-3 py-1 text-[11.5px] text-err">
          Could not copy code to clipboard.
        </p>
      )}
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12px] leading-[1.65]">
        <code className={lang ? `hljs language-${lang}` : 'hljs'}>{children}</code>
      </pre>
    </div>
  );
}

function MarkdownView({ content, className }: MarkdownViewProps) {
  const processed = useMemo(() => preprocessStreamingMarkdown(content || ''), [content]);

  if (!content || !content.trim()) return null;

  return (
    <div className={cn('d-prose', className)}>
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
