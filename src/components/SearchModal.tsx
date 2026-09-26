import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { SearchResult } from '../types';
import { SearchIcon, DocumentIcon, XIcon, LoaderIcon } from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchModal({ open, onClose }: Props) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      api.search(trimmed)
        .then((res) => {
          setResults(res.results || []);
          setSelectedIndex(0);
        })
        .catch((err) => {
          console.error('Search error:', err);
          setResults([]);
        })
        .finally(() => {
          setLoading(false);
        });
    }, 200);

    return () => clearTimeout(timer);
  }, [query, open]);

  const handleSelect = useCallback((item: SearchResult) => {
    onClose();
    navigate(`/page/${item.page_id}`);
  }, [navigate, onClose]);

  // Keyboard navigation inside the modal.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleSelect(results[selectedIndex]);
      }
    }
  };

  if (!open) return null;

  // Render via Portal so position:fixed on the backdrop is anchored to the
  // viewport (see ConfirmDialog for the containing-block gotcha).
  return createPortal(
    <div className="search-backdrop" onClick={onClose}>
      <div
        className="search-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('search.ariaLabel')}
      >
        <div className="search-input-wrapper">
          <span className="search-input-icon">
            <SearchIcon size={18} />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {loading && (
            <span className="search-spinner">
              <LoaderIcon size={16} />
            </span>
          )}
          {query && !loading && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                setQuery('');
                setResults([]);
                inputRef.current?.focus();
              }}
              aria-label={t('search.clear')}
            >
              <XIcon size={14} />
            </button>
          )}
        </div>

        <div className="search-results-list">
          {query.trim() === '' ? (
            <div className="search-hint">
              <span>{t('search.hint')}</span>
              <div className="search-shortcuts-hint">
                <span><kbd>↑</kbd> <kbd>↓</kbd> {t('search.navKey')}</span>
                <span><kbd>Enter</kbd> {t('search.selectKey')}</span>
                <span><kbd>Esc</kbd> {t('search.closeKey')}</span>
              </div>
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="search-empty">
              {t('search.noResults', { query })}
            </div>
          ) : (
            results.map((res, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={`${res.match_type}-${res.id}-${idx}`}
                  className={`search-result-item ${isSelected ? 'search-result-item--selected' : ''}`}
                  onClick={() => handleSelect(res)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="search-result-icon">
                    {res.icon ? <span>{res.icon}</span> : <DocumentIcon size={16} />}
                  </div>
                  <div className="search-result-info">
                    <div className="search-result-header">
                      <span className="search-result-title">{res.title}</span>
                      <span className="search-result-badge">
                        {res.match_type === 'page' ? t('search.badgePage') : (res.block_type || t('search.badgeBlock'))}
                      </span>
                    </div>
                    {res.match_type === 'block' && res.snippet && (
                      <div className="search-result-snippet">{res.snippet}</div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
