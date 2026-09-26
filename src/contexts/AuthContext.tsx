import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from 'react';
import { api } from '../api/client';

interface AuthContextType {
  isAuthenticated: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const expiryTimer = useRef<number | null>(null);

  const clearExpiryTimer = () => {
    if (expiryTimer.current !== null) {
      window.clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  };

  const logout = () => {
    clearExpiryTimer();
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_username');
    localStorage.removeItem('auth_expires_at');
    setIsAuthenticated(false);
    setUsername(null);
  };

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    const savedUsername = localStorage.getItem('auth_username');
    const expStr = localStorage.getItem('auth_expires_at');
    const exp = expStr ? Number(expStr) : NaN;

    if (token && savedUsername && Number.isFinite(exp)) {
      if (Date.now() < exp) {
        setIsAuthenticated(true);
        setUsername(savedUsername);
        // Auto-logout on expiry so we never operate with a dead token.
        const ms = Math.max(0, exp - Date.now());
        expiryTimer.current = window.setTimeout(() => {
          logout();
        }, ms);
      } else {
        // Expired token: clean up and force re-login.
        logout();
      }
    } else if (token) {
      // Token without expiry (old backend version): force re-login.
      logout();
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (user: string, pass: string) => {
    const result = await api.auth.login(user, pass);
    localStorage.setItem('auth_token', result.token);
    localStorage.setItem('auth_username', result.username);
    if (typeof result.expiresAt === 'number') {
      localStorage.setItem('auth_expires_at', String(result.expiresAt));
      const ms = Math.max(0, result.expiresAt - Date.now());
      clearExpiryTimer();
      expiryTimer.current = window.setTimeout(() => {
        logout();
      }, ms);
    }
    setIsAuthenticated(true);
    setUsername(result.username);
  };

  useEffect(() => {
    return () => clearExpiryTimer();
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, username, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
