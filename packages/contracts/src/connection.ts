/**
 * Future connection layer — interfaces only.
 *
 * Phase 6 implements remote desktop over WebRTC. These types exist now so the
 * control plane, the agent and the desktop client agree on the shape of
 * signalling before any of it is built, and so nothing needs redesigning when
 * the transport lands. Nothing here is wired up yet.
 */

export type IceServerConfig = {
  urls: string[];
  username?: string;
  /** Short-lived TURN credential. Never a long-lived shared secret. */
  credential?: string;
  credentialExpiresAt?: string;
};

export type ConnectionStrategy =
  /** Peers reached each other directly; media never touches our servers. */
  | 'direct'
  /** Media is relayed, but stays end-to-end encrypted through the relay. */
  | 'relay'
  /** Optional, later: a WireGuard tunnel for private-network access. */
  | 'wireguard';

export type ConnectionQuality = {
  strategy: ConnectionStrategy;
  roundTripMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number | null;
  outboundKbps: number | null;
  inboundKbps: number | null;
  resolution: { width: number; height: number } | null;
  framesPerSecond: number | null;
  /** True only when the media path is end-to-end encrypted and peer-verified. */
  secure: boolean;
};

export type SignalMessage =
  | { type: 'offer'; sessionId: string; sdp: string }
  | { type: 'answer'; sessionId: string; sdp: string }
  | { type: 'ice-candidate'; sessionId: string; candidate: string; sdpMid: string | null }
  | { type: 'close'; sessionId: string; reason: string };

export type RemoteAccessMode = 'ask_every_time' | 'unattended';
export type RemoteControlLevel = 'view_only' | 'full_control';

export type RemoteSessionRequest = {
  spaceId: string;
  targetDeviceId: string;
  controlLevel: RemoteControlLevel;
};

export type RemoteSessionStage =
  | 'requesting'
  | 'awaiting_approval'
  | 'negotiating'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'closed';

/**
 * Implemented in Phase 6 by the control plane's signalling gateway.
 */
export interface SignallingTransport {
  requestSession(request: RemoteSessionRequest): Promise<{ sessionId: string }>;
  getIceServers(sessionId: string): Promise<IceServerConfig[]>;
  send(message: SignalMessage): Promise<void>;
  onMessage(handler: (message: SignalMessage) => void): () => void;
  close(sessionId: string, reason: string): Promise<void>;
}

/**
 * Optional private-network access, considered only after remote desktop is
 * stable. NetLink does not expose a router admin page or a whole private
 * network in the first release — this interface exists so that decision stays
 * an explicit, separate one.
 */
export interface PrivateNetworkProvider {
  readonly kind: 'wireguard';
  createPeer(input: { spaceId: string; deviceId: string }): Promise<{
    peerPublicKey: string;
    allowedIps: string[];
    endpoint: string;
  }>;
  revokePeer(input: { spaceId: string; deviceId: string }): Promise<void>;
}
