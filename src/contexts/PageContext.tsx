import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Page } from '../types';
import { api } from '../api/client';
import { useNavigate } from 'react-router-dom';

export interface PageContextType {
  pages: Page[];
  loading: boolean;
  currentPageId: string | null;
  setCurrentPageId: (id: string | null) => void;
  createPage: (parentId?: string | null) => Promise<Page>;
  updatePage: (id: string, data: Partial<Page>) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  refreshPages: () => Promise<void>;
  getPageBreadcrumbs: (id: string) => Page[];
}

const PageContext = createContext<PageContextType | undefined>(undefined);

export function buildPageTree(pages: Page[]): Page[] {
  const pageMap = new Map<string, Page>();
  const rootPages: Page[] = [];

  pages.forEach(p => {
    pageMap.set(p.id, { ...p, children: [] });
  });

  pages.forEach(p => {
    const pageWithChildren = pageMap.get(p.id)!;
    if (p.parent_id && pageMap.has(p.parent_id)) {
      const parent = pageMap.get(p.parent_id)!;
      parent.children = parent.children || [];
      parent.children.push(pageWithChildren);
      parent.children.sort((a, b) => a.position - b.position);
    } else {
      rootPages.push(pageWithChildren);
    }
  });

  rootPages.sort((a, b) => a.position - b.position);
  return rootPages;
}

export function PageProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const navigate = useNavigate();

  const refreshPages = async () => {
    try {
      const res = await api.pages.list();
      setPages(res.pages);
    } catch (e) {
      console.error('Failed to load pages', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshPages();
  }, []);

  const createPage = async (parentId?: string | null) => {
    const res = await api.pages.create({ parent_id: parentId });
    setPages(prev => [...prev, res.page]);
    navigate(`/page/${res.page.id}`);
    return res.page;
  };

  const updatePage = async (id: string, data: Partial<Page>) => {
    const res = await api.pages.update(id, data);
    setPages(prev => prev.map(p => p.id === id ? res.page : p));
  };

  const deletePage = async (id: string) => {
    await api.pages.delete(id);
    setPages(prev => {
      const newPages = prev.filter(p => p.id !== id);
      return newPages;
    });
    
    if (currentPageId === id) {
      const remainingPages = pages.filter(p => p.id !== id);
      if (remainingPages.length > 0) {
        navigate(`/page/${remainingPages[0].id}`);
      } else {
        navigate('/');
      }
    }
  };

  const getPageBreadcrumbs = (id: string): Page[] => {
    const breadcrumbs: Page[] = [];
    let current = pages.find(p => p.id === id);
    while (current) {
      breadcrumbs.unshift(current);
      if (current.parent_id) {
        current = pages.find(p => p.id === current?.parent_id);
      } else {
        break;
      }
    }
    return breadcrumbs;
  };

  return (
    <PageContext.Provider value={{
      pages,
      loading,
      currentPageId,
      setCurrentPageId,
      createPage,
      updatePage,
      deletePage,
      refreshPages,
      getPageBreadcrumbs
    }}>
      {children}
    </PageContext.Provider>
  );
}

export function usePageContext() {
  const ctx = useContext(PageContext);
  if (!ctx) throw new Error('usePageContext must be used within PageProvider');
  return ctx;
}
