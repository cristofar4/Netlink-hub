import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SpaceSummary } from '@netlink/contracts';
import { api } from '../lib/api';

/**
 * The Space the window is currently looking at.
 *
 * Hoisted out of the dashboard because several sections need it — Data Pool,
 * Member Access, Files, Printers and Power all operate inside one Space, and
 * each fetching its own copy would make them disagree with the sidebar.
 */
type SpaceState = {
  spaces: SpaceSummary[];
  activeSpace: SpaceSummary | null;
  loading: boolean;
  error: string | null;
  setActiveSpaceId: (id: string) => void;
  refresh: () => Promise<void>;
};

const SpaceContext = createContext<SpaceState | null>(null);

export function SpaceProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSpaces();
      setSpaces(list);
      // Keep the current selection if it still exists; a refresh should not
      // move the user somewhere else.
      setActiveSpaceId((current) =>
        current && list.some((space) => space.id === current) ? current : (list[0]?.id ?? null),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your Spaces.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SpaceState>(
    () => ({
      spaces,
      activeSpace: spaces.find((space) => space.id === activeSpaceId) ?? null,
      loading,
      error,
      setActiveSpaceId,
      refresh,
    }),
    [spaces, activeSpaceId, loading, error, refresh],
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpaces(): SpaceState {
  const context = useContext(SpaceContext);
  if (!context) throw new Error('useSpaces must be used inside a SpaceProvider');
  return context;
}
