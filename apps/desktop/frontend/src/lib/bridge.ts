import type { DeviceIdentity } from '@netlink/contracts';

/**
 * The bridge to the Go side of the desktop app.
 *
 * Wails generates bindings into `wailsjs/` at build time. That directory does
 * not exist when running the frontend on its own with `npm run dev`, so every
 * call goes through here: it uses the real binding when the app is running
 * inside Wails, and a clearly-labelled browser fallback otherwise.
 *
 * The fallback exists so the UI can be developed and tested in a browser. It
 * generates a throwaway identity that is *not* backed by DPAPI, and says so —
 * it must never be mistaken for the real thing.
 */

type WailsGo = {
  main?: {
    App?: {
      GetDeviceIdentity?: () => Promise<DeviceIdentity>;
      GetEnvironment?: () => Promise<Environment>;
      ForgetDeviceIdentity?: () => Promise<void>;
    };
  };
};

export type Environment = {
  apiBaseUrl: string;
  appVersion: string;
  platform: string;
  dataDirectory: string;
  keyProtection: string;
};

declare global {
  interface Window {
    go?: WailsGo;
  }
}

export function isRunningInWails(): boolean {
  return typeof window !== 'undefined' && Boolean(window.go?.main?.App?.GetDeviceIdentity);
}

const BROWSER_IDENTITY_KEY = 'netlink.dev.deviceIdentity';

/**
 * A stable, throwaway identity for browser development.
 *
 * The key is random but is *not* an Ed25519 key pair and has no private half —
 * the browser has nowhere safe to keep one. Anything that genuinely needs a
 * signature must run inside Wails.
 */
function browserIdentity(): DeviceIdentity {
  const existing = localStorage.getItem(BROWSER_IDENTITY_KEY);
  if (existing) {
    try {
      return JSON.parse(existing) as DeviceIdentity;
    } catch {
      localStorage.removeItem(BROWSER_IDENTITY_KEY);
    }
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const publicKey = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const identity: DeviceIdentity = {
    installationId: crypto.randomUUID(),
    publicKey,
    publicKeyAlgorithm: 'ed25519',
    name: 'Browser (development)',
    platform: 'web',
    kind: 'browser',
    appVersion: '0.1.0-dev',
  };

  localStorage.setItem(BROWSER_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const binding = window.go?.main?.App?.GetDeviceIdentity;
  if (binding) return binding();
  return browserIdentity();
}

export async function getEnvironment(): Promise<Environment> {
  const binding = window.go?.main?.App?.GetEnvironment;
  if (binding) return binding();

  return {
    apiBaseUrl: import.meta.env.VITE_NETLINK_API_URL ?? 'http://127.0.0.1:4000/api',
    appVersion: '0.1.0-dev',
    platform: 'web',
    dataDirectory: 'browser local storage',
    keyProtection: 'none — browser development only',
  };
}

export async function forgetDeviceIdentity(): Promise<void> {
  const binding = window.go?.main?.App?.ForgetDeviceIdentity;
  if (binding) {
    await binding();
    return;
  }
  localStorage.removeItem(BROWSER_IDENTITY_KEY);
}
