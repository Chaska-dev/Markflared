import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Page } from '../types';
import {
  XIcon,
  UploadIcon,
  NotebookIcon,
  DocumentIcon,
  ChevronRightIcon,
  CheckIcon,
  LoaderIcon,
} from './Icons';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported?: (pageId: string) => void;
}

// "root" = workspace root (parent_id = null). Any other string = the
// page id under which the new page should be nested.
type ParentChoice = 'root' | string;

type Step = 'pick' | 'choose-parent';

export function ImportModal({ open, onClose, onImported }: Props) {
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [parentChoice, setParentChoice] = useState<ParentChoice>('root');
  const [parentFilter, setParentFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  // Pages live in a global context; we read them lazily when the user
  // gets to the parent-picker step so the modal doesn't churn on open.
  const [pages, setPages] = useState<Page[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);

  // Reset whenever the modal closes (or opens) so a second import starts
  // fresh.
  useEffect(() => {
    if (!open) {
      // Defer so the close animation doesn't flash old content.
      const id = window.setTimeout(() => {
        setStep('pick');
        setFile(null);
        setFileContent('');
        setParentChoice('root');
        setParentFilter('');
        setImportError(null);
        setIsDragging(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }, 120);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Lazy-load pages when the user reaches step 2. We avoid loading them
  // on initial open because most users won't go past step 1, and the
  // GET /pages call is non-trivial.
  useEffect(() => {
    if (!open || step !== 'choose-parent' || pages.length > 0) return;
    let cancelled = false;
    setPagesLoading(true);
    api.pages
      .list()
      .then((res) => {
        if (!cancelled) setPages(res.pages || []);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load pages for parent picker', err);
          setImportError(t('importModal.errorLoadPages'));
        }
      })
      .finally(() => {
        if (!cancelled) setPagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, step, pages.length, t]);

  // Escape closes (unless we're mid-import).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, importing, onClose]);

  // ---- File handling -------------------------------------------------

  const acceptFile = useCallback((f: File) => {
    setImportError(null);
    setFile(f);
    // Reject obviously-wrong types. We trust text/markdown + .md; for
    // unknown mime types we still try to read as text — markdown is
    // often exported as text/plain by browsers.
    const looksLikeMd =
      /\.md$/i.test(f.name) ||
      /markdown/i.test(f.type) ||
      f.type === '' ||
      f.type.startsWith('text/');
    if (!looksLikeMd) {
      setImportError(t('importModal.errorNotMarkdown'));
      setFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = (ev.target?.result as string) ?? '';
      setFileContent(content);
      setStep('choose-parent');
    };
    reader.onerror = () => {
      setImportError(t('importModal.errorReadFile'));
      setFile(null);
    };
    reader.readAsText(f);
  }, [t]);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    // Always clear so selecting the same file twice still fires change.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [acceptFile]);

  // Drag-and-drop on the modal: we listen on the whole backdrop so the
  // user can drop anywhere on the modal. We always preventDefault on
  // file drags to keep the browser from navigating to the file when
  // the user accidentally releases over the modal in step 2.
  const onDrop = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types || []);
    // Ignore non-file drags (the existing PageTreeItem system uses
    // text/plain + a custom mime — see Sidebar.tsx).
    if (!types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (step !== 'pick' || importing) return;
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  }, [acceptFile, step, importing]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes('Files')) return;
    // preventDefault is required for the drop event to fire AND to keep
    // the browser from navigating to the file when the user accidentally
    // releases over the modal area.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (step === 'pick' && !importing && !isDragging) setIsDragging(true);
  }, [step, importing, isDragging]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the cursor leaves the modal entirely. relatedTarget
    // is the element being entered; if it's still inside, ignore.
    const related = e.relatedTarget as Node | null;
    if (related && modalRef.current && modalRef.current.contains(related)) return;
    setIsDragging(false);
  }, []);

  // ---- Page tree flattening for parent picker ------------------------

  const flatPages = useMemo(() => {
    const out: { page: Page; depth: number }[] = [];
    const visit = (nodes: Page[], depth: number) => {
      // Sort by position so the picker matches sidebar order.
      const sorted = [...nodes].sort((a, b) => a.position - b.position);
      for (const p of sorted) {
        out.push({ page: p, depth });
        if (p.children && p.children.length > 0) visit(p.children, depth + 1);
      }
    };
    // buildPageTree is what the sidebar uses — it gives us children
    // attached. If we got pages without children (the flat list from
    // /pages does), we need to nest them ourselves.
    const hasNested = pages.some((p) => Array.isArray(p.children));
    if (hasNested) {
      visit(pages as unknown as Page[], 0);
    } else {
      // Build a parent_id-keyed map and nest in-place.
      const map = new Map<string, Page>();
      pages.forEach((p) => map.set(p.id, { ...p, children: [] }));
      const roots: Page[] = [];
      pages.forEach((p) => {
        const node = map.get(p.id)!;
        if (p.parent_id && map.has(p.parent_id)) {
          const parent = map.get(p.parent_id)!;
          parent.children = parent.children || [];
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      });
      visit(roots, 0);
    }
    return out;
  }, [pages]);

  const filteredFlatPages = useMemo(() => {
    const q = parentFilter.trim().toLowerCase();
    if (!q) return flatPages;
    // Include every page whose title matches OR is an ancestor of a
    // matching page (so the user can still see context).
    const matchingIds = new Set<string>();
    flatPages.forEach(({ page }) => {
      if (page.title.toLowerCase().includes(q)) matchingIds.add(page.id);
    });
    if (matchingIds.size === 0) return [];
    // Walk parents of every match.
    const pageById = new Map(pages.map((p) => [p.id, p]));
    const includeAnchestors = (id: string) => {
      let cur = pageById.get(id);
      while (cur && cur.parent_id) {
        if (matchingIds.has(cur.parent_id)) {
          // parent's already a match, no need to keep walking
          break;
        }
        matchingIds.add(cur.parent_id);
        cur = pageById.get(cur.parent_id);
      }
    };
    matchingIds.forEach(includeAnchestors);
    return flatPages.filter(({ page }) => matchingIds.has(page.id));
  }, [flatPages, parentFilter, pages]);

  // ---- Import --------------------------------------------------------

  const handleImport = useCallback(async () => {
    if (!file || importing) return;
    setImporting(true);
    setImportError(null);
    const title = file.name.replace(/\.md$/i, '');
    try {
      const res = await api.pages.import({
        markdown: fileContent,
        title,
        parent_id: parentChoice === 'root' ? null : parentChoice,
      });
      await Promise.resolve();
      onImported?.(res.page.id);
      onClose();
      navigate(`/page/${res.page.id}`);
    } catch (err: any) {
      console.error('Import error:', err);
      setImportError(err?.message || t('importModal.errorGeneric'));
    } finally {
      setImporting(false);
    }
  }, [file, fileContent, parentChoice, importing, navigate, onClose, onImported, t]);

  if (!open) return null;

  const fileSize = file
    ? file.size < 1024
      ? `${file.size} B`
      : file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(2)} MB`
    : '';

  return createPortal(
    <div
      className="import-modal-backdrop"
      onMouseDown={(e) => {
        // Click on backdrop closes (unless we're importing).
        if (e.target === e.currentTarget && !importing) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <header className="import-modal-header">
          <div className="import-modal-title-wrap">
            <UploadIcon size={18} />
            <h2 id="import-modal-title" className="import-modal-title">
              {t('importModal.title')}
            </h2>
          </div>
          <button
            type="button"
            className="import-modal-close-btn"
            onClick={() => { if (!importing) onClose(); }}
            aria-label={t('importModal.close')}
            disabled={importing}
          >
            <XIcon size={16} />
          </button>
        </header>

        <p className="import-modal-subtitle">{t('importModal.subtitle')}</p>

        {step === 'pick' && (
          <div
            className={`import-dropzone ${isDragging ? 'import-dropzone--active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
          >
            <div className="import-dropzone-icon">
              <NotebookIcon size={48} />
            </div>
            <div className="import-dropzone-headline">
              {isDragging ? t('importModal.dropNow') : t('importModal.dropHere')}
            </div>
            <div className="import-dropzone-hint">
              {t('importModal.or')}{' '}
              <span className="import-dropzone-link">{t('importModal.browse')}</span>
            </div>
            <div className="import-dropzone-ext">{t('importModal.acceptsExt')}</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              style={{ display: 'none' }}
              onChange={onFileInputChange}
            />
          </div>
        )}

        {step === 'choose-parent' && (
          <div className="import-step2">
            <div className="import-file-chip">
              <NotebookIcon size={16} />
              <span className="import-file-chip-name">{file?.name}</span>
              <span className="import-file-chip-size">{fileSize}</span>
              <button
                type="button"
                className="import-file-chip-reset"
                onClick={() => {
                  setFile(null);
                  setFileContent('');
                  setStep('pick');
                  setParentChoice('root');
                  setImportError(null);
                }}
                disabled={importing}
                title={t('importModal.changeFile')}
                aria-label={t('importModal.changeFile')}
              >
                <XIcon size={12} />
              </button>
            </div>

            <div className="import-parent-question">{t('importModal.whereQuestion')}</div>

            <div className="import-parent-options">
              <label
                className={`import-parent-option ${parentChoice === 'root' ? 'import-parent-option--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="import-parent"
                  value="root"
                  checked={parentChoice === 'root'}
                  onChange={() => setParentChoice('root')}
                  disabled={importing}
                />
                <span className="import-parent-radio" aria-hidden="true" />
                <span className="import-parent-option-text">
                  <span className="import-parent-option-title">{t('importModal.parentRoot')}</span>
                  <span className="import-parent-option-desc">{t('importModal.parentRootDesc')}</span>
                </span>
              </label>

              <div className="import-parent-nested-label">{t('importModal.parentNested')}</div>

              <div className="import-parent-search">
                <input
                  type="text"
                  value={parentFilter}
                  onChange={(e) => setParentFilter(e.target.value)}
                  placeholder={t('importModal.parentSearchPlaceholder')}
                  className="import-parent-search-input"
                  disabled={importing || pagesLoading}
                />
              </div>

              <div className="import-parent-tree">
                {pagesLoading ? (
                  <div className="import-parent-loading">
                    <LoaderIcon size={16} />
                    <span>{t('importModal.loadingPages')}</span>
                  </div>
                ) : filteredFlatPages.length === 0 ? (
                  <div className="import-parent-empty">
                    {parentFilter.trim()
                      ? t('importModal.noMatches', { query: parentFilter })
                      : t('importModal.noPages')}
                  </div>
                ) : (
                  filteredFlatPages.map(({ page, depth }) => {
                    const selected = parentChoice === page.id;
                    return (
                      <label
                        key={page.id}
                        className={`import-parent-row ${selected ? 'import-parent-row--selected' : ''}`}
                        style={{ paddingLeft: `${10 + depth * 18}px` }}
                      >
                        <input
                          type="radio"
                          name="import-parent"
                          value={page.id}
                          checked={selected}
                          onChange={() => setParentChoice(page.id)}
                          disabled={importing}
                          className="import-parent-row-input"
                        />
                        <span className="import-parent-row-icon" aria-hidden="true">
                          {page.icon ? <span className="import-parent-row-emoji">{page.icon}</span> : <DocumentIcon size={14} />}
                        </span>
                        <span className="import-parent-row-title">
                          {page.title || t('sidebar.untitledPage')}
                        </span>
                        {depth > 0 && (
                          <span className="import-parent-row-guide" aria-hidden="true">
                            <ChevronRightIcon size={10} />
                          </span>
                        )}
                        {selected && (
                          <span className="import-parent-row-check" aria-hidden="true">
                            <CheckIcon size={12} />
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {importError && (
          <div className="import-error" role="alert">{importError}</div>
        )}

        <footer className="import-modal-footer">
          <button
            type="button"
            className="import-btn import-btn--cancel"
            onClick={onClose}
            disabled={importing}
          >
            {t('importModal.cancel')}
          </button>
          {step === 'choose-parent' && (
            <button
              type="button"
              className="import-btn import-btn--primary"
              onClick={handleImport}
              disabled={importing || !file}
            >
              {importing ? (
                <>
                  <LoaderIcon size={14} />
                  <span>{t('importModal.importing')}</span>
                </>
              ) : (
                <>
                  <UploadIcon size={14} />
                  <span>{t('importModal.import')}</span>
                </>
              )}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}