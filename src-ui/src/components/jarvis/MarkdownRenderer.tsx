import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { cn } from '../ui';
import { projectLink } from '../../lib/link-scheme';
import RefusedMarkdownLink from './RefusedMarkdownLink';
import {
  COPY_SUCCESS_TIMEOUT_MS,
  initialCopyOutcome,
  projectCopyOutcome,
  reduceCopyOutcome,
} from './copy-outcome';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Simple markdown renderer for chat messages.
 * Handles basic formatting: bold, italic, code, code blocks, lists, and links.
 */
export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const [copyState, dispatchCopy] = useReducer(reduceCopyOutcome, undefined, initialCopyOutcome);
  const copyAttempt = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = projectCopyOutcome(copyState);

  const clearCopyTimer = useCallback(() => {
    if (copyTimer.current === null) return;
    clearTimeout(copyTimer.current);
    copyTimer.current = null;
  }, []);

  // A claim is about the text that was on screen when the control was clicked,
  // so a different `content` retires it and re-fences any write still in flight
  // for the old text. The success timer is cleared on the way out, and on unmount.
  useEffect(() => {
    copyAttempt.current += 1;
    dispatchCopy({ type: 'reset', attempt: copyAttempt.current });
    return clearCopyTimer;
  }, [content, clearCopyTimer]);

  const handleCopy = useCallback(async () => {
    const attempt = ++copyAttempt.current;
    clearCopyTimer();
    dispatchCopy({ type: 'attempt', attempt });
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content ?? '');
        dispatchCopy({ type: 'confirmed', attempt });
        copyTimer.current = setTimeout(() => {
          copyTimer.current = null;
          dispatchCopy({ type: 'expired', attempt });
        }, COPY_SUCCESS_TIMEOUT_MS);
      } else {
        throw new Error('clipboard unavailable');
      }
    } catch (e) {
      // The caught value stays with a developer; the surface gets the fixed
      // sentence from the shared projection, which cannot carry a reason.
      console.error('Failed to copy:', e);
      dispatchCopy({ type: 'failed', attempt });
    }
  }, [clearCopyTimer, content]);
  if (!content) return null;

  // Split content by code blocks first
  const segments: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before code block
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }
    // Add code block
    segments.push({
      type: 'code',
      content: match[2],
      language: match[1],
    });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  // If no segments, treat entire content as text
  if (segments.length === 0) {
    segments.push({ type: 'text', content });
  }

  return (
    <div className={cn('markdown-content', className)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copy.copied ? 'Copied' : 'Copy to clipboard'}
            className="text-xs px-2 py-0.5 rounded bg-ink/60 text-bone/90 hover:bg-ink/80 transition-colors"
          >
            {copy.copied ? 'Copied' : 'Copy'}
          </button>
          {copy.message && (
            <span role="alert" className="text-[10px] leading-tight text-red-300">{copy.message}</span>
          )}
        </div>
      </div>

      {segments.map((segment, idx) =>
        segment.type === 'code' ? (
          <pre
            key={idx}
            className="my-2 p-3 bg-obsidian/80 border border-iron/30 rounded-lg overflow-x-auto"
          >
            {segment.language && (
              <div className="text-[10px] font-mono text-bone-faint mb-1 uppercase">
                {segment.language}
              </div>
            )}
            <code className="text-xs font-mono text-cyan-neon/90 whitespace-pre">
              {segment.content}
            </code>
          </pre>
        ) : (
          <div key={idx} className="space-y-2">
            {renderInlineMarkdown(segment.content)}
          </div>
        )
      )}
    </div>
  );
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let inUnorderedList = false;
  let inOrderedList = false;
  let unorderedItems: React.ReactNode[] = [];
  let orderedItems: React.ReactNode[] = [];

  const flushUnordered = () => {
    if (inUnorderedList && unorderedItems.length > 0) {
      result.push(
        <ul key={`ul-${result.length}`} className="list-disc list-inside space-y-1 my-2">
          {unorderedItems}
        </ul>
      );
      unorderedItems = [];
      inUnorderedList = false;
    }
  };

  const flushOrdered = () => {
    if (inOrderedList && orderedItems.length > 0) {
      result.push(
        <ol key={`ol-${result.length}`} className="list-decimal list-inside space-y-1 my-2">
          {orderedItems}
        </ol>
      );
      orderedItems = [];
      inOrderedList = false;
    }
  };

  const flushLists = () => {
    flushUnordered();
    flushOrdered();
  };

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim();

    // Handle blockquotes (collect consecutive `> ` lines into one block)
    if (trimmed.startsWith('> ')) {
      flushLists();
      const quoteText = trimmed.slice(2);
      result.push(
        <blockquote
          key={lineIdx}
          className="border-l-2 border-royal/40 pl-3 my-2 text-bone/70 italic"
        >
          {processInlineStyles(quoteText)}
        </blockquote>
      );
      return;
    }

    // Unordered list items (- or *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushOrdered();
      inUnorderedList = true;
      unorderedItems.push(
        <li key={lineIdx} className="text-bone/80">
          {processInlineStyles(trimmed.slice(2))}
        </li>
      );
      return;
    }

    // Ordered list items (1. 2. etc.)
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (orderedMatch) {
      flushUnordered();
      inOrderedList = true;
      orderedItems.push(
        <li key={lineIdx} className="text-bone/80">
          {processInlineStyles(orderedMatch[2])}
        </li>
      );
      return;
    }

    flushLists();

    // Handle headers
    if (trimmed.startsWith('#### ')) {
      result.push(
        <h4 key={lineIdx} className="text-xs font-semibold text-bone mt-2 mb-1">
          {processInlineStyles(trimmed.slice(5))}
        </h4>
      );
      return;
    }
    if (trimmed.startsWith('### ')) {
      result.push(
        <h3 key={lineIdx} className="text-sm font-semibold text-bone mt-3 mb-1">
          {processInlineStyles(trimmed.slice(4))}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith('## ')) {
      result.push(
        <h2 key={lineIdx} className="text-base font-semibold text-bone mt-4 mb-2">
          {processInlineStyles(trimmed.slice(3))}
        </h2>
      );
      return;
    }
    if (trimmed.startsWith('# ')) {
      result.push(
        <h1 key={lineIdx} className="text-lg font-bold text-bone mt-4 mb-2">
          {processInlineStyles(trimmed.slice(2))}
        </h1>
      );
      return;
    }

    // Handle horizontal rule
    if (trimmed === '---' || trimmed === '***') {
      result.push(
        <hr key={lineIdx} className="my-3 border-iron/30" />
      );
      return;
    }

    // Regular paragraph
    if (trimmed) {
      result.push(
        <p key={lineIdx} className="text-bone/80 leading-relaxed">
          {processInlineStyles(line)}
        </p>
      );
    } else {
      // Empty line - add spacing
      result.push(<div key={lineIdx} className="h-2" />);
    }
  });

  flushLists();
  return result;
}

