import React, { useRef, useEffect, useMemo, useCallback, memo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { usePageContext, buildPageTree } from '../contexts/PageContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { Page } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { useSidebar } from '../contexts/SidebarContext';
import { api } from '../api/client';
import {
  DownloadIcon,
  PlusIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  ChevronRightSmallIcon,
  XIcon,
  DocumentIcon,
  UserIcon,
  SearchIcon,
  MoreHorizontalIcon,
  SunIcon,
  MoonIcon,
} from './Icons';
import { useTheme } from '../contexts/ThemeContext';
import { Logo } from './Logo';
import { WorkspaceSettings } from './WorkspaceSettings';
import { UserMenuPopover } from './UserMenuPopover';
import { IconColorPickerModal } from './IconColorPickerModal';
import { ConfirmDialog } from './ConfirmDialog';
import {
  getRecentPages,
  getProjectIds,
  addProject,
  STORAGE_EVENTS,
  RecentPageItem,
} from '../utils/workspaceStorage';
import { useLanguage } from '../i18n/LanguageContext';
import { LanguageSwitcher } from './LanguageSwitcher';

function hasDescendant(page: Page, targetId?: string): boolean {
  if (!targetId || !page.children) return false;
  return page.children.some(c => c.id === targetId || hasDescendant(c, targetId));
}

// Build the cascade-count description for the delete confirm. Uses native JSX
// (not dangerouslySetInnerHTML) so a malicious page title can't inject HTML.
// Singular/plural handled with {one}|{other} keys to avoid a CLDR dependency.
function buildDeleteDescription(
  cascade: { pages: number; blocks: number },
  t: (k: string, vars?: Record<string, string | number>) => string
) {
  const subCount = Math.max(0, cascade.pages - 1);
  const blkCount = cascade.blocks;
  if (subCount > 0 && blkCount > 0) {
    return (
      <>
        <>{t('sidebar.deleteDesc.bothPrefix')} </>{' '}
        <strong>{subCount}</strong>{' '}
        {subCount === 1 ? t('sidebar.deleteDesc.sub_one') : t('sidebar.deleteDesc.sub_other')}
        {' '}{t('sidebar.deleteDesc.and')}{' '}
        <strong>{blkCount}</strong>{' '}
        {blkCount === 1 ? t('sidebar.deleteDesc.blk_one') : t('sidebar.deleteDesc.blk_other')}
        {t('sidebar.deleteDesc.dot')}
      </>
    );
  }
  if (subCount > 0 && blkCount === 0) {
    return (
      <>
        {t('sidebar.deleteDesc.subPrefix')} <strong>{subCount}</strong>{' '}
        {subCount === 1 ? t('sidebar.deleteDesc.nestedSub_one') : t('sidebar.deleteDesc.nestedSub_other')}
        {t('sidebar.deleteDesc.dot')}
      </>
    );
  }
  if (subCount === 0 && blkCount > 0) {
    return (
      <>
        {t('sidebar.deleteDesc.blkPrefix')} <strong>{blkCount}</strong>{' '}
        {blkCount === 1 ? t('sidebar.deleteDesc.fromBlk_one') : t('sidebar.deleteDesc.fromBlk_other')}
        {t('sidebar.deleteDesc.dot')}
      </>
    );
  }
  return <>{t('sidebar.deleteDesc.empty')}</>;
}

type PageTreeItemProps = {
  page: Page;
  level?: number;
  collapsed: boolean;
};

const PageTreeItem = memo(function PageTreeItem({ page, level = 0, collapsed }: PageTreeItemProps) {
  const { id: currentId } = useParams();
  const isParentOfActive = hasDescendant(page, currentId);
  const [manuallyExpanded, setManuallyExpanded] = React.useState<boolean | null>(null);
  const expanded = manuallyExpanded !== null ? manuallyExpanded : isParentOfActive;

  const navigate = useNavigate();
  const { deletePage, createPage, refreshPages } = usePageContext();
  const { t } = useLanguage();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cascade, setCascade] = useState<{ pages: number; blocks: number } | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isActive = currentId === page.id;
  const hasChildren = !!(page.children && page.children.length > 0);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/page/${page.id}`);
  }, [navigate, page.id]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setManuallyExpanded(prev => !(prev ?? expanded));
  }, [expanded]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
    setCascade(null);
    setCascadeLoading(true);
    api.pages.cascadeCount(page.id)
      .then((c) => setCascade(c))
      .catch(() => setCascade({ pages: 1, blocks: 0 }))
      .finally(() => setCascadeLoading(false));
  }, [page.id]);

  const handleConfirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deletePage(page.id);
      await refreshPages();
      if (currentId === page.id) {
        navigate('/');
      }
      setConfirmOpen(false);
    } catch (err) {
      console.error('Failed to delete page', err);
      setDeleting(false);
    }
  }, [deletePage, refreshPages, currentId, page.id, navigate]);

  const handleAddChild = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setManuallyExpanded(true);
    try {
      const newPage = await createPage(page.id);
      try {
        await api.blocks.create(page.id, {
          type: 'subpage',
          content: newPage.id,
          position: 999_999,
        });
      } catch (e) {
        console.error('Failed to insert inline subpage block', e);
      }
      await refreshPages();
      navigate(`/page/${newPage.id}`);
    } catch (e) {
      console.error('Failed to create subpage', e);
    }
  }, [createPage, navigate, page.id, refreshPages]);

  if (collapsed) {
    return (
      <div
        className={`page-item page-item--collapsed ${isActive ? 'active' : ''}`}
        onClick={handleClick}
        title={page.title || t('sidebar.untitledPage')}
        role="button"
        aria-label={`Open ${page.title || t('sidebar.untitledPage')}`}
      >
        <div className="page-item-icon">
          {page.icon || <DocumentIcon size={16} />}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        className={`page-item ${isActive ? 'active' : ''}`}
        onClick={handleClick}
      >
        <div
          className="toggle-btn"
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={handleToggle}
        >
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightSmallIcon size={12} />}
        </div>
        <div className="page-item-icon">
          {page.icon || <DocumentIcon size={16} />}
        </div>
        <div className="page-item-title">{page.title || t('sidebar.untitledPage')}</div>
        <div className="page-item-actions">
          <button className="icon-btn" onClick={handleAddChild} title={t('sidebar.addPageInside')} aria-label={t('sidebar.addPageInside')}>
            <PlusIcon size={16} />
          </button>
          <button className="icon-btn" onClick={handleDelete} title={t('sidebar.delete')} aria-label={t('sidebar.delete')}>
            <XIcon size={16} />
          </button>
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="page-children">
          {page.children!.map(child => (
            <PageTreeItem key={child.id} page={child} level={level + 1} collapsed={collapsed} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t('sidebar.confirmDeleteTitleWithTitle', { title: page.title || t('sidebar.untitledPage') })}
        description={
          cascadeLoading
            ? t('sidebar.deleteCalculating')
            : cascade
              ? <>{buildDeleteDescription(cascade, t)} <>{t('sidebar.deleteDesc.irreversible')}</></>
              : t('sidebar.deleteFallback')
        }
        confirmLabel={t('dialog.delete')}
        confirmTone="danger"
        loading={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => { if (!deleting) setConfirmOpen(false); }}
      />
    </div>
  );
});

export function Sidebar({ onOpenSearch }: { onOpenSearch?: () => void } = {}) {
  const { pages, createPage, updatePage, refreshPages } = usePageContext();
  const { workspace } = useWorkspace();
  const tree = useMemo(() => buildPageTree(pages), [pages]);
  const { username, logout } = useAuth();
  const {
    isMobile,
    isNarrow,
    mobileOpen,
    closeMobile,
    desktopCollapsed,
    toggleDesktopCollapsed,
  } = useSidebar();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceHeaderRef = useRef<HTMLDivElement | null>(null);
  const userAnchorRef = useRef<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { id: currentId } = useParams();
  const { theme, toggleTheme } = useTheme();

  // Local state for recents and projects (100% frontend).
  const [recentPages, setRecentPages] = useState<RecentPageItem[]>(() => getRecentPages());
  const [projectIds, setProjectIds] = useState<string[]>(() => getProjectIds());

  useEffect(() => {
    const updateRecents = () => setRecentPages(getRecentPages());
    const updateProjects = () => setProjectIds(getProjectIds());

    window.addEventListener(STORAGE_EVENTS.RECENTS_CHANGED, updateRecents);
    window.addEventListener(STORAGE_EVENTS.PROJECTS_CHANGED, updateProjects);

    return () => {
      window.removeEventListener(STORAGE_EVENTS.RECENTS_CHANGED, updateRecents);
      window.removeEventListener(STORAGE_EVENTS.PROJECTS_CHANGED, updateProjects);
    };
  }, []);

  // Filter out recents pointing to deleted pages.
  const validRecents = useMemo(() => {
    return recentPages.filter(r => pages.some(p => p.id === r.id)).slice(0, 5);
  }, [recentPages, pages]);

  // Split the tree into Projects and Private sections.
  const projectTree = useMemo(() => {
    return tree.filter(p => projectIds.includes(p.id));
  }, [tree, projectIds]);

  const privateTree = useMemo(() => {
    return tree.filter(p => !projectIds.includes(p.id));
  }, [tree, projectIds]);

  useEffect(() => {
    if (isMobile) closeMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
        console.error('Import error:', err);
        alert(`Error importing markdown file: ${err.message || 'Unknown error'}`);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [navigate, refreshPages]);

  // Create new project.
  const handleCreateProject = useCallback(async () => {
    try {
      const newPage = await createPage(null);
      addProject(newPage.id);
      await updatePage(newPage.id, { icon: '', title: 'New Project' });
      await refreshPages();
      navigate(`/page/${newPage.id}`);
    } catch (err) {
      console.error('Create project error:', err);
    }
  }, [createPage, updatePage, refreshPages, navigate]);

  // Create new private page.
  const handleCreatePrivatePage = useCallback(async () => {
    try {
      const newPage = await createPage(null);
      await refreshPages();
      navigate(`/page/${newPage.id}`);
    } catch (err) {
      console.error('Create page error:', err);
    }
  }, [createPage, refreshPages, navigate]);

  const isOverlayOpen = (isMobile && mobileOpen) || (!isMobile && isNarrow && !desktopCollapsed);
  const collapsed = !isMobile && desktopCollapsed;

  const sidebarClass = [
    'sidebar',
    isMobile ? 'sidebar--mobile' : 'sidebar--desktop',
    isNarrow && !isMobile ? 'sidebar--narrow' : '',
    isOverlayOpen ? 'sidebar--mobile-open' : '',
    collapsed ? 'sidebar--collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      {isOverlayOpen && (
        <div className="sidebar-overlay" onClick={isMobile ? closeMobile : toggleDesktopCollapsed} aria-hidden="true" />
      )}
      <aside className={sidebarClass} aria-hidden={isOverlayOpen ? false : (isMobile ? !mobileOpen : false)}>
        <div className="sidebar-header">
          {!collapsed && (
            <div className="workspace-name workspace-name--brand">
              {workspace.icon ? (
                <span className="workspace-icon-emoji">{workspace.icon}</span>
              ) : (
                <Logo size={20} variant="icon" />
              )}
              <div className="workspace-brand-text">
                <span className="brand-mark">mark</span>
                <span className="brand-flare">flare</span>
              </div>
            </div>
          )}

          <div className="sidebar-actions">
            {!collapsed && (
              <>
                <input
                  type="file"
                  accept=".md"
                  style={{ display: 'none' }}
                  ref={fileInputRef}
                  onChange={handleImport}
                />
                <button
                  className="sidebar-btn"
                  onClick={() => fileInputRef.current?.click()}
                  title={t('sidebar.import')}
                  aria-label={t('sidebar.import')}
                >
                  <DownloadIcon size={16} />
                </button>
                <button
                  className="sidebar-btn"
                  onClick={handleCreatePrivatePage}
                  title={t('sidebar.newPage')}
                  aria-label={t('sidebar.newPage')}
                >
                  <PlusIcon size={16} />
                </button>
                <button
                  className="sidebar-btn"
                  onClick={onOpenSearch}
                  title={`${t('sidebar.search')} (Ctrl+K)`}
                  aria-label={`${t('sidebar.search')} (Ctrl+K)`}
                >
                  <SearchIcon size={16} />
                </button>
              </>
            )}

            <button
              className="sidebar-btn sidebar-btn--toggle"
              onClick={() => isMobile ? closeMobile() : toggleDesktopCollapsed()}
              title={
                isMobile
                  ? t('sidebar.closeSidebar')
                  : (isNarrow && !desktopCollapsed)
                    ? t('sidebar.closeSidebar') + ' (Ctrl+B)'
                    : (desktopCollapsed
                      ? t('sidebar.openSidebar') + ' (Ctrl+B)'
                      : t('sidebar.closeSidebar') + ' (Ctrl+B)')
              }
              aria-label={
                isMobile
                  ? t('sidebar.closeSidebar')
                  : (isNarrow && !desktopCollapsed)
                    ? t('sidebar.closeSidebar')
                    : (desktopCollapsed ? t('sidebar.openSidebar') : t('sidebar.closeSidebar'))
              }
            >
              {(isMobile || (isNarrow && !desktopCollapsed))
                ? <XIcon size={16} />
                : desktopCollapsed
                  ? <Logo size={18} variant="icon" />
                  : <ChevronLeftIcon size={16} />}
            </button>
          </div>
        </div>

        {/* Global search with quick Ctrl+K access */}
        {!collapsed && (
          <div
            className="sidebar-search-row"
            onClick={onOpenSearch}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenSearch?.();
              }
            }}
            title={t('sidebar.searchTooltip')}
          >
            <SearchIcon size={14} />
            <span>{t('sidebar.searchPlaceholder')}</span>
            <kbd className="sidebar-kbd">Ctrl K</kbd>
          </div>
        )}

        {/* Structured list: Recents, Projects, Private */}
        <div className="page-list">
          {/* SECTION 1: RECENTS */}
          {!collapsed && validRecents.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span className="sidebar-section-title">{t('sidebar.recents')}</span>
              </div>
              <div className="sidebar-recents-list">
                {validRecents.map((item) => {
                  const isItemActive = currentId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`sidebar-recent-item ${isItemActive ? 'active' : ''}`}
                      onClick={() => navigate(`/page/${item.id}`)}
                      role="button"
                      title={item.title}
                    >
                      {item.icon && <span className="sidebar-recent-icon">{item.icon}</span>}
                      <span className="sidebar-recent-title">{item.title}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 2: PROJECTS */}
          {!collapsed && (
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span className="sidebar-section-title">{t('sidebar.projects')}</span>
                <button
                  className="sidebar-section-add-btn"
                  onClick={handleCreateProject}
                  title={t('sidebar.newProject')}
                  aria-label={t('sidebar.newProject')}
                >
                  <PlusIcon size={16} />
                </button>
              </div>

              {projectTree.length === 0 ? (
                <div className="sidebar-empty-hint" onClick={handleCreateProject}>
                  <PlusIcon size={16} />
                  <span>{t('sidebar.addProject')}</span>
                </div>
              ) : (
                <div className="sidebar-tree-group">
                  {projectTree.map((page) => (
                    <PageTreeItem key={page.id} page={page} collapsed={collapsed} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* SECTION 3: PRIVATE */}
          {!collapsed && (
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span className="sidebar-section-title">{t('sidebar.private')}</span>
                <button
                  className="sidebar-section-add-btn"
                  onClick={handleCreatePrivatePage}
                  title={t('sidebar.newPrivatePage')}
                  aria-label={t('sidebar.newPrivatePage')}
                >
                  <PlusIcon size={16} />
                </button>
              </div>

              {privateTree.length === 0 ? (
                <div className="sidebar-empty-hint" onClick={handleCreatePrivatePage}>
                  <PlusIcon size={16} />
                  <span>{t('sidebar.addPrivate')}</span>
                </div>
              ) : (
                <div className="sidebar-tree-group">
                  {privateTree.map((page) => (
                    <PageTreeItem key={page.id} page={page} collapsed={collapsed} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Collapsed (icon-only) view */}
          {collapsed && (
            <div className="sidebar-collapsed-tree">
              {tree.map((page) => (
                <PageTreeItem key={page.id} page={page} collapsed={collapsed} />
              ))}
            </div>
          )}
        </div>

        {/* Footer: Profile + Theme toggle */}
        {!collapsed && (
          <div className="sidebar-footer">
            <div
              ref={userAnchorRef}
              className={`sidebar-user sidebar-user--clickable ${userMenuOpen ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setUserMenuOpen(prev => !prev);
              }}
              role="button"
              tabIndex={0}
              title={t('userMenu.title')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setUserMenuOpen(prev => !prev);
                }
              }}
            >
              <div className="sidebar-user-avatar">
                <UserIcon size={14} />
              </div>
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{username}</span>
                <span className="sidebar-user-role">{username === 'admin' ? t('sidebar.adminRole') : t('sidebar.userRole')}</span>
              </div>
              <MoreHorizontalIcon size={14} className="sidebar-user-more" />
            </div>

            <UserMenuPopover
              open={userMenuOpen}
              onClose={() => setUserMenuOpen(false)}
              onOpenWorkspaceSettings={() => {
                setSettingsAnchor(userAnchorRef.current?.getBoundingClientRect() ?? null);
                setSettingsOpen(true);
              }}
              onOpenColorPicker={() => {
                setColorPickerOpen(true);
              }}
            />

            <div className="sidebar-footer-actions">
              <LanguageSwitcher />
              <button
                className="sidebar-theme-btn"
                onClick={toggleTheme}
                title={theme === 'dark' ? t('sidebar.themeLight') : t('sidebar.themeDark')}
                aria-label={theme === 'dark' ? t('sidebar.themeLight') : t('sidebar.themeDark')}
              >
                {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
              </button>
            </div>
          </div>
        )}

        {collapsed && (
          <div className="sidebar-footer sidebar-footer--collapsed">
            <button
              className="sidebar-btn sidebar-btn--user"
              onClick={() => setUserMenuOpen(prev => !prev)}
              title={username || 'User'}
              aria-label={username || 'User'}
            >
              <UserIcon size={16} />
            </button>
            <UserMenuPopover
              open={userMenuOpen}
              onClose={() => setUserMenuOpen(false)}
              onOpenWorkspaceSettings={() => {
                setSettingsAnchor(null);
                setSettingsOpen(true);
              }}
              onOpenColorPicker={() => {
                setColorPickerOpen(true);
              }}
            />
            <LanguageSwitcher />
            <button
              className="sidebar-btn sidebar-btn--theme"
              onClick={toggleTheme}
              title={theme === 'dark' ? t('sidebar.themeLight') : t('sidebar.themeDark')}
              aria-label={theme === 'dark' ? t('sidebar.themeLight') : t('sidebar.themeDark')}
            >
              {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            </button>
          </div>
        )}
      </aside>

      <WorkspaceSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        anchorRect={settingsAnchor}
      />

      <IconColorPickerModal
        open={colorPickerOpen}
        onClose={() => setColorPickerOpen(false)}
      />
    </>
  );
}