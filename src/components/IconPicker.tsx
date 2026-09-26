import React, { useEffect, useRef, useState } from 'react';

const CATEGORIES = [
  {
    name: 'Projects & Tech',
    emojis: ['🚀', '💻', '⚡', '🎯', '📊', '🛠️', '💡', '📦', '🧩', '🌐', '🔒', '🏷️', '⚙️', '🔥', '🤖', '📱', '🕹️', '📡', '🔬', '🛡️'],
  },
  {
    name: 'Documentation',
    emojis: ['📄', '📝', '📑', '📚', '📖', '📋', '📌', '🗂️', '📁', '✍️', '🖊️', '🔖', '✉️', '🗞️', '🗒️', '📂', '📜', '📥', '📫', '🗃️'],
  },
  {
    name: 'Design & Ideas',
    emojis: ['🎨', '🎭', '🔮', '🌈', '📐', '✨', '🪄', '📸', '🎵', '🎬', '☕', '🧠', '🌟', '💎', '🪐', '💡', '🌱', '☀️', '☕', '🍕'],
  },
  {
    name: 'Status & Priority',
    emojis: ['✅', '⏳', '⭐', '🚩', '⚠️', '🟢', '🔵', '🟠', '🔴', '🟣', '💬', '❤️', '🏆', '🔑', '🎯', '📌', '💡', '🔔', '🎉', '🔥'],
  },
];

const ALL_EMOJIS = CATEGORIES.flatMap(c => c.emojis);

interface IconPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  onRemove?: () => void;
  anchorRect?: DOMRect | null;
}

export function IconPicker({ open, onClose, onSelect, onRemove, anchorRect }: IconPickerProps) {
  const [activeTab, setActiveTab] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (popoverRef.current && target && !popoverRef.current.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  let top = 120;
  let left = 40;
  if (anchorRect) {
    top = Math.min(window.innerHeight - 340, Math.max(10, anchorRect.bottom + 8));
    left = Math.min(window.innerWidth - 320, Math.max(10, anchorRect.left));
  }

  const handleRandom = () => {
    const randomEmoji = ALL_EMOJIS[Math.floor(Math.random() * ALL_EMOJIS.length)];
    onSelect(randomEmoji);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      className="icon-picker-popover"
      style={{
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        zIndex: 1000,
      }}
      role="dialog"
      aria-label="Select icon"
    >
      <div className="icon-picker-header">
        <div className="icon-picker-tabs">
          {CATEGORIES.map((cat, idx) => (
            <button
              key={cat.name}
              className={`icon-picker-tab ${activeTab === idx ? 'active' : ''}`}
              onClick={() => setActiveTab(idx)}
            >
              {cat.emojis[0]} {cat.name.split(' ')[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="icon-picker-grid">
        {CATEGORIES[activeTab].emojis.map((emoji) => (
          <button
            key={emoji}
            className="icon-picker-btn"
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
            title={emoji}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="icon-picker-footer">
        <button className="icon-picker-action-btn" onClick={handleRandom}>
          🎲 Random
        </button>
        {onRemove && (
          <button
            className="icon-picker-action-btn icon-picker-action-btn--remove"
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            Remove icon
          </button>
        )}
      </div>
    </div>
  );
}
