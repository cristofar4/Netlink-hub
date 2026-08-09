import { USAGE_HISTORY_DEFAULT_DAYS } from '@netlink/contracts';
import type {
  AgentPowerState,
  AgentSummary,
  ApprovedFolder,
  ApproveFolderRequest,
  CreatePassRequest,
  CreateRemoteSessionRequest,
  DataPoolSummary,
  DataUsageSeries,
  MemberAccessRow,
  MyAllocation,
  PassSummary,
  PowerAction,
  PowerCommandRequest,
  PowerCommandSummary,
  PrintJob,
  PrintJobRequest,
  RemoteEndReason,
  RemoteSessionSummary,
  RemoteSessionTicket,
  RemoteSignal,
  SharedPrinter,
  SignalKind,
  StartTransferRequest,
  Transfer,
  UpdateAllocationRequest,
  AuthSuccessResponse,
  AuthenticatedDevice,
  AuthenticatedUser,
  AuditPage,
  BrandingResponse,
  ChallengeResponse,
  DeviceIdentity,
  LoginResponse,
  ResourceSummary,
  SessionTokens,
  SpaceOverview,
  SpaceSummary,
} from '@netlink/contracts';

/**
 * The NetLink control-plane client.
 *
 * Two things it does that a naive fetch wrapper would not:
 *
 *   * It refreshes an expired access token once, transparently, and retries the
 *     request. Access tokens live fifteen minutes, so without this the app
 *     would throw the user back to sign-in mid-session.
 *   * It coalesces concurrent refreshes. Refresh tokens rotate and reuse is
 *     treated as theft, so two parallel refreshes with the same token would
 *     revoke the user's entire session.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors?: Array<{ field: string; message: string }>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export type StoredSession = {
  user: AuthenticatedUser;
  device: AuthenticatedDevice;
  tokens: SessionTokens;
};

type SessionListener = (session: StoredSession | null) => void;

export class NetLinkApi {
  private session: StoredSession | null = null;
  private refreshInFlight: Promise<SessionTokens> | null = null;
  private readonly listeners = new Set<SessionListener>();

  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  getSession(): StoredSession | null {
    return this.session;
  }

  setSession(session: StoredSession | null): void {
    this.session = session;
    for (const listener of this.listeners) listener(session);
  }

  onSessionChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  register(input: { name: string; email: string; password: string }): Promise<ChallengeResponse> {
    return this.request('POST', '/auth/register', { body: input, auth: false });
  }

  verifyEmail(input: { challengeId: string; code: string }): Promise<{ verified: true }> {
    return this.request('POST', '/auth/verify-email', { body: input, auth: false });
  }

  login(input: {
    email: string;
    password: string;
    device: DeviceIdentity;
  }): Promise<LoginResponse> {
    return this.request('POST', '/auth/login', { body: input, auth: false });
  }

  async verifyDevice(input: {
    challengeId: string;
    code: string;
    trustDevice: boolean;
  }): Promise<AuthSuccessResponse> {
    const response = await this.request<AuthSuccessResponse>('POST', '/auth/verify-device', {
      body: input,
      auth: false,
    });
    this.setSession({ user: response.user, device: response.device, tokens: response.tokens });
    return response;
  }

  resendCode(challengeId: string): Promise<ChallengeResponse> {
    return this.request('POST', '/auth/resend-code', { body: { challengeId }, auth: false });
  }

  me(): Promise<AuthenticatedUser> {
    return this.request('GET', '/auth/me');
  }

  async logout(): Promise<void> {
    const refreshToken = this.session?.tokens.refreshToken;
    if (refreshToken) {
      // A failure here still signs the user out locally — leaving them stuck in
      // the app because the server was briefly unreachable would be worse.
      try {
        await this.request('POST', '/auth/logout', { body: { refreshToken }, auth: false });
      } catch {
        /* ignored deliberately */
      }
    }
    this.setSession(null);
  }

  // -------------------------------------------------------------------------
  // Devices and activity
  // -------------------------------------------------------------------------

  listDevices(): Promise<AuthenticatedDevice[]> {
    return this.request('GET', '/devices');
  }

  renameDevice(id: string, name: string): Promise<AuthenticatedDevice> {
    return this.request('PATCH', `/devices/${id}`, { body: { name } });
  }

  revokeDevice(id: string): Promise<AuthenticatedDevice> {
    return this.request('DELETE', `/devices/${id}`);
  }

  // -------------------------------------------------------------------------
  // Spaces, agents and resources
  // -------------------------------------------------------------------------

  listSpaces(): Promise<SpaceSummary[]> {
    return this.request('GET', '/spaces');
  }

  createSpace(name: string): Promise<SpaceSummary> {
    return this.request('POST', '/spaces', { body: { name } });
  }

  renameSpace(id: string, name: string): Promise<{ id: string; name: string }> {
    return this.request('PATCH', `/spaces/${id}`, { body: { name } });
  }

  listAgents(spaceId: string): Promise<AgentSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/agents`);
  }

  listResources(spaceId: string, kind?: 'folder' | 'printer'): Promise<ResourceSummary[]> {
    const query = kind ? `?kind=${kind}` : '';
    return this.request('GET', `/spaces/${spaceId}/resources${query}`);
  }

  setResourceEnabled(
    spaceId: string,
    resourceId: string,
    enabled: boolean,
  ): Promise<ResourceSummary> {
    return this.request('PATCH', `/spaces/${spaceId}/resources/${resourceId}`, {
      body: { enabled },
    });
  }

  createEnrollmentToken(
    spaceId: string,
  ): Promise<{ token: string; expiresAt: string; spaceId: string }> {
    return this.request('POST', `/spaces/${spaceId}/enrollment-token`);
  }

  // -------------------------------------------------------------------------
  // Data Pool
  // -------------------------------------------------------------------------

  connectDataPool(spaceId: string, accountRef: string): Promise<DataPoolSummary> {
    return this.request('POST', `/spaces/${spaceId}/data/pool`, { body: { accountRef } });
  }

  dataPool(spaceId: string): Promise<DataPoolSummary> {
    return this.request('GET', `/spaces/${spaceId}/data/pool`);
  }

  myAllocation(spaceId: string): Promise<MyAllocation> {
    return this.request('GET', `/spaces/${spaceId}/data/mine`);
  }

  /**
   * Daily usage for the chart.
   *
   * The server decides what a caller may see — the whole Space, or only their
   * own allocation — so the same call serves an owner and a member.
   */
  dataUsage(spaceId: string, days = USAGE_HISTORY_DEFAULT_DAYS): Promise<DataUsageSeries> {
    return this.request('GET', `/spaces/${spaceId}/data/usage?days=${days}`);
  }

  /** Everything the Overview screen shows, in one consistent read. */
  spaceOverview(spaceId: string): Promise<SpaceOverview> {
    return this.request('GET', `/spaces/${spaceId}/overview`);
  }

  memberAccess(spaceId: string): Promise<MemberAccessRow[]> {
    return this.request('GET', `/spaces/${spaceId}/data/members`);
  }

  pauseMemberData(spaceId: string, memberId: string, paused: boolean): Promise<{ status: string }> {
    return this.request('PATCH', `/spaces/${spaceId}/data/members/${memberId}/pause`, {
      body: { paused },
    });
  }

  updateMemberAllocation(
    spaceId: string,
    memberId: string,
    body: UpdateAllocationRequest,
  ): Promise<{ updated: true }> {
    return this.request('PATCH', `/spaces/${spaceId}/data/members/${memberId}/allocation`, {
      body,
    });
  }

  revokeMemberAccess(spaceId: string, memberId: string): Promise<{ revoked: true }> {
    return this.request('DELETE', `/spaces/${spaceId}/data/members/${memberId}`);
  }

  createPass(spaceId: string, body: CreatePassRequest): Promise<PassSummary> {
    return this.request('POST', `/spaces/${spaceId}/data/passes`, { body });
  }

  listPasses(spaceId: string): Promise<PassSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/data/passes`);
  }

  revokePass(spaceId: string, passId: string): Promise<{ revoked: true }> {
    return this.request('DELETE', `/spaces/${spaceId}/data/passes/${passId}`);
  }

  claimPass(token: string): Promise<{ spaceId: string; spaceName: string; permissions: string[] }> {
    return this.request('POST', '/passes/claim', { body: { token } });
  }

  // -------------------------------------------------------------------------
  // Power
  // -------------------------------------------------------------------------

  powerState(spaceId: string): Promise<AgentPowerState[]> {
    return this.request('GET', `/spaces/${spaceId}/power`);
  }

  powerHistory(spaceId: string, limit = 25): Promise<PowerCommandSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/power/commands?limit=${limit}`);
  }

  requestPowerStepUp(spaceId: string, action: PowerAction): Promise<ChallengeResponse> {
    return this.request('POST', `/spaces/${spaceId}/power/step-up`, { body: { action } });
  }

  requestPowerCommand(spaceId: string, body: PowerCommandRequest): Promise<PowerCommandSummary> {
    return this.request('POST', `/spaces/${spaceId}/power/commands`, { body });
  }

  setWakeHelper(
    spaceId: string,
    agentId: string,
    isWakeHelper: boolean,
  ): Promise<{ agentId: string; isWakeHelper: boolean }> {
    return this.request('PUT', `/spaces/${spaceId}/power/agents/${agentId}/wake-helper`, {
      body: { isWakeHelper },
    });
  }

  registerMac(
    spaceId: string,
    agentId: string,
    macAddress: string,
  ): Promise<{ agentId: string; macAddress: string }> {
    return this.request('PUT', `/spaces/${spaceId}/power/agents/${agentId}/mac`, {
      body: { macAddress },
    });
  }

  // -------------------------------------------------------------------------
  // Files and printers
  // -------------------------------------------------------------------------

  listFolders(spaceId: string): Promise<ApprovedFolder[]> {
    return this.request('GET', `/spaces/${spaceId}/files/folders`);
  }

  approveFolder(spaceId: string, body: ApproveFolderRequest): Promise<ApprovedFolder> {
    return this.request('POST', `/spaces/${spaceId}/files/folders`, { body });
  }

  startTransfer(spaceId: string, body: StartTransferRequest): Promise<Transfer> {
    return this.request('POST', `/spaces/${spaceId}/files/transfers`, { body });
  }

  listTransfers(spaceId: string, limit = 25): Promise<Transfer[]> {
    return this.request('GET', `/spaces/${spaceId}/files/transfers?limit=${limit}`);
  }

  fileOperation(
    spaceId: string,
    body: {
      resourceId: string;
      operation: 'mkdir' | 'rename' | 'delete';
      path: string;
      toPath?: string;
      confirmed?: boolean;
    },
  ): Promise<{ accepted: true }> {
    return this.request('POST', `/spaces/${spaceId}/files/operations`, { body });
  }

  listPrinters(spaceId: string): Promise<SharedPrinter[]> {
    return this.request('GET', `/spaces/${spaceId}/printers`);
  }

  submitPrintJob(spaceId: string, body: PrintJobRequest): Promise<PrintJob> {
    return this.request('POST', `/spaces/${spaceId}/printers/jobs`, { body });
  }

  listPrintJobs(spaceId: string, limit = 25): Promise<PrintJob[]> {
    return this.request('GET', `/spaces/${spaceId}/printers/jobs?limit=${limit}`);
  }

  // -------------------------------------------------------------------------
  // Remote desktop
  // -------------------------------------------------------------------------

  listRemoteSessions(spaceId: string, limit = 20): Promise<RemoteSessionSummary[]> {
    return this.request('GET', `/spaces/${spaceId}/remote/sessions?limit=${limit}`);
  }

  requestRemoteStepUp(spaceId: string): Promise<{ challengeId: string; maskedEmail: string }> {
    return this.request('POST', `/spaces/${spaceId}/remote/step-up`);
  }

  createRemoteSession(
    spaceId: string,
    body: CreateRemoteSessionRequest,
  ): Promise<RemoteSessionTicket> {
    return this.request('POST', `/spaces/${spaceId}/remote/sessions`, { body });
  }

  getRemoteSession(spaceId: string, sessionId: string): Promise<RemoteSessionSummary> {
    return this.request('GET', `/spaces/${spaceId}/remote/sessions/${sessionId}`);
  }

  remoteHeartbeat(spaceId: string, sessionId: string): Promise<RemoteSessionSummary> {
    return this.request('POST', `/spaces/${spaceId}/remote/sessions/${sessionId}/heartbeat`);
  }

  sendRemoteSignal(
    spaceId: string,
    sessionId: string,
    kind: SignalKind,
    payload: string,
  ): Promise<{ seq: number }> {
    return this.request('POST', `/spaces/${spaceId}/remote/sessions/${sessionId}/signal`, {
      body: { sessionId, kind, payload },
    });
  }

  collectRemoteSignals(spaceId: string, sessionId: string): Promise<RemoteSignal[]> {
    return this.request('GET', `/spaces/${spaceId}/remote/sessions/${sessionId}/signals`);
  }

  endRemoteSession(
    spaceId: string,
    sessionId: string,
    reason: RemoteEndReason,
  ): Promise<RemoteSessionSummary> {
    return this.request('POST', `/spaces/${spaceId}/remote/sessions/${sessionId}/end`, {
      body: { reason },
    });
  }

  /** The URL the live-updates socket connects to, with the current token. */
  liveUrl(): string | null {
    const session = this.getSession();
    if (!session) return null;
    const base = this.baseUrl.replace(/^http/, 'ws');
    return `${base}/live?access_token=${encodeURIComponent(session.tokens.accessToken)}`;
  }

  activity(limit = 50, cursor?: string): Promise<AuditPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.request('GET', `/activity?${query.toString()}`);
  }

  /** Who this installation says it is. Read before anyone has signed in. */
  branding(): Promise<BrandingResponse> {
    return this.request('GET', '/branding', { auth: false });
  }

  health(): Promise<{ status: string; components: Record<string, { status: string }> }> {
    return this.request('GET', '/health', { auth: false });
  }

  /**
   * Round trip to the control plane, in milliseconds.
   *
   * A real measurement of a real request, taken here rather than reported by
   * the server — what matters to someone watching the dashboard is how far away
   * the service is from *them*. The liveness endpoint is used because it
   * touches no database, so this times the network rather than a query.
   *
   * Returns null when the request fails: no answer is not the same as a fast
   * one, and showing the last good figure would be worse than showing none.
   */
  async pingLatencyMs(): Promise<number | null> {
    const started = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/health/live`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return Math.round(performance.now() - started);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; auth?: boolean; retryOn401?: boolean } = {},
  ): Promise<T> {
    const { body, auth = true, retryOn401 = true } = options;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.session) {
      headers.Authorization = `Bearer ${this.session.tokens.accessToken}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(
        'NetLink could not reach the server. Check your connection and try again.',
        0,
      );
    }

    if (response.status === 401 && auth && retryOn401 && this.session) {
      // One transparent refresh, then replay the original request. `retryOn401`
      // is false on the replay, so a genuinely dead session fails rather than
      // looping.
      try {
        await this.refresh();
      } catch {
        this.setSession(null);
        throw new ApiError('Your session has expired. Please sign in again.', 401);
      }
      return this.request<T>(method, path, { ...options, retryOn401: false });
    }

    return this.parse<T>(response);
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
        : (detail?.message ?? `Request failed with status ${response.status}`);

      throw new ApiError(message, response.status, detail?.errors, detail?.retryAfterSeconds);
    }

    return payload as T;
  }

  /**
   * Rotates the refresh token, coalescing concurrent callers onto one request.
   *
   * Without the coalescing, two requests expiring together would each present
   * the same refresh token; the second would look like token reuse to the
   * server, which revokes the whole session lineage by design.
   */
  private async refresh(): Promise<SessionTokens> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const current = this.session;
    if (!current) throw new ApiError('Not signed in.', 401);

    this.refreshInFlight = (async () => {
      try {
        const tokens = await this.request<SessionTokens>('POST', '/auth/refresh', {
          body: { refreshToken: current.tokens.refreshToken },
          auth: false,
        });
        this.setSession({ ...current, tokens });
        return tokens;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }
}

export const api = new NetLinkApi(
  import.meta.env.VITE_NETLINK_API_URL ?? 'http://127.0.0.1:4000/api',
);
