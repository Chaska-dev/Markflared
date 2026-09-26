import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { XIcon, NotebookIcon } from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

// Curated set of workspace icons. Large/colorful emojis work well at 20-24px.
const WORKSPACE_ICONS = [
  '📋', '📁', '📂', '🗂️', '🗃️',
  '📚', '📖', '📕', '📗', '📘',
  '🧠', '💡', '⚡', '🔥', '✨',
  '🚀', '🎯', '🎨', '🛠️', '⚙️',
  '🏠', '🏢', '🌍', '🌟', '💎',
  '🧩', '🧪', '🔬', '🎓', '🧭',
];

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

export function WorkspaceSettings({ open, onClose, anchorRect }: Props) {
  const { workspace, updateWorkspace } = useWorkspace();
  const { t } = useLanguage();
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Sync form with workspace state when opened.
  useEffect(() => {
    if (open) {
      setName(workspace.name);
      setIcon(workspace.icon);
      setError(null);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [open, workspace.name, workspace.icon]);

  // Close on Escape / outside click.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    // mousedown (not click) so picking an icon doesn't dismiss before the click finishes.
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t('settings.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      await updateWorkspace({ name: name.trim(), icon });
      onClose();
    } catch (e: any) {
      setError(e?.message || t('settings.saveError'));
    } finally {
      setSaving(false);
    }
  };

  // Anchored near trigger (flips above if trigger is in the lower half); centered when no anchor.
  const isBottomAnchor = Boolean(anchorRect && anchorRect.top > window.innerHeight / 2);
  const style: React.CSSProperties = anchorRect
    ? (isBottomAnchor
        ? {
            bottom: Math.max(16, window.innerHeight - anchorRect.top + 8),
            left: Math.max(12, Math.min(anchorRect.left, window.innerWidth - 340)),
          }
        : {
            top: anchorRect.bottom + 8,
            left: Math.max(12, Math.min(anchorRect.left, window.innerWidth - 340)),
          }
      )
    : {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      };

  return createPortal(
    <>
      <div className="workspace-settings-overlay" onClick={onClose} aria-hidden="true" />
      <div
        ref={popoverRef}
        className="workspace-settings"
        style={style}
        role="dialog"
        aria-label={t('settings.title')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
            // Enter fuera de los botones del grid de iconos = guardar.
            e.preventDefault();
            handleSave();
          }
        }}
      >
        <div className="workspace-settings-header">
          <span className="workspace-settings-title">{t('settings.title')}</span>
          <button
            type="button"
            className="workspace-settings-close"
            onClick={onClose}
            aria-label={t('settings.cancel')}
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="workspace-settings-preview">
          <div className="workspace-settings-preview-icon">
            {icon || <NotebookIcon size={28} />}
          </div>
          <div className="workspace-settings-preview-name">{name || t('settings.untitled')}</div>
        </div>

        <label className="workspace-settings-label">
          {t('settings.name')}
          <input
            ref={nameInputRef}
            type="text"
            className="workspace-settings-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={t('settings.namePlaceholder')}
            disabled={saving}
          />
        </label>

        <div className="workspace-settings-label">{t('settings.icon')}</div>
        <div className="workspace-settings-icons">
          {WORKSPACE_ICONS.map((emo, idx) => (
            <button
              key={`${emo}-${idx}`}
              type="button"
              className={`workspace-settings-icon ${emo === icon ? 'active' : ''}`}
              onClick={() => setIcon(emo)}
              disabled={saving}
              aria-label={`${t('settings.icon')} ${emo}`}
            >
              {emo}
            </button>
          ))}
        </div>

        {error && <div className="workspace-settings-error">{error}</div>}

        <div className="workspace-settings-actions">
          <button
            type="button"
            className="workspace-settings-btn workspace-settings-btn--secondary"
            onClick={onClose}
            disabled={saving}
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            className="workspace-settings-btn"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {t('settings.save')}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}