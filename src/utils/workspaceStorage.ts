// Local storage utilities for Markflare (100% frontend). Keeps changes out
// of the backend so we don't drift from the git repo.

export interface RecentPageItem {
  id: string;
  title: string;
  icon?: string;
  timestamp: number;
}

const STORAGE_KEYS = {
  RECENTS: 'markflare_recents',
  PROJECTS: 'markflare_projects',
  COVERS: 'markflare_covers',
};

// Custom events for cross-component reactivity.
export const STORAGE_EVENTS = {
  RECENTS_CHANGED: 'markflare:recents_changed',
  PROJECTS_CHANGED: 'markflare:projects_changed',
  COVERS_CHANGED: 'markflare:covers_changed',
};

function dispatchChange(eventName: string) {
  window.dispatchEvent(new Event(eventName));
}

// Recents

export function getRecentPages(): RecentPageItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RECENTS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('Read recents error:', e);
    return [];
  }
}

export function addRecentPage(page: { id: string; title: string; icon?: string }) {
  if (!page.id) return;
  try {
    const current = getRecentPages();
    // Filter existing entries to put the new one on top.
    const filtered = current.filter(item => item.id !== page.id);
    const updated: RecentPageItem[] = [
      {
        id: page.id,
        title: page.title || 'Untitled',
        icon: page.icon || '',
        timestamp: Date.now(),
      },
      ...filtered,
    ].slice(0, 8); // keep up to 8 recent pages

    localStorage.setItem(STORAGE_KEYS.RECENTS, JSON.stringify(updated));
    dispatchChange(STORAGE_EVENTS.RECENTS_CHANGED);
  } catch (e) {
    console.error('Save recent error:', e);
  }
}

export function removeRecentPage(id: string) {
  try {
    const current = getRecentPages();
    const updated = current.filter(item => item.id !== id);
    localStorage.setItem(STORAGE_KEYS.RECENTS, JSON.stringify(updated));
    dispatchChange(STORAGE_EVENTS.RECENTS_CHANGED);
  } catch (e) {
    console.error('Remove recent error:', e);
  }
}

export function clearRecentPages() {
  try {
    localStorage.removeItem(STORAGE_KEYS.RECENTS);
    dispatchChange(STORAGE_EVENTS.RECENTS_CHANGED);
  } catch (e) {
    console.error('Clear recents error:', e);
  }
}

// Projects

export function getProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('Read projects error:', e);
    return [];
  }
}

export function isProject(pageId: string): boolean {
  if (!pageId) return false;
  const ids = getProjectIds();
  return ids.includes(pageId);
}

export function addProject(pageId: string) {
  if (!pageId) return;
  try {
    const ids = getProjectIds();
    if (!ids.includes(pageId)) {
      ids.push(pageId);
      localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(ids));
      dispatchChange(STORAGE_EVENTS.PROJECTS_CHANGED);
    }
  } catch (e) {
    console.error('Add project error:', e);
  }
}

export function removeProject(pageId: string) {
  if (!pageId) return;
  try {
    const ids = getProjectIds().filter(id => id !== pageId);
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(ids));
    dispatchChange(STORAGE_EVENTS.PROJECTS_CHANGED);
  } catch (e) {
    console.error('Remove project error:', e);
  }
}

export function toggleProject(pageId: string): boolean {
  if (!pageId) return false;
  if (isProject(pageId)) {
    removeProject(pageId);
    return false;
  } else {
    addProject(pageId);
    return true;
  }
}

// Covers

export function getAllPageCovers(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.COVERS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    console.error('Read covers error:', e);
    return {};
  }
}

export function getPageCover(pageId: string): string | null {
  if (!pageId) return null;
  const covers = getAllPageCovers();
  return covers[pageId] || null;
}

export function setPageCover(pageId: string, cover: string | null) {
  if (!pageId) return;
  try {
    const covers = getAllPageCovers();
    if (cover) {
      covers[pageId] = cover;
    } else {
      delete covers[pageId];
    }
    localStorage.setItem(STORAGE_KEYS.COVERS, JSON.stringify(covers));
    dispatchChange(STORAGE_EVENTS.COVERS_CHANGED);
  } catch (e) {
    console.error('Save cover error:', e);
  }
}
