import React, { useEffect, useState } from 'react';
import { BLOCK_TYPES, BlockType } from '../types';
import {
  TextIcon,
  HeadingIcon,
  ListBulletIcon,
  ListOrderedIcon,
  CheckSquareIcon,
  CodeIcon,
  QuoteIcon,
  DividerIcon,
  LightbulbIcon,
  ImageIcon,
  PaperclipIcon,
  DocumentIcon,
  TableIcon,
  ChevronRightSmallIcon,
  MathIcon,
} from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  position: { top: number; left: number };
  query: string;
  onSelect: (type: BlockType) => void;
  onClose: () => void;
}

// Mapea el `icon` string (definido en BLOCK_TYPES) al componente SVG
// correspondiente. Si no hay match, muestra un punto genérico.
function SlashIcon({ name }: { name: string }) {
  const size = 16;
  switch (name) {
    case 'paragraph':
      return <TextIcon size={size} />;
    case 'heading1':
    case 'heading2':
    case 'heading3':
      return <HeadingIcon size={size} />;
    case 'bullet':
      return <ListBulletIcon size={size} />;
    case 'numbered':
      return <ListOrderedIcon size={size} />;
    case 'todo':
      return <CheckSquareIcon size={size} />;
    case 'code':
      return <CodeIcon size={size} />;
    case 'quote':
      return <QuoteIcon size={size} />;
    case 'divider':
      return <DividerIcon size={size} />;
    case 'callout':
      return <LightbulbIcon size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'file':
      return <PaperclipIcon size={size} />;
    case 'subpage':
      return <DocumentIcon size={size} />;
    case 'table':
      return <TableIcon size={size} />;
    case 'toggle':
      return <ChevronRightSmallIcon size={size} />;
    case 'math':
      return <MathIcon size={size} />;
    default:
      return <TextIcon size={size} />;
  }
}

export function SlashMenu({ position, query, onSelect, onClose }: Props) {
  const { t } = useLanguage();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filtramos comparando contra los strings traducidos en el idioma actual,
  // más los fallbacks en español (por si alguien renderiza sin contexto).
  const filtered = BLOCK_TYPES.filter(item => {
    const labelTranslated = t(item.labelKey).toLowerCase();
    const descTranslated = t(item.descriptionKey).toLowerCase();
    const q = query.toLowerCase();
    return labelTranslated.includes(q)
      || descTranslated.includes(q)
      || item.label.toLowerCase().includes(q)
      || item.description.toLowerCase().includes(q);
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].type);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, selectedIndex, onSelect, onClose]);

  return (
    <>
      <div className="slash-menu-overlay" onClick={onClose} />
      <div
        className="slash-menu"
        style={{ top: position.top + 20, left: position.left }}
      >
        {filtered.length === 0 ? (
          <div className="slash-menu-empty">{t('slash.empty')}</div>
        ) : (
          filtered.map((item, idx) => (
            <div
              key={item.type}
              className={`slash-menu-item ${idx === selectedIndex ? 'active' : ''}`}
              onClick={() => onSelect(item.type)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className="slash-menu-item-icon">
                <SlashIcon name={item.icon} />
              </div>
              <div className="slash-menu-item-info">
                <span className="slash-menu-item-label">{t(item.labelKey)}</span>
                <span className="slash-menu-item-desc">{t(item.descriptionKey)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}