import { createContext, useContext } from 'react';
import { ApiError } from '@workspace/api-client-react';

export type SessionUser = { id: string; username: string; avatarUrl: string | null };
export type StoredSession = { token: string; expiresAt: number; user: SessionUser };

const STORAGE_KEY = 'iddet_ads_session';
export const SESSION_EXPIRED_EVENT = 'iddet-ads:session-expired';

export function readSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredSession;
    if (!session?.token || !session.user || session.expiresAt * 1000 <= Date.now()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // stockage indisponible (navigation privée stricte) : la session vivra le temps de l'onglet
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // rien à nettoyer
  }
}

export function apiErrorMessage(error: unknown, fallback = 'Une erreur est survenue. Réessaie.'): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    if (data && typeof data.error === 'string') return data.error;
  }
  return fallback;
}

async function authRequest(path: string, body: Record<string, string>): Promise<StoredSession> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Impossible de joindre le serveur. Vérifie ta connexion.');
  }
  const data = (await response.json().catch(() => null)) as
    | { error?: string; token?: string; expiresAt?: number; user?: SessionUser }
    | null;
  if (!response.ok || !data?.token || !data.user || !data.expiresAt) {
    throw new Error(data?.error ?? 'Une erreur est survenue. Réessaie.');
  }
  return { token: data.token, expiresAt: data.expiresAt, user: data.user };
}

export const loginRequest = (username: string, password: string) =>
  authRequest('/api/auth/login', { username, password });

export const registerRequest = (username: string, password: string, email: string) =>
  authRequest('/api/auth/register', { username, password, ...(email ? { email } : {}) });

export type AuthContextValue = {
  mode: 'shopify' | 'iddet';
  user: SessionUser | null;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue>({ mode: 'shopify', user: null, logout: () => {} });
export const useAuth = () => useContext(AuthContext);
