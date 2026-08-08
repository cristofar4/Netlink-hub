import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@netlink/contracts';
import { api } from './session';

/**
 * The Space currently being looked at.
 *
 * Most people have exactly one, so the first is selected automatically rather
 * than making them choose between a list of one.
 */

type SpaceState = {
  spaces: SpaceSummary[];
  active: SpaceSummary | null;
  loading: boolean;
  error: string | null;
  select: (spaceId: string) => void;
  reload: () => Promise<void>;
};

const SpaceContext = createContext<SpaceState>({
  spaces: [],
  active: null,
  loading: true,
  error: null,
  select: () => {},
  reload: async () => {},
});

export function SpaceProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const list = await api.spaces();
        setSpaces(list);
        setActiveId((current) => current ?? list[0]?.id ?? null);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not load your Spaces.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<SpaceState>(
    () => ({
      spaces,
      active: spaces.find((space) => space.id === activeId) ?? null,
      loading,
      error,
      select: setActiveId,
      reload,
    }),
    [spaces, activeId, loading, error, reload],
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceState {
  return useContext(SpaceContext);
}
