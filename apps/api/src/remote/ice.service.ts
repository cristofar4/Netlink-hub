import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { IceServer } from '@netlink/contracts';
import type { AppConfig } from '../config/configuration';

/**
 * Issues the ICE servers a peer needs to connect.
 *
 * STUN is harmless to hand out: it only reflects a peer's own public address
 * back at it and never carries media.
 *
 * TURN is different — it relays real traffic, so a long-lived credential is a
 * free proxy for anyone who finds it. These are minted with coturn's REST
 * convention: the username *is* the expiry, and the password is an HMAC of the
 * username under a secret only the TURN server and this process know. That
 * makes a leaked pair worthless within minutes and impossible to extend, and it
 * means no credential is ever stored anywhere.
 */
@Injectable()
export class IceService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** True when a relay is available at all, so the UI can be honest about it. */
  relayAvailable(): boolean {
    return this.turnUrls().length > 0 && Boolean(this.config.get('TURN_SECRET', { infer: true }));
  }

  /**
   * ICE servers for one session.
   *
   * The session id is folded into the TURN username so a credential issued for
   * one session is attributable, and revoking is a matter of waiting out the
   * TTL rather than hoping nobody kept a copy.
   */
  serversFor(sessionId: string, now: Date = new Date()): IceServer[] {
    const servers: IceServer[] = [];

    const stun = this.stunUrls();
    if (stun.length > 0) servers.push({ urls: stun });

    const turn = this.turnUrls();
    const secret = this.config.get('TURN_SECRET', { infer: true });
    if (turn.length > 0 && secret) {
      const ttl = this.config.get('TURN_CREDENTIAL_TTL_SECONDS', { infer: true });
      const expiry = Math.floor(now.getTime() / 1000) + ttl;
      const username = `${expiry}:${sessionId}`;
      servers.push({
        urls: turn,
        username,
        // coturn's long-term-credential REST API: SHA-1 is specified by the
        // protocol here, not chosen. It authenticates a short-lived username to
        // a server that already knows the secret; it is not hashing anything
        // secret or long-lived.
        credential: createHmac('sha1', secret).update(username).digest('base64'),
      });
    }

    return servers;
  }

  private stunUrls(): string[] {
    return splitUrls(this.config.get('STUN_URLS', { infer: true }));
  }

  private turnUrls(): string[] {
    return splitUrls(this.config.get('TURN_URLS', { infer: true }));
  }
}

function splitUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}
