// Small EN/ES dropdown. Defaults to English; persists in localStorage.
import React, { useState, useRef, useEffect } from 'react';
import { useLanguage, type Language } from '../i18n/LanguageContext';
import { GlobeIcon } from './Icons';

interface Props {
  direction?: 'up' | 'down';
  align?: 'left' | 'right';
}

export function LanguageSwitcher({ direction = 'up', align = 'left' }: Props) {
  const { language, setLanguage, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const choose = (lang: Language) => {
    setLanguage(lang);
    setOpen(false);
  };

  return (
    <div className={`lang-switcher lang-switcher--${direction} lang-switcher--align-${align}`} ref={wrapperRef}>
      <button
        type="button"
        className="lang-switcher-trigger"
        onClick={() => setOpen(o => !o)}
        aria-label={t('lang.label')}
        aria-expanded={open}
        title={t('lang.label')}
      >
        <GlobeIcon size={14} />
        <span className="lang-switcher-code">{language.toUpperCase()}</span>
      </button>
      {open && (
        <div className="lang-switcher-menu" role="menu">
          <button
            type="button"
            className={`lang-switcher-item${language === 'en' ? ' is-active' : ''}`}
            onClick={() => choose('en')}
            role="menuitem"
          >
            <span className="lang-switcher-item-code">EN</span>
            <span>{t('lang.en')}</span>
          </button>
          <button
            type="button"
            className={`lang-switcher-item${language === 'es' ? ' is-active' : ''}`}
            onClick={() => choose('es')}
            role="menuitem"
          >
            <span className="lang-switcher-item-code">ES</span>
            <span>{t('lang.es')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
