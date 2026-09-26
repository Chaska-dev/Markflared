import React, { useRef } from 'react';
import { usePageContext } from '../contexts/PageContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { PlusIcon, DownloadIcon } from './Icons';
import { Logo } from './Logo';
import { useLanguage } from '../i18n/LanguageContext';

export function EmptyState() {
  const { createPage, refreshPages } = usePageContext();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      const title = file.name.replace(/\.md$/i, '');
      try {
        const res = await api.pages.import({ markdown: content, title });
        await refreshPages();
        navigate(`/page/${res.page.id}`);
      } catch (err: any) {
        console.error(t('common.errorImport'), err);
        alert(`${t('common.errorImport')}: ${err?.message || t('common.errorGeneric')}`);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="empty-state">
      <div className="empty-state-icon"><Logo size={72} variant="icon" /></div>
      <div className="empty-state-text">
        <h2>{t('empty.welcome')}</h2>
        <p>{t('empty.subtitle')}</p>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="empty-state-btn" onClick={() => createPage(null)}>
          <PlusIcon size={15} />
          <span>{t('empty.cta')}</span>
        </button>
        <button className="empty-state-btn empty-state-btn--secondary" onClick={() => fileInputRef.current?.click()}>
          <DownloadIcon size={15} />
          <span>{t('empty.importCta')}</span>
        </button>
      </div>
      <input
        type="file"
        accept=".md"
        style={{ display: 'none' }}
        ref={fileInputRef}
        onChange={handleImport}
      />
    </div>
  );
}
