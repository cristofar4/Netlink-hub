import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NetLinkApi, type StoredSession } from '../lib/api';
import { API_URL } from '../lib/config';

/**
 * Who is signed in, and on which device.
 *
 * One API instance for the whole app, so refresh coalescing actually coalesces.
 * Several instances would each hold their own in-flight promise, present the
 * same refresh token concurrently, and get the session lineage revoked for
 * token reuse — which is the server behaving correctly and the client being
 * wrong.
 */

export const api = new NetLinkApi(API_URL);

type SessionState = {
  session: StoredSession | null;
  /** True until the stored session has been checked, so nothing flashes. */
  restoring: boolean;
};

const SessionContext = createContext<SessionState>({ session: null, restoring: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let active = true;

    const unsubscribe = api.onSessionChange((next) => {
      if (active) setSession(next);
    });

    void api
      .restore()
      .catch(() => null)
      .finally(() => {
        if (active) setRestoring(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo(() => ({ session, restoring }), [session, restoring]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
