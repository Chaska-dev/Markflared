import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { PageWithBlocks } from '../types';
import { usePageContext } from '../contexts/PageContext';
import { BlockEditor } from './BlockEditor';
import { PlusIcon, ShareIcon, UploadIcon } from './Icons';
import { SharePopover } from './SharePopover';
import { CoverBanner } from './CoverBanner';
import { IconPicker } from './IconPicker';
import { DocumentOutline } from './DocumentOutline';
import {
  addRecentPage,
  getPageCover,
  setPageCover,
  isProject,
  toggleProject,
  STORAGE_EVENTS,
} from '../utils/workspaceStorage';
import { useLanguage } from '../i18n/LanguageContext';

export function PageView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [page, setPage] = useState<PageWithBlocks | null>(null);
  const [loading, setLoading] = useState(true);
  const { createPage, updatePage, setCurrentPageId, getPageBreadcrumbs, refreshPages } = usePageContext();

  const [shareOpen, setShareOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const [shareAnchor, setShareAnchor] = useState<DOMRect | null>(null);

  const [cover, setCover] = useState<string | null>(null);
  const [isProj, setIsProj] = useState<boolean>(false);

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement | null>(null);
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!id) return;

    let active = true;
    setCurrentPageId(id);
    setLoading(true);

    setCover(getPageCover(id));
    setIsProj(isProject(id));

    api.pages.get(id).then(res => {
      if (active) {
        setPage(res.page);
        setLoading(false);
        addRecentPage({
          id: res.page.id,
          title: res.page.title,
          icon: res.page.icon,
        });
      }
    }).catch(err => {
      console.error(err);
      if (active) {
        setPage(null);
        setLoading(false);
      }
    });

    return () => { active = false; };
  }, [id, setCurrentPageId]);

  useEffect(() => {
    if (!id) return;
    const handleCoverChange = () => setCover(getPageCover(id));
    const handleProjectChange = () => setIsProj(isProject(id));

    window.addEventListener(STORAGE_EVENTS.COVERS_CHANGED, handleCoverChange);
    window.addEventListener(STORAGE_EVENTS.PROJECTS_CHANGED, handleProjectChange);

    return () => {
      window.removeEventListener(STORAGE_EVENTS.COVERS_CHANGED, handleCoverChange);
      window.removeEventListener(STORAGE_EVENTS.PROJECTS_CHANGED, handleProjectChange);
    };
  }, [id]);

  if (loading) {
    return <div className="loading"><div className="spinner"></div></div>;
  }

  if (!page || !id) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">❌</div>
        <div className="empty-state-text">Page not found</div>
      </div>
    );
  }

  // Cover banner belongs exclusively to the project root page.
  // Subpages (parent_id !== null) and regular private notes do not get a banner.
  const isProjectRoot = isProj && !page.parent_id;
  const hasCover = isProjectRoot && Boolean(cover);

  const breadcrumbs = getPageBreadcrumbs(id);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPage({ ...page, title: e.target.value });
  };

  const handleTitleBlur = () => {
    updatePage(id, { title: page.title });
    addRecentPage({ id, title: page.title, icon: page.icon });
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updatePage(id, { title: page.title });
      addRecentPage({ id, title: page.title, icon: page.icon });
    }
  };

  const handleSelectIcon = (emoji: string) => {
    setPage({ ...page, icon: emoji });
    updatePage(id, { icon: emoji });
    addRecentPage({ id, title: page.title, icon: emoji });
  };

  const handleRemoveIcon = () => {
    setPage({ ...page, icon: '' });
    updatePage(id, { icon: '' });
    addRecentPage({ id, title: page.title, icon: '' });
  };

  const handleOpenIconPicker = () => {
    if (iconBtnRef.current) {
      setIconAnchor(iconBtnRef.current.getBoundingClientRect());
    }
    setIconPickerOpen(true);
  };

  const handleSetCover = (newCover: string | null) => {
    setPageCover(id, newCover);
    setCover(newCover);
  };

  const handleToggleProject = () => {
    const nextStatus = toggleProject(id);
    setIsProj(nextStatus);
  };

  const handleExport = async () => {
    try {
      const res = await api.pages.export(id);
      const blob = new Blob([res.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${res.title || 'export'}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed', e);
    }
  };

  const handleCreateSubpage = async () => {
    try {
      const newPage = await createPage(id);
      await refreshPages();
      try {
        await api.blocks.create(id, {
          type: 'subpage',
          content: newPage.id,
          position: 999_999,
        });
      } catch (e) {
        console.error('Failed to insert inline subpage block', e);
      }
      navigate(`/page/${newPage.id}`);
    } catch (err) {
      console.error('Error creating subpage', err);
    }
  };

  return (
    <div className={`page-view ${hasCover ? 'page-view--has-cover' : ''}`}>
      {isProjectRoot && (
        <CoverBanner
          cover={cover}
          onSetCover={handleSetCover}
        />
      )}

      <div className="page-main-header">
        {breadcrumbs.length > 1 && (
          <div className="page-breadcrumbs">
            {breadcrumbs.map((b, idx) => (
              <React.Fragment key={b.id}>
                {idx > 0 && <span className="breadcrumb-separator">/</span>}
                <span
                  className={`breadcrumb-link ${b.id === id ? 'active' : ''}`}
                  onClick={() => b.id !== id && navigate(`/page/${b.id}`)}
                >
                  {b.icon && <span className="breadcrumb-icon">{b.icon}</span>}
                  <span>{b.title || t('page.titlePlaceholder')}</span>
                </span>
              </React.Fragment>
            ))}
          </div>
        )}

        <div className="page-actions">
          {!page.parent_id && (
            <button
              className={`page-action-btn ${isProj ? 'page-action-btn--project-active' : ''}`}
              onClick={handleToggleProject}
              title={isProj ? t('page.projectTooltipActive') : t('page.projectTooltipInactive')}
            >
              <span>{isProj ? t('page.projectBadge') : t('page.moveToProjects')}</span>
            </button>
          )}

          <button className="page-action-btn" onClick={handleExport} title={t('page.export')}>
            <UploadIcon size={14} />
            <span>{t('page.export')}</span>
          </button>
          <button className="page-action-btn" onClick={handleCreateSubpage} title={t('page.newSubpage')}>
            <PlusIcon size={14} />
            <span>{t('page.newSubpage')}</span>
          </button>
          <button
            ref={shareBtnRef}
            className="page-action-btn"
            onClick={() => {
              if (shareBtnRef.current) setShareAnchor(shareBtnRef.current.getBoundingClientRect());
              setShareOpen((v) => !v);
            }}
            aria-label={t('page.share')}
            aria-expanded={shareOpen}
          >
            <ShareIcon size={14} />
            <span>{t('share.title')}</span>
          </button>
        </div>
      </div>

      <SharePopover
        pageId={id}
        pageTitle={page.title}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        anchorRect={shareAnchor}
      />

      <div className={`page-header ${hasCover ? 'page-header--with-cover' : ''}`}>
        {page.icon && (
          <button
            ref={iconBtnRef}
            className={`page-icon-btn ${hasCover ? 'page-icon-btn--cover-overlap' : ''}`}
            onClick={handleOpenIconPicker}
            title="Change or remove icon"
          >
            {page.icon}
          </button>
        )}

        {page.icon && (
          <IconPicker
            open={iconPickerOpen}
            onClose={() => setIconPickerOpen(false)}
            onSelect={handleSelectIcon}
            onRemove={handleRemoveIcon}
            anchorRect={iconAnchor}
          />
        )}

        <input
          type="text"
          className="page-title"
          placeholder={t('page.titlePlaceholder')}
          value={page.title}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
        />
      </div>

      <BlockEditor
        pageId={id}
        initialBlocks={page.blocks || []}
      />

      <DocumentOutline blocks={page.blocks || []} />
    </div>
  );
}