import type { Request } from 'express';

export type RequestContext = {
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * City/region-level at best, and only when a geo header is present at the
   * edge. NetLink never derives a precise coordinate, and never asks a device
   * for its GPS position.
   */
  approximateLocation: string | null;
};

/**
 * Reads the client's address from proxy headers when the app is behind a
 * trusted reverse proxy (`trust proxy` is enabled in `main.ts`), and falls back
 * to the socket address otherwise.
 */
export function extractRequestContext(req: Request): RequestContext {
  const ipAddress = normaliseIp(req.ip ?? req.socket?.remoteAddress ?? null);
  const userAgent = firstHeader(req, 'user-agent');

  // Populated by common edge proxies (Cloudflare, Fly, Vercel). Absent in local
  // development, in which case the location is simply unknown rather than guessed.
  const city = firstHeader(req, 'cf-ipcity') ?? firstHeader(req, 'x-vercel-ip-city');
  const country =
    firstHeader(req, 'cf-ipcountry') ??
    firstHeader(req, 'x-vercel-ip-country') ??
    firstHeader(req, 'fly-client-country');

  const approximateLocation = [city, country].filter(Boolean).join(', ') || null;

  return {
    ipAddress,
    userAgent: userAgent ? userAgent.slice(0, 256) : null,
    approximateLocation,
  };
}

function firstHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Strips the IPv4-mapped IPv6 prefix so audit records read naturally. */
function normaliseIp(ip: string | null): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