function processInlineStyles(text: string): React.ReactNode {
  // Process inline code, bold, italic, and links
  const parts: React.ReactNode[] = [];
  let key = 0;

  const patterns = [
    { regex: /`([^`]+)`/g, type: 'code' as const },
    { regex: /\*\*([^*]+)\*\*/g, type: 'bold' as const },
    { regex: /__([^_]+)__/g, type: 'bold' as const },
    { regex: /\*([^*]+)\*/g, type: 'italic' as const },
    { regex: /_([^_]+)_/g, type: 'italic' as const },
    { regex: /\[([^\]]+)\]\(([^)]+)\)/g, type: 'link' as const },
  ];

  // Find all matches
  const allMatches: Array<{ index: number; length: number; type: string; groups: string[] }> = [];

  patterns.forEach((pattern) => {
    let match;
    const regex = new RegExp(pattern.regex.source, 'g');
    while ((match = regex.exec(text)) !== null) {
      allMatches.push({
        index: match.index,
        length: match[0].length,
        type: pattern.type,
        groups: match.slice(1),
      });
    }
  });

  // Sort by index
  allMatches.sort((a, b) => a.index - b.index);

  // Filter out overlapping matches
  const validMatches: typeof allMatches = [];
  let lastEnd = -1;
  for (const match of allMatches) {
    if (match.index >= lastEnd) {
      validMatches.push(match);
      lastEnd = match.index + match.length;
    }
  }

  // Build result
  let currentPos = 0;
  for (const match of validMatches) {
    if (match.index > currentPos) {
      parts.push(text.slice(currentPos, match.index));
    }

    switch (match.type) {
      case 'code':
        parts.push(
          <code key={key++} className="px-1 py-0.5 bg-obsidian/60 border border-iron/30 rounded text-[11px] font-mono text-cyan-neon/90">
            {match.groups[0]}
          </code>
        );
        break;
      case 'bold':
        parts.push(
          <strong key={key++} className="font-semibold text-bone">
            {match.groups[0]}
          </strong>
        );
        break;
      case 'italic':
        parts.push(
          <em key={key++} className="italic text-bone/90">
            {match.groups[0]}
          </em>
        );
        break;
      case 'link': {
        const link = projectLink(match.groups[1]);
        if (!link.allowed) {
          parts.push(
            <RefusedMarkdownLink key={key++} text={match.groups[0]} address={link.address} />
          );
          break;
        }
        parts.push(
          <a
            key={key++}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-neon hover:text-cyan-glow underline underline-offset-2"
          >
            {match.groups[0]}
          </a>
        );
        break;
      }
    }

    currentPos = match.index + match.length;
  }

  if (currentPos < text.length) {
    parts.push(text.slice(currentPos));
  }

  return parts.length === 0 ? text : parts;
}
