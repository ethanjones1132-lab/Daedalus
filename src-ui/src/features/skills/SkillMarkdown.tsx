import { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '../../design';
import { splitFrontmatter } from './skill-model';

/**
 * SKILL.md preview: react-markdown + GFM + syntax highlighting, styled with
 * the shared `.d-prose` voice. Raw HTML is never rendered (no rehype-raw).
 * Leading YAML frontmatter is shown as a quiet mono block, not as prose.
 */
export function SkillMarkdown({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const { front, rest } = splitFrontmatter(content);

  const copy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(content ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [content]);

  if (!content) return null;
  return (
    <div className="relative">
      <IconButton
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        onClick={copy}
        size="xs"
        className="absolute right-0 top-0"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </IconButton>
      {front !== null && (
        <pre className="mb-4 mr-8 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-3">
          {front}
        </pre>
      )}
      <div className="d-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          }}
        >
          {rest}
        </ReactMarkdown>
      </div>
    </div>
  );
}
