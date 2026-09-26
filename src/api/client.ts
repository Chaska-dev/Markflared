import type { Page, PageWithBlocks, Block, FileInfo, SearchResult } from '../types';

export class ApiError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('auth_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    if (!path.startsWith('/share')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_expires_at');
      window.location.href = '/login';
    }
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    let message = `API Error ${res.status}`;
    let data: any = null;
    try {
      data = await res.json();
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      // body wasn't JSON
    }
    throw new ApiError(message, res.status, data);
  }
  return res.json();
}

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<{ token: string; username: string; expiresAt: number }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
  },
  files: {
    upload: async (file: File, pageId?: string): Promise<{ file: FileInfo }> => {
      const token = localStorage.getItem('auth_token');
      const formData = new FormData();
      formData.append('file', file);
      if (pageId) formData.append('page_id', pageId);
      const res = await fetch(`${API_BASE}/files/upload`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      });
      if (res.status === 401) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_expires_at');
        window.location.href = '/login';
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        let message = `Upload error: ${res.status}`;
        try {
          const data: any = await res.json();
          if (data && typeof data.error === 'string') message = data.error;
        } catch { /* ignore */ }
        throw new Error(message);
      }
      return res.json();
    },
    getUrl: (id: string) => `${API_BASE}/files/${id}`,
  },
  pages: {
    list: () => request<{ pages: Page[] }>('/pages'),
    get: (id: string) => request<{ page: PageWithBlocks }>(`/pages/${id}`),
    create: (data: { title?: string; parent_id?: string | null; icon?: string }) =>
      request<{ page: Page }>('/pages', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Page, 'title' | 'icon' | 'parent_id' | 'position'>>) =>
      request<{ page: Page }>(`/pages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ success: boolean; deletedPages: number }>(`/pages/${id}`, { method: 'DELETE' }),
    cascadeCount: (id: string) =>
      request<{ pages: number; blocks: number }>(`/pages/${id}/cascade-count`),
    export: (id: string) =>
      request<{ markdown: string; title: string }>(`/pages/${id}/export`),
    import: (data: { markdown: string; title?: string; parent_id?: string | null }) =>
      request<{ page: PageWithBlocks }>('/pages/import', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  blocks: {
    create: (pageId: string, data: { type: string; content?: string; position: number; parent_id?: string | null; language?: string }) =>
      request<{ block: Block }>(`/pages/${pageId}/blocks`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Block, 'content' | 'type' | 'checked' | 'language' | 'position' | 'parent_id' | 'collapsed'>>) =>
      request<{ block: Block }>(`/blocks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/blocks/${id}`, { method: 'DELETE' }),
    reorder: (blocks: { id: string; position: number }[]) =>
      request<{ success: boolean }>('/blocks/reorder', { method: 'PUT', body: JSON.stringify({ blocks }) }),
  },
  workspace: {
    get: () => request<{ name: string; icon: string }>('/workspace'),
    update: (data: Partial<{ name: string; icon: string }>) =>
      request<{ name: string; icon: string }>('/workspace', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },
  shares: {
    // Auth-gated: manages the share of a page you own.
    // Returns null instead of throwing if the page has no active share.
    get: async (pageId: string): Promise<{ token: string; revoked: boolean; created_at: string } | null> => {
      try {
        return await request<{ token: string; revoked: boolean; created_at: string }>(`/pages/${pageId}/share`);
      } catch (err: any) {
        if (err?.status === 404 || /404|No active share/i.test(err?.message || '')) {
          return null;
        }
        throw err;
      }
    },
    create: (pageId: string) =>
      request<{ token: string; revoked: boolean; created_at: string }>(`/pages/${pageId}/share`, {
        method: 'POST',
      }),
    revoke: (pageId: string) =>
      request<{ success: boolean; changed: number }>(`/pages/${pageId}/share`, {
        method: 'DELETE',
      }),
    // Public: no auth required. The backend validates the token + that
    // pageId is a descendant of the shared root.
    publicGet: (token: string) =>
      request<{ root: Page; pages: Page[] }>(`/share/${encodeURIComponent(token)}`),
    publicGetPage: (token: string, pageId: string) =>
      request<{ page: Page; blocks: Block[] }>(
        `/share/${encodeURIComponent(token)}/page/${encodeURIComponent(pageId)}`
      ),
  },
  search: (query: string) =>
    request<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query)}`),
};

