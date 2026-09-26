import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  // Renders as a divider line between groups.
  divider?: boolean;
  // Renders as a non-clickable section header (e.g. "Convert to:").
  // No onClick; shown as muted text, not a button.
  header?: boolean;
}

interface Props {
  // Viewport-space coordinates. Caller usually passes e.clientX/clientY from onContextMenu.
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

// Floating context menu. Closes on outside click, Escape, or item click.
// Repositions if it overflows the viewport.
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Close on Escape or outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // mousedown (not click) so this fires before any React onMouseDown handlers.
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  // After mount, reposition if we overflow the viewport. One tick so the
  // browser has measured the menu's size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (x + rect.width > vw - 8) nx = Math.max(8, vw - rect.width - 8);
    if (y + rect.height > vh - 8) ny = Math.max(8, vh - rect.height - 8);
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={`d-${i}`} className="context-menu-divider" role="separator" />;
        }
        if (item.header) {
          return <div key={`h-${i}`} className="context-menu-label" role="presentation">{item.label}</div>;
        }
        return (
          <button
            key={`${item.label}-${i}`}
            type="button"
            className={`context-menu-item${item.danger ? ' context-menu-item--danger' : ''}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}