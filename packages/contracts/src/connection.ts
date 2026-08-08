import type { ConnectionStrategy } from './remote';

/**
 * Connection quality, and the one connection feature still ahead of us.
 *
 * This file used to hold placeholder signalling interfaces for Phase 6. Phase 6
 * is built, so those have been replaced by the real ones in `remote.ts` rather
 * than left beside them — two descriptions of the same thing is how the two
 * drift apart.
 */

/**
 * What the viewer measures about a live session.
 *
 * Reported to the person watching so a slow connection is explained rather than
 * merely felt. Every field is nullable because a statistic that has not been
 * gathered yet should read as "not known", never as zero.
 */
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

/**
 * Optional private-network access, deliberately still an interface.
 *
 * NetLink gives access to a computer, some files and a printer. Handing someone
 * a route onto the whole home network is a categorically larger grant, and
 * bolting it onto remote desktop because the plumbing happens to be nearby is
 * exactly how that decision gets made by accident. Keeping it here, unbuilt,
 * keeps it an explicit choice.
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
