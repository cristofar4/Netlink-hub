import type {
  AgentPowerState,
  AgentSummary,
  ApprovedFolder,
  AuditPage,
  AuthSuccessResponse,
  AuthenticatedDevice,
  AuthenticatedUser,
  ChallengeResponse,
  DataPoolSummary,
  FileEntry,
  LoginResponse,
  MemberAccessRow,
  MyAllocation,
  PowerAction,
  PowerCommandRequest,
  PowerCommandSummary,
  SessionTokens,
  SharedPrinter,
  SpaceSummary,
} from '@netlink/contracts';
import { clearSession, readSecure, writeSecure } from './secure-store';
import { defaultDeviceName, devicePlatform, loadOrCreateIdentity } from './identity';

/**
 * The NetLink API client for Android.
 *
 * Two things differ from the desktop client, and both are deliberate:
 *
 *   * **The session is persisted**, in the Android Keystore. The desktop keeps
 *     its refresh token in memory only, because a file readable by any process
 *     running as that user is a bad place for a long-lived credential. Android's
 *     sandbox plus the Keystore change that calculation — and a phone that makes
 *     you sign in every time you open it is a phone people stop using.
 *   * **Failures carry a message a person can act on.** A phone is used in bad
 *     signal, on the move; "Request failed with status 503" is not useful to
 *     somebody standing on a train.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: Array<{ field: string; message: string }>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when trying again later is genuinely likely to work. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type StoredSession = {
  user: AuthenticatedUser;
  device: AuthenticatedDevice;
  tokens: SessionTokens;
};

type RequestOptions = {
  body?: unknown;
  auth?: boolean;
  /** Aborts slow requests so a stalled connection does not hang a screen. */
  timeoutMs?: number;
};

export class NetLinkApi {
  private session: StoredSession | null = null;
  private refreshInFlight: Promise<SessionTokens> | null = null;
  private listeners = new Set<(session: StoredSession | null) => void>();

  constructor(private baseUrl: string) {}

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  /**
   * Restores a session saved by a previous run.
   *
   * The access token is almost certainly expired by now — it lives fifteen
   * minutes — so this refreshes immediately rather than waiting for the first
   * request to fail. Opening the app to a spinner that resolves is better than
   * opening it to content that flickers into an error.
   */
  async restore(): Promise<StoredSession | null> {
    const raw = await readSecure('session');
    const refreshToken = await readSecure('refreshToken');
    if (!raw || !refreshToken) return null;

    try {
      const stored = JSON.parse(raw) as Omit<StoredSession, 'tokens'> & {
        tokens: Omit<SessionTokens, 'refreshToken'>;
      };
      this.session = {
        ...stored,
        tokens: { ...stored.tokens, refreshToken } as SessionTokens,
      };
      await this.refresh();
      this.publish();
      return this.session;
    } catch (error) {
      // A refresh token the server no longer recognises means the session is
      // genuinely over — the device was revoked, or the token was rotated
      // elsewhere. Clearing it is the honest response.
      if (error instanceof ApiError && !error.isTransient) {
        await this.signOutLocally();
        return null;
      }
      // A network failure is not proof of anything. Keep the session and let
      // the next request decide.
      this.publish();
      return this.session;
    }
  }

  getSession(): StoredSession | null {
    return this.session;
  }

  onSessionChange(listener: (session: StoredSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.session);
  }

  private async setSession(session: StoredSession): Promise<void> {
    this.session = session;

    // The refresh token is stored under its own key rather than inside the
    // JSON blob, so the long-lived credential can be deleted on its own.
    const { refreshToken, ...tokens } = session.tokens;
    await writeSecure('refreshToken', refreshToken);
    await writeSecure(
      'session',
      JSON.stringify({ user: session.user, device: session.device, tokens }),
    );
    this.publish();
  }

