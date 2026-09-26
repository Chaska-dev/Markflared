import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../api/client';

export interface WorkspaceConfig {
  name: string;
  icon: string;
}

interface WorkspaceContextType {
  workspace: WorkspaceConfig;
  loading: boolean;
  updateWorkspace: (data: Partial<WorkspaceConfig>) => Promise<void>;
}

const DEFAULT: WorkspaceConfig = {
  name: 'My Workspace',
  icon: '',
};

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<WorkspaceConfig>(DEFAULT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.workspace.get()
      .then(res => {
        if (active) setWorkspace({ name: res.name, icon: res.icon });
      })
      .catch(err => {
        // If it fails (e.g. not authenticated yet), use defaults. Don't
        // break the UI for this.
        console.warn('Could not load workspace config:', err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const updateWorkspace = async (data: Partial<WorkspaceConfig>) => {
    // Optimistic: apply locally first so the UI feels immediate. On server
    // failure, revert.
    const prev = workspace;
    setWorkspace(curr => ({ ...curr, ...data }));
    try {
      const res = await api.workspace.update(data);
      setWorkspace({ name: res.name, icon: res.icon });
    } catch (e) {
      setWorkspace(prev);
      throw e;
    }
  };

  return (
    <WorkspaceContext.Provider value={{ workspace, loading, updateWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}