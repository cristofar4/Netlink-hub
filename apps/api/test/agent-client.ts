import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';

/**
 * A test agent that signs its requests exactly the way the Go agent does.
 *
 * The point of these tests is that the signature scheme is genuinely
 * interoperable — the shape of the signing input is duplicated here from the
 * Go implementation on purpose, so a change to one that is not mirrored in the
 * other shows up as a test failure rather than as a production outage.
 */
export class TestAgent {
  readonly installationId: string;
  readonly publicKeyB64: string;
  private readonly privateKey: KeyObject;

  constructor(installationId = randomUUID()) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.installationId = installationId;
    this.privateKey = privateKey;

    // Strip the 12-byte SPKI prefix to get the raw 32-byte key, which is what
    // the Go agent sends and what the server stores.
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    this.publicKeyB64 = Buffer.from(spki.subarray(12)).toString('base64url');
  }

  /** Signs and sends a POST, returning the supertest request for assertions. */
  post(http: Server, path: string, body: unknown, overrides: SignatureOverrides = {}) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = overrides.timestamp ?? new Date().toISOString();
    const nonce = overrides.nonce ?? randomBytes(16).toString('base64url');

    const signingInput = buildSigningInput('POST', path, timestamp, nonce, raw);
    const signature =
      overrides.signature ?? sign(null, signingInput, this.privateKey).toString('base64url');

    return (
      request(http)
        .post(`/api${path}`)
        .set('Content-Type', 'application/json')
        .set('X-NetLink-Installation', overrides.installationId ?? this.installationId)
        .set('X-NetLink-Public-Key', overrides.publicKey ?? this.publicKeyB64)
        .set('X-NetLink-Timestamp', timestamp)
        .set('X-NetLink-Nonce', nonce)
        .set('X-NetLink-Signature', signature)
        // Sent as a string, not a Buffer: superagent JSON-encodes a Buffer into
        // {"type":"Buffer","data":[…]}, which would not be the bytes we signed.
        .send(raw.toString('utf8'))
    );
  }

  /**
   * Produces a signature over `body` so a test can send *different* content
   * with it. This is how the "signature does not cover this body" case is
   * exercised without reaching into the agent's internals from the spec.
   */
  signOver(method: string, path: string, timestamp: string, nonce: string, body: Buffer): string {
    return sign(
      null,
      buildSigningInput(method, path, timestamp, nonce, body),
      this.privateKey,
    ).toString('base64url');
  }

  enrollBody(enrollmentToken: string, name = 'Home PC') {
    return {
      installationId: this.installationId,
      publicKey: this.publicKeyB64,
      publicKeyAlgorithm: 'ed25519' as const,
      name,
      platform: 'windows' as const,
      kind: 'agent' as const,
      appVersion: '0.1.0',
      enrollmentToken,
    };
  }

  heartbeatBody(deviceId: string, overrides: Record<string, unknown> = {}) {
    return {
      deviceId,
      status: 'online' as const,
      localIpAddress: '192.168.1.42',
      macAddress: '00:1A:2B:3C:4D:5E',
      wakeOnLanReady: true,
      isWakeHelper: false,
      appVersion: '0.1.0',
      sentAt: new Date().toISOString(),
      ...overrides,
    };
  }
}

export type SignatureOverrides = {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  publicKey?: string;
  installationId?: string;
};

/** Mirrors `client.SigningInput` in the Go agent, byte for byte. */
export function buildSigningInput(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest();
  return Buffer.from(
    [
      'netlink.agent.v1',
      method.toUpperCase(),
      path,
      timestamp,
      nonce,
      digest.toString('base64url'),
    ].join('\n'),
    'utf8',
  );
}
