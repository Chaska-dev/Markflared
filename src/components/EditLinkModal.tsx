import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../i18n/LanguageContext';
import {
  XIcon,
  LinkIcon,
  ArrowUpRightIcon,
  CopyIcon,
  CheckIcon,
  TrashIcon,
} from './Icons';

interface Props {
  open: boolean;
  initialTitle: string;
  initialUrl: string;
  anchorRect?: DOMRect | null;
  onSave: (newTitle: string, newUrl: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}

export function EditLinkModal({
  open,
  initialTitle,
  initialUrl,
  anchorRect,
  onSave,
  onRemove,
  onClose,
}: Props) {
  const { t } = useLanguage();
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState(initialUrl);
  const [copied, setCopied] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setUrl(initialUrl);
      setCopied(false);
      const timer = window.setTimeout(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      }, 50);
      return () => window.clearTimeout(timer);
    }
  }, [open, initialTitle, initialUrl]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, title, url]);

  if (!open) return null;

  const handleSave = () => {
    const trimmedTitle = title.trim() || url.trim();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      onClose();
      return;
    }
    onSave(trimmedTitle, trimmedUrl);
    onClose();
  };

  const handleOpenLink = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (/^(https?:|mailto:|tel:)/i.test(trimmed)) {
      window.open(trimmed, '_blank', 'noopener,noreferrer');
    } else {
      window.open(`https://${trimmed}`, '_blank', 'noopener,noreferrer');
    }
  };

  const handleCopyLink = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied
    }
  };

  // Smart positioning: floats just below/above the anchor link when anchorRect is provided.
  let panelStyle: React.CSSProperties = {};
  if (anchorRect) {
    const popWidth = 340;
    const isNarrow = typeof window !== 'undefined' && window.innerWidth < 400;
    const spaceBelow = typeof window !== 'undefined' ? window.innerHeight - anchorRect.bottom : 300;
    const top = spaceBelow > 280 ? anchorRect.bottom + 8 : Math.max(10, anchorRect.top - 280);
    const left = isNarrow ? 12 : Math.max(12, Math.min((window.innerWidth || 800) - popWidth - 12, anchorRect.left));

    panelStyle = {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      width: `${popWidth}px`,
    };
  } else {
    panelStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '350px',
      maxWidth: 'calc(100vw - 32px)',
    };
  }

  return createPortal(
    <>
      <div
        className="link-popover-overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-link-title"
        className={`link-popover-panel ${anchorRect ? 'link-popover-panel--anchored' : 'link-popover-panel--centered'}`}
        style={panelStyle}
      >
        <div className="link-popover-header">
          <div className="link-popover-title-row">
            <LinkIcon size={16} />
            <span id="edit-link-title">{t('linkModal.title')}</span>
          </div>
          <button
            type="button"
            className="link-popover-close"
            onClick={onClose}
            aria-label={t('linkModal.close')}
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="link-popover-fields">
          <div className="link-popover-field">
            <label className="link-popover-label">{t('linkModal.textLabel')}</label>
            <input
              ref={titleInputRef}
              type="text"
              className="link-popover-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('linkModal.textPlaceholder')}
            />
          </div>

          <div className="link-popover-field">
            <label className="link-popover-label">{t('linkModal.urlLabel')}</label>
            <input
              type="text"
              className="link-popover-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('linkModal.urlPlaceholder')}
            />
          </div>
        </div>

        <div className="link-popover-actions-bar">
          <div className="link-popover-quick-tools">
            <button
              type="button"
              className="link-popover-tool-btn"
              onClick={handleOpenLink}
              title={t('linkModal.openTooltip')}
              disabled={!url.trim()}
            >
              <ArrowUpRightIcon size={13} />
              <span>{t('linkModal.open')}</span>
            </button>

            <button
              type="button"
              className="link-popover-tool-btn"
              onClick={handleCopyLink}
              title={t('linkModal.copyTooltip')}
              disabled={!url.trim()}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              <span>{copied ? t('linkModal.copied') : t('linkModal.copy')}</span>
            </button>

            {onRemove && (
              <button
                type="button"
                className="link-popover-tool-btn link-popover-tool-btn--danger"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                title={t('linkModal.removeTooltip')}
              >
                <TrashIcon size={13} />
                <span>{t('linkModal.remove')}</span>
              </button>
            )}
          </div>

          <button
            type="button"
            className="link-popover-save-btn"
            onClick={handleSave}
            disabled={!url.trim()}
          >
            {t('linkModal.save')}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
