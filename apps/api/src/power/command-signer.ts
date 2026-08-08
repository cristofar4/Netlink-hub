import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { AppConfig } from '../config/configuration';

export type SignedCommand = {
  command: {
    id: string;
    action: string;
    deviceId: string;
    spaceId: string;
    issuedAt: string;
    expiresAt: string;
    nonce: string;
    requestedBy: string;
  };
  signature: string;
  keyId: string;
};

/**
 * Signs power commands with the control plane's Ed25519 key.
 *
 * The agent verifies against a key id, so keys can be rotated by publishing the
 * new public key to agents before retiring the old one.
 *
 * The signing input is built field by field in a fixed order, byte-identical to
 * `SigningInput` in `services/agent/pkg/command`. It is deliberately *not*
 * `JSON.stringify` of the struct: JSON key order and whitespace are not
 * guaranteed stable, and a signature over a representation that can shift is
 * not a signature.
 */
@Injectable()
export class CommandSigner implements OnModuleInit {
  private readonly logger = new Logger(CommandSigner.name);
  private privateKey!: KeyObject;
  private publicKeyB64!: string;
  private keyId!: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const configured = this.config.get('POWER_SIGNING_KEY', { infer: true });

    if (configured) {
      const raw = Buffer.from(configured, 'base64url');
      if (raw.length !== 32) {
        throw new Error('POWER_SIGNING_KEY must be a 32-byte Ed25519 seed, base64url encoded');
      }
      // Wrap the raw seed in the fixed PKCS#8 prefix for Ed25519 (RFC 8410),
      // because Node cannot import a bare seed.
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
      this.privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    } else {
      // A development key, regenerated on each boot. Every agent re-fetches the
      // public key on enrollment, so this is workable locally and useless to an
      // attacker; production supplies POWER_SIGNING_KEY and the config
      // validator refuses to start without it.
      const { privateKey } = generateKeyPairSync('ed25519');
      this.privateKey = privateKey;
      this.logger.warn(
        'No POWER_SIGNING_KEY set — using an ephemeral development key. Power commands will not verify across restarts.',
      );
    }

    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKeyB64 = Buffer.from(spki.subarray(12)).toString('base64url');
    // Deriving the id from the key means a rotated key automatically gets a new
    // id, so an agent can never verify a new command against an old key.
    this.keyId = `cp-${this.publicKeyB64.slice(0, 12)}`;
  }

  /** The public key agents verify against, and the id they look it up by. */
  publicKey(): { keyId: string; publicKey: string; algorithm: 'ed25519' } {
    return { keyId: this.keyId, publicKey: this.publicKeyB64, algorithm: 'ed25519' };
  }

  /** The key id, for signers of other message types that share this key. */
  id(): string {
    return this.keyId;
  }

  /**
   * The private key, for the remote-session grant signer.
   *
   * Exposed to one collaborator inside the process rather than duplicating the
   * key material or standing up a second key pair that agents would also have
   * to fetch, pin and rotate. Every message type signed with it carries its own
   * domain string, so the two can never be confused for one another.
   */
  privateKeyRef(): KeyObject {
    return this.privateKey;
  }

  sign(command: SignedCommand['command']): SignedCommand {
    const signature = sign(null, buildSigningInput(command), this.privateKey);
    return {
      command,
      signature: signature.toString('base64url'),
      keyId: this.keyId,
    };
  }
}

/**
 * Byte-identical to `command.SigningInput` in the Go agent.
 *
 * Any change here must be mirrored there. The agent's tests and the API's tests
 * both pin this format, so a one-sided change fails loudly.
 */
export function buildSigningInput(command: SignedCommand['command']): Buffer {
  return Buffer.from(
    [
      'netlink.power.v1',
      command.id,
      command.action,
      command.deviceId,
      command.spaceId,
      command.issuedAt,
      command.expiresAt,
      command.nonce,
      command.requestedBy,
    ].join('\n'),
    'utf8',
  );
}
