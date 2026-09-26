// Read-only block renderer used by the public shared view. Unlike Block.tsx
// it has no drag handle, context menu, or inline editing — just persisted
// content, with a navigable link for `subpage` blocks (pointing to
// /share/:token?p=pageId).

import React, { useState } from 'react';
import katex from 'katex';
import { Block } from '../types';
import { DocumentIcon, ArrowUpRightIcon, PaperclipIcon, CopyIcon, CheckIcon } from './Icons';
import { inlineMarkdownToHtml, plainTextToSafeHtml } from './inlineMarkdown';

interface Props {
  block: Block;
  // Active share token, for constructing internal subpage URLs.
  shareToken: string;
}

// dangerouslySetInnerHTML with the inline markdown converter for block types
// where links/bold/italic/inline code make sense (headings, paragraph, quote,
// callout, lists). For code/todo we skip inline markdown because it would
// break semantics (a link inside a checkbox? no).
const renderRich = (text: string) => ({ __html: inlineMarkdownToHtml(text) });
const renderPlain = (text: string) => ({ __html: plainTextToSafeHtml(text) });

export function ReadOnlyBlock({ block, shareToken }: Props) {
  switch (block.type) {
    case 'heading1':
      return <h1 className="readonly-block readonly-h1" dangerouslySetInnerHTML={renderRich(block.content)} />;
    case 'heading2':
      return <h2 className="readonly-block readonly-h2" dangerouslySetInnerHTML={renderRich(block.content)} />;
    case 'heading3':
      return <h3 className="readonly-block readonly-h3" dangerouslySetInnerHTML={renderRich(block.content)} />;
    case 'bullet_list':
      return (
        <div className="readonly-block readonly-list">
          <span className="readonly-list-marker">•</span>
          <span dangerouslySetInnerHTML={renderRich(block.content)} />
        </div>
      );
    case 'numbered_list':
      // Real numbering (1, 2, 3...) would require carrying an index; in the
      // read-only view we show a generic marker that still reads as ordered.
      return (
        <div className="readonly-block readonly-list">
          <span className="readonly-list-marker">1.</span>
          <span dangerouslySetInnerHTML={renderRich(block.content)} />
        </div>
      );
    case 'todo':
      // Todo: no inline markdown — checkbox + line-through is its own semantics.
      // Just escaped text.
      return (
        <div className="readonly-block readonly-todo">
          <span className={`readonly-checkbox${block.checked ? ' checked' : ''}`}>
            {block.checked ? '✓' : ''}
          </span>
          <span style={block.checked ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}
                dangerouslySetInnerHTML={renderPlain(block.content)} />
        </div>
      );
    case 'quote':
      return <div className="readonly-block readonly-quote" dangerouslySetInnerHTML={renderRich(block.content)} />;
    case 'callout':
      // Callout: "💡 " prefix + rich content. inlineMarkdownToHtml escapes
      // the text so the emoji is rendered as a safe literal.
      return (
        <div className="readonly-block readonly-callout">
          💡 <span dangerouslySetInnerHTML={renderRich(block.content)} />
        </div>
      );
    case 'divider':
      return <hr className="readonly-divider" />;
    case 'code':
      // Code block content is literal (no inline markdown). The inner <code>
      // is the semantic container without the .inline-code class.
      return (
        <div className="readonly-code-container">
          <div className="readonly-code-header">
            <span className="readonly-code-lang">{block.language || 'code'}</span>
            <CopyButton text={block.content} />
          </div>
          <pre className="readonly-block readonly-code">
            <code dangerouslySetInnerHTML={renderPlain(block.content)} />
          </pre>
        </div>
      );
    case 'math': {
      let html = '';
      try {
        html = katex.renderToString(block.content || '', {
          displayMode: true,
          throwOnError: false,
        });
      } catch (e: any) {
        html = `<span class="katex-error">${e?.message || 'LaTeX error'}</span>`;
      }
      return (
        <div
          className="readonly-block readonly-math"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case 'image':
      return (
        <div className="readonly-block readonly-image">
          {block.content ? (
            <img src={block.content.startsWith('http') || block.content.startsWith('/') || block.content.startsWith('data:') ? block.content : `/api/files/${block.content}`} alt={block.language || ''} loading="lazy" />
          ) : null}
        </div>
      );
    case 'file':
      return (
        <a
          href={block.content ? `/api/files/${block.content}` : '#'}
          download={block.language || 'file'}
          className="readonly-block readonly-file"
        >
          <span className="readonly-file-icon"><PaperclipIcon size={16} /></span>
          <span className="readonly-file-name">{block.language || 'Attached file'}</span>
        </a>
      );
    case 'subpage':
      // Subpage inside a share: navigate using ?p=id so SharedView keeps the
      // active token and loads the child.
      return (
        <a
          href={`/share/${encodeURIComponent(shareToken)}?p=${encodeURIComponent(block.content)}`}
          className="readonly-block readonly-subpage"
          title="Open subpage"
        >
          <span className="readonly-subpage-icon"><DocumentIcon size={16} /></span>
          <span className="readonly-subpage-title">Subpage</span>
          <span className="readonly-subpage-arrow"><ArrowUpRightIcon size={12} /></span>
        </a>
      );
    case 'table':
      // Tables are a composite block (TableBlock) with internal state. In the
      // simplified public view we show a placeholder; a future build-out could
      // request the sub-render detail from the backend.
      return (
        <div className="readonly-block readonly-table-placeholder">[Table]</div>
      );
    case 'paragraph':
    default:
      return <div className="readonly-block readonly-paragraph" dangerouslySetInnerHTML={renderRich(block.content)} />;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      className="readonly-code-copy-btn"
      onClick={handleCopy}
      title="Copy code"
      aria-label="Copy code"
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
