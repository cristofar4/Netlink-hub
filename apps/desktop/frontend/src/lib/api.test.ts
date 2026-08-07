import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetLinkApi, type StoredSession } from './api';

const BASE = 'http://api.test/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(overrides: Partial<StoredSession['tokens']> = {}): StoredSession {
  return {
    user: {
      id: 'user-1',
      name: 'Owner',
      email: 'owner@example.com',
      emailVerified: true,
      createdAt: new Date().toISOString(),
    },
    device: {
      id: 'device-1',
      name: 'Home PC',
      platform: 'windows',
      kind: 'desktop',
      trusted: true,
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      approximateLocation: null,
    },
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    },
  };
}

describe('NetLinkApi', () => {
  let api: NetLinkApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new NetLinkApi(BASE);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('requests', () => {
    it('sends no Authorization header when signed out', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ challengeId: 'c1' }));

      await api.register({ name: 'A', email: 'a@example.com', password: 'CorrectHorse1Battery' });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('attaches the bearer token when signed in', async () => {
      api.setSession(session());
      fetchMock.mockResolvedValue(jsonResponse([]));

      await api.listDevices();

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    });

    it('never sends the refresh token as a bearer credential', async () => {
      api.setSession(session());
      fetchMock.mockResolvedValue(jsonResponse([]));

      await api.listDevices();

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.stringify(init.headers)).not.toContain('refresh-1');
    });
  });

  describe('errors', () => {
    it('surfaces the server message', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'That code has expired.' }, 400));

      await expect(api.verifyEmail({ challengeId: 'c1', code: '123456' })).rejects.toThrow(
        'That code has expired.',
      );
    });

    it('exposes field errors from validation failures', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            message: 'The request could not be processed.',
            errors: [{ field: 'password', message: 'Password must be at least 12 characters' }],
          },
          400,
        ),
      );

      const caught = await api
        .register({ name: 'A', email: 'a@example.com', password: 'short' })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).fieldErrors?.[0]?.field).toBe('password');
    });

    it('flags rate limiting', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ message: 'Too many attempts.', retryAfterSeconds: 42 }, 429),
      );

      const caught = (await api.resendCode('c1').catch((error: unknown) => error)) as ApiError;

      expect(caught.isRateLimited).toBe(true);
      expect(caught.retryAfterSeconds).toBe(42);
    });

    it('reports a network failure in plain language', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const caught = (await api.health().catch((error: unknown) => error)) as ApiError;

      expect(caught.status).toBe(0);
      expect(caught.message).toMatch(/could not reach the server/i);
    });

    it('does not choke on a non-JSON error body', async () => {
      fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

      await expect(api.listDevices()).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('token refresh', () => {
    it('refreshes once on a 401 and replays the request', async () => {
      api.setSession(session());

      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))
        .mockResolvedValueOnce(
          jsonResponse({
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresAt: new Date().toISOString(),
            refreshTokenExpiresAt: new Date().toISOString(),
          }),
        )
        .mockResolvedValueOnce(jsonResponse([{ id: 'device-1' }]));

      const devices = await api.listDevices();

      expect(devices).toEqual([{ id: 'device-1' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // The replay carries the new token, not the expired one.
      const [, replayInit] = fetchMock.mock.calls[2];
      expect((replayInit.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
      expect(api.getSession()?.tokens.refreshToken).toBe('refresh-2');
    });

    it('does not loop when the refreshed token is also rejected', async () => {
      api.setSession(session());

      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))
        .mockResolvedValueOnce(
          jsonResponse({
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresAt: new Date().toISOString(),
            refreshTokenExpiresAt: new Date().toISOString(),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: 'still expired' }, 401));

      await expect(api.listDevices()).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('signs out when the refresh itself fails', async () => {
      api.setSession(session());

      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))
        .mockResolvedValueOnce(jsonResponse({ message: 'reuse detected' }, 401));

      await expect(api.listDevices()).rejects.toThrow(/sign in again/i);
      expect(api.getSession()).toBeNull();
    });

    it('coalesces concurrent refreshes into one', async () => {
      // Two parallel refreshes would present the same rotating refresh token,
      // which the server treats as theft and answers by killing the session.
      api.setSession(session());

      let refreshCalls = 0;
      fetchMock.mockImplementation((url: string) => {
        if (String(url).endsWith('/auth/refresh')) {
          refreshCalls += 1;
          return Promise.resolve(
            jsonResponse({
              accessToken: 'access-2',
              refreshToken: 'refresh-2',
              accessTokenExpiresAt: new Date().toISOString(),
              refreshTokenExpiresAt: new Date().toISOString(),
            }),
          );
        }
        if (String(url).includes('/devices')) {
          return Promise.resolve(jsonResponse({ message: 'expired' }, 401));
        }
        return Promise.resolve(jsonResponse({ items: [], nextCursor: null }, 401));
      });

      await Promise.allSettled([api.listDevices(), api.activity(), api.me()]);

      expect(refreshCalls).toBe(1);
    });
  });

  describe('sessions', () => {
    it('notifies listeners on change', () => {
      const listener = vi.fn();
      const unsubscribe = api.onSessionChange(listener);

      const next = session();
      api.setSession(next);
      expect(listener).toHaveBeenCalledWith(next);

      unsubscribe();
      api.setSession(null);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('clears the session on sign-out even when the server call fails', async () => {
      api.setSession(session());
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      await api.logout();

      expect(api.getSession()).toBeNull();
    });

    it('stores the session after a successful device verification', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'authenticated',
          user: session().user,
          device: session().device,
          tokens: session().tokens,
        }),
      );

      await api.verifyDevice({ challengeId: 'c1', code: '123456', trustDevice: true });

      expect(api.getSession()?.user.email).toBe('owner@example.com');
    });
  });

  it('honours a base URL change from the Go side', async () => {
    api.setBaseUrl('http://other.test/api/');
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', components: {} }));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe('http://other.test/api/health');
  });
});
