// Popover for activating/revoking the public link of a page. Reuses the
// WorkspaceSettings pattern: click-outside, Escape. Not a modal — anchored to
// the trigger button. Backend errors are shown inline (the popover is already
// open; the user has immediate context). The token is never persisted in
// the frontend beyond this popover; the backend regenerates it on every
// activation.

import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { ShareIcon, CopyIcon, CheckIcon, EyeIcon, LoaderIcon, ArrowUpRightIcon } from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  pageId: string;
  pageTitle: string;
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

interface ShareInfo {
  token: string;
  created_at: string;
}

export function SharePopover({ pageId, pageTitle, open, onClose, anchorRect }: Props) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { t } = useLanguage();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // True when no share exists yet; shows the "Activate" CTA.
  const [notFound, setNotFound] = useState(false);

  // Absolute URL: window.location.origin + /share/<token>. May not match the
  // real public URL behind a proxy, but it's the best we can do client-side.
  const shareUrl = info ? `${window.location.origin}/share/${info.token}` : '';

  // Load current state on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setNotFound(false);
    setInfo(null);
    setLoading(true);
    api.shares
      .get(pageId)
      .then((data) => {
        if (cancelled) return;
        if (data && !data.revoked) {
          setInfo({ token: data.token, created_at: data.created_at });
          setNotFound(false);
        } else {
          setInfo(null);
          setNotFound(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const isNotFound =
          (err instanceof ApiError && err.status === 404) ||
          err?.status === 404 ||
          (err instanceof Error && (/404/.test(err.message) || /No active share/i.test(err.message)));
        if (isNotFound) {
          setInfo(null);
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pageId]);

  // Close on Escape + outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        // We always close on outside click; the parent decides whether to reopen.
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    // mousedown (not click) so the trigger button can re-open without
    // a stale close firing before the open state updates.
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  // Position below the trigger, right-aligned so it stays on-screen in narrow viewports.
  const top = anchorRect.bottom + 6;
  const popWidth = 340;
  const left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, anchorRect.right - popWidth));

  const activate = async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.shares.create(pageId);
      setInfo({ token: data.token, created_at: data.created_at });
      setNotFound(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error activating');
    } finally {
      setLoading(false);
    }
  };

  const deactivate = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.shares.revoke(pageId);
      setInfo(null);
      setNotFound(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error revoking');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback: temporary textarea. Clipboard API requires a secure context,
      // so on http://localhost this is necessary in dev.
      const ta = document.createElement('textarea');
      ta.value = shareUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  return (
    <div
      ref={popoverRef}
      className="share-popover"
      style={{ top, left, width: popWidth }}
      role="dialog"
      aria-label={t('share.title')}
    >
      <div className="share-popover-header">
        <ShareIcon size={14} />
        <span>{t('share.title')}</span>
      </div>

      {loading && !info && (
        <div className="share-popover-loading">
          <LoaderIcon size={14} />
          <span>{t('common.loading')}</span>
        </div>
      )}

      {error && (
        <div className="share-popover-error" role="alert">
          {error}
        </div>
      )}

      {!loading && notFound && (
        <div className="share-popover-body">
          <p className="share-popover-help">
            {t('share.helpInactive', { title: pageTitle || t('page.thisPage') })}
          </p>
          <button className="share-popover-cta" onClick={activate} disabled={loading}>
            <EyeIcon size={14} />
            <span>{t('share.activate')}</span>
          </button>
        </div>
      )}

      {info && (
        <div className="share-popover-body">
          <div className="share-popover-status">
            <span className="share-popover-dot" />
            <span>{t('share.activated')}</span>
          </div>
          <div className="share-popover-url-row">
            <input
              className="share-popover-url"
              value={shareUrl}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t('share.publicUrl')}
            />
            <button
              className="share-popover-copy"
              onClick={copy}
              title={copied ? t('share.copied') : t('share.copy')}
              aria-label={t('share.copy')}
            >
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="share-popover-copy"
              title={t('share.openLink')}
              aria-label={t('share.openLink')}
            >
              <ArrowUpRightIcon size={14} />
            </a>
          </div>
          <button
            className="share-popover-revoke"
            onClick={deactivate}
            disabled={loading}
          >
            {t('share.revoke')}
          </button>
        </div>
      )}
    </div>
  );
}
