import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_BRAND_NAME, type BrandingResponse } from '@netlink/contracts';
import { api } from '../lib/api';

/**
 * The name this installation runs under.
 *
 * Read from the control plane rather than compiled in, so the name on the
 * screen is the same one signing the verification emails — that comparison is
 * what tells somebody a six-digit code is genuine, and it only works if the two
 * cannot disagree.
 *
 * The default is used until the server answers, and stays if it never does. A
 * sign-in screen that renders nothing where its own name should be, because a
 * request is in flight, is worse than one showing the product's default name.
 */
type BrandState = BrandingResponse;

const BrandContext = createContext<BrandState>({ name: DEFAULT_BRAND_NAME });

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<BrandState>({ name: DEFAULT_BRAND_NAME });

  useEffect(() => {
    let cancelled = false;
    void api
      .branding()
      .then((response) => {
        if (!cancelled && response.name) setBrand(response);
      })
      .catch(() => {
        /* Keep the default. This is a label, not a capability. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => brand, [brand]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandState {
  return useContext(BrandContext);
}

/** Shorthand for the common case — the name on its own. */
export function useBrandName(): string {
  return useContext(BrandContext).name;
}
