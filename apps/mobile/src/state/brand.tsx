import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_BRAND_NAME, type BrandingResponse } from '@netlink/contracts';
import { api } from './session';

/**
 * The name this installation runs under, on the phone.
 *
 * Same reasoning as the desktop: it comes from the control plane rather than
 * being compiled in, so the name on the screen matches the name signing the
 * verification emails. On a phone that matters more, not less — the email and
 * the app are often two windows on the same device, seconds apart.
 *
 * The default shows until the server answers, and stays if it never does.
 */
const BrandContext = createContext<BrandingResponse>({ name: DEFAULT_BRAND_NAME });

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<BrandingResponse>({ name: DEFAULT_BRAND_NAME });

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

export function useBrandName(): string {
  return useContext(BrandContext).name;
}
