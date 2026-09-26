import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangleIcon, XIcon } from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  open: boolean;
  title: string;
  // Main description. String or ReactNode for cases with details
  // (e.g. "This will delete 3 subpages and 47 blocks.").
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // "danger" paints the confirm button red (default for deletes).
  confirmTone?: 'danger' | 'primary';
  // Disables the confirm while a promise runs. Controlled by the parent.
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmTone = 'danger',
  loading = false,
  onConfirm,
  onCancel,
}: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const { t } = useLanguage();
  // i18n defaults: fall back to current-language labels if caller didn't pass them.
  const finalConfirmLabel = confirmLabel ?? t('dialog.delete');
  const finalCancelLabel = cancelLabel ?? t('dialog.cancel');

  // Close on Escape, focus the destructive button on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKey);
    // Focus the confirm button so Enter triggers it without an extra Tab.
    const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [open, onCancel, loading]);

  if (!open) return null;

  // Render via Portal at document.body so position:fixed on the backdrop is
  // anchored to the viewport, not to an ancestor with transform/filter/etc.
  // (Sidebar in narrow mode has transform: translateX(-100%) which would
  // otherwise make the dialog appear pinned to the sidebar's offscreen
  // position.)
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={(e) => {
      // Click on backdrop (not panel) closes — except while loading.
      if (e.target === e.currentTarget && !loading) onCancel();
    }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="confirm-panel"
      >
        <button
          type="button"
          className="confirm-close"
          onClick={() => { if (!loading) onCancel(); }}
          aria-label={finalCancelLabel}
          disabled={loading}
        >
          <XIcon size={16} />
        </button>
        <div className="confirm-icon">
          <AlertTriangleIcon size={20} />
        </div>
        <h2 id="confirm-dialog-title" className="confirm-title">{title}</h2>
        {description && <div className="confirm-description">{description}</div>}
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn--cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {finalCancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            className={`confirm-btn confirm-btn--${confirmTone}`}
            onClick={() => onConfirm()}
            disabled={loading}
          >
            {loading ? `${finalConfirmLabel}...` : finalConfirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}