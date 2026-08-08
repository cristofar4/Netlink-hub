import { Injectable } from '@nestjs/common';
import { sign } from 'node:crypto';
import type { RemoteGrant, RemoteGrantEnvelope } from '@netlink/contracts';
import { CommandSigner } from '../power/command-signer';

/**
 * Signs the grant that lets an agent accept a remote desktop session.
 *
 * This exists because of one fact about the architecture: input events travel
 * directly from the viewer to the host over WebRTC, so the control plane never
 * sees them and cannot refuse them. The only party that can refuse to move the
 * mouse is the agent — and it will only do so if it can tell, without asking
 * anyone, that this session was authorised as view-only.
 *
 * So the mode is sealed inside a signature. A viewer who edits `mode` in their
 * own copy produces a grant that fails verification on the host.
 *
 * The key is the control plane's existing Ed25519 signing key, reused rather
 * than duplicated: agents already fetch and pin it for power commands, and a
 * second key would be a second thing to rotate and a second thing to get wrong.
 * The domain string at the head of the signing input is what keeps the two
 * message types from being confusable — a power command can never be replayed
 * as a session grant, and vice versa.
 */
@Injectable()
export class GrantSigner {
  constructor(private readonly commandSigner: CommandSigner) {}

  sign(grant: RemoteGrant): RemoteGrantEnvelope {
    const signature = sign(null, buildGrantSigningInput(grant), this.commandSigner.privateKeyRef());
    return { grant, signature: signature.toString('base64url'), keyId: this.commandSigner.id() };
  }
}

/**
 * Byte-identical to `remotegrant.SigningInput` in the Go agent.
 *
 * Built field by field in a fixed order rather than by serialising the object:
 * JSON key order and whitespace are not guaranteed stable, and a signature over
 * a representation that can shift is not a signature. Both sides have a test
 * that pins the exact expected bytes, so a one-sided change fails loudly rather
 * than at three in the morning on someone's desktop.
 */
export function buildGrantSigningInput(grant: RemoteGrant): Buffer {
  return Buffer.from(
    [
      'netlink.remote.v1',
      grant.sessionId,
      grant.spaceId,
      grant.agentId,
      grant.mode,
      grant.requestedBy,
      grant.issuedAt,
      grant.expiresAt,
      grant.nonce,
    ].join('\n'),
    'utf8',
  );
}
