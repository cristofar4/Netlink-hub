import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { buildSigningInput, verifyEd25519 } from './agent-signature.guard';

/**
 * The signature scheme itself, isolated from HTTP.
 *
 * The Go agent and this verifier are two independent implementations of the
 * same format, so these tests pin the format rather than the code path.
 */
describe('agent request signatures', () => {
  function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // The wire format is the raw 32-byte key; DER SPKI carries a fixed
    // 12-byte prefix in front of it.
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, publicKeyB64: Buffer.from(spki.subarray(12)).toString('base64url') };
  }

  const body = Buffer.from(JSON.stringify({ deviceId: 'd1', status: 'online' }), 'utf8');
  const timestamp = '2026-08-07T12:00:00.000Z';
  const nonce = 'nonce-1';

  it('verifies a correctly signed request', () => {
    const { privateKey, publicKeyB64 } = keyPair();
    const input = buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, body);
    const signature = sign(null, input, privateKey).toString('base64url');

    expect(verifyEd25519(publicKeyB64, input, signature)).toBe(true);
  });

  it('rejects a signature made by a different key', () => {
    const signer = keyPair();
    const other = keyPair();
    const input = buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, body);
    const signature = sign(null, input, signer.privateKey).toString('base64url');

    expect(verifyEd25519(other.publicKeyB64, input, signature)).toBe(false);
  });

  it('rejects malformed keys and signatures without throwing', () => {
    const { privateKey, publicKeyB64 } = keyPair();
    const input = buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, body);
    const signature = sign(null, input, privateKey).toString('base64url');

    expect(verifyEd25519('not base64!!', input, signature)).toBe(false);
    expect(verifyEd25519('', input, signature)).toBe(false);
    expect(verifyEd25519(publicKeyB64, input, 'not base64!!')).toBe(false);
    expect(verifyEd25519(publicKeyB64, input, randomBytes(10).toString('base64url'))).toBe(false);
  });

  describe('signing input', () => {
    const base = buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, body);

    it('changes when any component changes', () => {
      const variants = {
        method: buildSigningInput('GET', '/agent/heartbeat', timestamp, nonce, body),
        path: buildSigningInput('POST', '/agent/enroll', timestamp, nonce, body),
        timestamp: buildSigningInput(
          'POST',
          '/agent/heartbeat',
          '2026-08-07T12:00:01.000Z',
          nonce,
          body,
        ),
        nonce: buildSigningInput('POST', '/agent/heartbeat', timestamp, 'nonce-2', body),
        body: buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, Buffer.from('{}')),
      };
      for (const [name, variant] of Object.entries(variants)) {
        expect(variant.equals(base)).toBe(false);
        void name;
      }
    });

    it('is stable for identical inputs', () => {
      expect(
        buildSigningInput('POST', '/agent/heartbeat', timestamp, nonce, body).equals(base),
      ).toBe(true);
    });

    it('normalises the method case', () => {
      expect(
        buildSigningInput('post', '/agent/heartbeat', timestamp, nonce, body).equals(base),
      ).toBe(true);
    });

    it('starts with the versioned domain separator', () => {
      // Binds a signature to this scheme, so one can never be replayed into a
      // different NetLink signing context.
      expect(base.toString('utf8').startsWith('netlink.agent.v1\n')).toBe(true);
    });
  });
});
