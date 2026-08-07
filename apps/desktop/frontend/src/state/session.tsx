import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthenticatedDevice, AuthenticatedUser } from '@netlink/contracts';
import { api, type StoredSession } from '../lib/api';
import { getEnvironment, type Environment } from '../lib/bridge';

/**
 * Session state for the whole app.
 *
 * Deliberate choice: the refresh token is held in memory only. Persisting it
 * would keep the user signed in across restarts, but it would also leave a
 * long-lived credential sitting on disk where any process running as that user
 * could read it. Until the token can be sealed with DPAPI through the Go side
 * — which is Phase 2 work — signing in again after a restart is the honest
 * trade.
 */

type SessionState = {
  user: AuthenticatedUser | null;
  device: AuthenticatedDevice | null;
  environment: Environment | null;
  ready: boolean;
  signedIn: boolean;
  setSession: (session: StoredSession) => void;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<StoredSession | null>(api.getSession());
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const env = await getEnvironment();
      if (cancelled) return;
      // The Go side is the authority on which control plane this installation
      // talks to; the Vite variable is only the browser-development fallback.
      api.setBaseUrl(env.apiBaseUrl);
      setEnvironment(env);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => api.onSessionChange(setSessionState), []);

  const setSession = useCallback((next: StoredSession) => {
    api.setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      user: session?.user ?? null,
      device: session?.device ?? null,
      environment,
      ready,
      signedIn: Boolean(session),
      setSession,
      signOut,
    }),
    [session, environment, ready, setSession, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}
