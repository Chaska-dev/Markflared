import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useSidebar } from '../contexts/SidebarContext';
import { MenuIcon } from './Icons';
import { SearchModal } from './SearchModal';

export function Layout() {
  const { isMobile, mobileOpen, toggleMobile } = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="layout">
      <Sidebar onOpenSearch={() => setSearchOpen(true)} />
      <main className="main-content">
        {isMobile && !mobileOpen && (
          <button
            className="mobile-sidebar-toggle"
            onClick={toggleMobile}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <MenuIcon size={18} />
          </button>
        )}
        <Outlet />
      </main>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
