import React, { useState } from 'react';
import { usePageContext } from '../contexts/PageContext';
import { PlusIcon, DownloadIcon } from './Icons';
import { Logo } from './Logo';
import { useLanguage } from '../i18n/LanguageContext';
import { ImportModal } from './ImportModal';

export function EmptyState() {
  const { createPage, refreshPages } = usePageContext();
  const { t } = useLanguage();
  const [importModalOpen, setImportModalOpen] = useState(false);

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
        <button
          className="empty-state-btn empty-state-btn--secondary"
          onClick={() => setImportModalOpen(true)}
        >
          <DownloadIcon size={15} />
          <span>{t('empty.importCta')}</span>
        </button>
      </div>

      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={async () => {
          await refreshPages();
        }}
      />
    </div>
  );
}