  async signOutLocally(): Promise<void> {
    this.session = null;
    await clearSession();
    this.publish();
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  register(input: { name: string; email: string; password: string }): Promise<ChallengeResponse> {
    return this.request('POST', '/auth/register', { body: input, auth: false });
  }

  verifyEmail(challengeId: string, code: string): Promise<{ verified: boolean }> {
    return this.request('POST', '/auth/verify-email', {
      body: { challengeId, code },
      auth: false,
    });
  }

  /** Signs in, presenting this installation's own public key. */
  async login(email: string, password: string): Promise<LoginResponse> {
    const identity = await loadOrCreateIdentity();
    const response = await this.request<LoginResponse>('POST', '/auth/login', {
      auth: false,
      body: {
        email,
        password,
        device: {
          installationId: identity.installationId,
          name: defaultDeviceName(),
          platform: devicePlatform(),
          kind: 'mobile',
          publicKeyAlgorithm: 'ed25519',
          publicKey: identity.publicKey,
        },
      },
    });

    if (response.status === 'authenticated') {
      await this.setSession({
        user: response.user,
        device: response.device,
        tokens: response.tokens,
      });
    }
    return response;
  }

  async verifyDevice(
    challengeId: string,
    code: string,
    trustDevice: boolean,
  ): Promise<AuthSuccessResponse> {
    const response = await this.request<AuthSuccessResponse>('POST', '/auth/verify-device', {
      auth: false,
      body: { challengeId, code, trustDevice },
    });
    await this.setSession({
      user: response.user,
      device: response.device,
      tokens: response.tokens,
    });
    return response;
  }

  resendCode(challengeId: string): Promise<ChallengeResponse> {
    return this.request('POST', '/auth/resend', { body: { challengeId }, auth: false });
  }

  async signOut(): Promise<void> {
    const refreshToken = this.session?.tokens.refreshToken;
    if (refreshToken) {
      // Best effort. A sign-out that fails because the network is down must
      // still clear the credential from this phone.
      try {
        await this.request('POST', '/auth/logout', { body: { refreshToken } });
      } catch {
        /* ignored on purpose */
      }
    }
    await this.signOutLocally();
  }

  // -------------------------------------------------------------------------
  // Spaces and devices
  // -------------------------------------------------------------------------

  spaces(): Promise<SpaceSummary[]> {
    return this.request('GET', '/spaces');
  }

  listAgents(spaceId: string): Promise<AgentSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/agents`);
  }

  devices(): Promise<AuthenticatedDevice[]> {
    return this.request('GET', '/devices');
  }

  renameDevice(deviceId: string, name: string): Promise<AuthenticatedDevice> {
    return this.request('PATCH', `/devices/${deviceId}`, { body: { name } });
  }

  revokeDevice(deviceId: string): Promise<AuthenticatedDevice> {
    return this.request('DELETE', `/devices/${deviceId}`);
  }

  // -------------------------------------------------------------------------
  // Power — the reason most people will open this app
  // -------------------------------------------------------------------------

  powerState(spaceId: string): Promise<AgentPowerState[]> {
    return this.request('GET', `/spaces/${spaceId}/power`);
  }

  requestPowerStepUp(spaceId: string, action: PowerAction): Promise<ChallengeResponse> {
    return this.request('POST', `/spaces/${spaceId}/power/step-up`, { body: { action } });
  }

  sendPowerCommand(spaceId: string, body: PowerCommandRequest): Promise<PowerCommandSummary> {
    return this.request('POST', `/spaces/${spaceId}/power/commands`, { body });
  }

  powerHistory(spaceId: string, limit = 10): Promise<PowerCommandSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/power/commands?limit=${limit}`);
  }

  // -------------------------------------------------------------------------
  // Files, printers, data, members, activity
  // -------------------------------------------------------------------------

  listFolders(spaceId: string): Promise<ApprovedFolder[]> {
    return this.request('GET', `/spaces/${spaceId}/files/folders`);
  }

  browse(spaceId: string, resourceId: string, path = ''): Promise<FileEntry[]> {
    return this.request('POST', `/spaces/${spaceId}/files/browse`, {
      body: { resourceId, path },
    });
  }

  listPrinters(spaceId: string): Promise<SharedPrinter[]> {
    return this.request('GET', `/spaces/${spaceId}/printers`);
  }

  dataPool(spaceId: string): Promise<DataPoolSummary> {
    return this.request('GET', `/spaces/${spaceId}/data/pool`);
  }

  myAllocation(spaceId: string): Promise<MyAllocation> {
    return this.request('GET', `/spaces/${spaceId}/data/mine`);
  }

  members(spaceId: string): Promise<MemberAccessRow[]> {
    return this.request('GET', `/spaces/${spaceId}/data/members`);
  }

  activity(limit = 50, cursor?: string): Promise<AuditPage> {
    const query = cursor
      ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `?limit=${limit}`;
    return this.request('GET', `/activity${query}`);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { auth = true } = options;

    if (auth && !this.session) throw new ApiError('You are not signed in.', 401);

    let response = await this.send(method, path, options, auth);

    // One retry after a refresh. A second 401 means the refresh did not help,
    // and retrying again would just be a loop.
    if (response.status === 401 && auth && this.session) {
      try {
        await this.refresh();
      } catch {
        await this.signOutLocally();
        throw new ApiError('Your session has ended. Please sign in again.', 401);
      }
      response = await this.send(method, path, options, auth);
    }

    return this.parse<T>(response);
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions,
    auth: boolean,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(auth && this.session
            ? { authorization: `Bearer ${this.session.tokens.accessToken}` }
            : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      // A phone loses signal constantly. This is the ordinary case, not an
      // exceptional one, and it deserves a sentence rather than a stack trace.
      const aborted = (error as Error)?.name === 'AbortError';
      throw new ApiError(
        aborted
          ? 'That took too long. Check your connection and try again.'
          : 'Could not reach NetLink. Check your connection.',
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const detail = payload as {
        message?: string | string[];
        errors?: Array<{ field: string; message: string }>;
        retryAfterSeconds?: number;
      } | null;

      const message = Array.isArray(detail?.message)
        ? detail.message.join(' ')
        : (detail?.message ?? 'Something went wrong. Please try again.');

      throw new ApiError(message, response.status, detail?.errors, detail?.retryAfterSeconds);
    }

    return payload as T;
  }

  /**
   * Rotates the refresh token, coalescing concurrent callers onto one request.
   *
   * Without the coalescing, two requests expiring together would each present
   * the same refresh token; the second would look like token reuse to the
   * server, which revokes the whole session lineage by design. That matters
   * more on a phone than on a desktop — a screen coming back from the
   * background fires several requests at once, every time.
   */
  private async refresh(): Promise<SessionTokens> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const current = this.session;
    if (!current) throw new ApiError('You are not signed in.', 401);

    this.refreshInFlight = (async () => {
      try {
        const tokens = await this.parse<SessionTokens>(
          await this.send(
            'POST',
            '/auth/refresh',
            { body: { refreshToken: current.tokens.refreshToken } },
            false,
          ),
        );
        await this.setSession({ ...current, tokens });
        return tokens;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }
}
