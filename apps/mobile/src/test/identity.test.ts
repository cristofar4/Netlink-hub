import { describe, expect, it } from 'vitest';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { fromBase64Url, toBase64Url } from '../lib/base64url';

/*
The device identity crypto, exercised outside React Native.

`identity.ts` cannot be imported whole here — it pulls in expo-secure-store and
react-native, neither of which exists in Node. What *can* be tested is the part
that would silently break: the base64url encoding the control plane parses, and
the Ed25519 wiring that depends on a SHA-512 being supplied by hand because
React Native has no WebCrypto.

That wiring is the fragile bit. If `@noble/hashes` moves its entry points, the
app still bundles and still starts, and then every signature it produces is
wrong — which presents as "the server rejects my device" and sends somebody
looking at the server.
*/

// The same wiring identity.ts does at module load.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(ed25519.etc.concatBytes(...messages));

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all));
  });

  it('round-trips every length up to a full key', () => {
    // Padding boundaries are where a hand-written encoder goes wrong, so every
    // length modulo 3 is covered rather than a convenient one.
    for (let length = 0; length <= 64; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 7 + 3) % 256);
      const decoded = fromBase64Url(toBase64Url(bytes));
      expect(Array.from(decoded), `length ${length}`).toEqual(Array.from(bytes));
    }
  });

  it('produces url-safe output with no padding', () => {
    // The control plane parses base64url. A "+", "/" or "=" would be rejected,
    // or worse, silently decoded to different bytes.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const bytes = Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("matches Node's own base64url, byte for byte", () => {
    // The real cross-check: Node has an implementation, the control plane uses
    // it, and this one is hand-written because React Native has no Buffer.
    for (let length = 1; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 13 + 1) % 256);
      const mine = toBase64Url(bytes);
      const nodes = Buffer.from(bytes).toString('base64url');
      expect(mine, `length ${length}`).toBe(nodes);
    }
  });
});

describe('device signing', () => {
  it('produces a signature the control plane can verify', async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    const message = new TextEncoder().encode('netlink.agent.v1\nPOST\n/agent/heartbeat');
    const signature = await ed25519.signAsync(message, privateKey);

    expect(await ed25519.verifyAsync(signature, message, publicKey)).toBe(true);
  });

  it('produces a 32-byte public key, which is what the server expects', async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    expect(publicKey.length).toBe(32);
    // Encoded, that is 43 base64url characters — the length the server's schema
    // requires. A shorter one would be refused at registration.
    expect(toBase64Url(publicKey).length).toBe(43);
  });

  it('refuses a signature over a different message', async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    const signature = await ed25519.signAsync(new TextEncoder().encode('one'), privateKey);
    const other = new TextEncoder().encode('two');

    expect(await ed25519.verifyAsync(signature, other, publicKey)).toBe(false);
  });

  it('gives every installation a different key', async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const publicKey = await ed25519.getPublicKeyAsync(ed25519.utils.randomPrivateKey());
      const encoded = toBase64Url(publicKey);
      expect(seen.has(encoded)).toBe(false);
      seen.add(encoded);
    }
  });

  it('survives a key round-tripping through storage', async () => {
    // The private key is stored base64url in the Keychain and read back before
    // every signature, so the encoding is on the signing path itself.
    const privateKey = ed25519.utils.randomPrivateKey();
    const restored = fromBase64Url(toBase64Url(privateKey));

    const message = new TextEncoder().encode('after a restart');
    const signature = await ed25519.signAsync(message, restored);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    expect(await ed25519.verifyAsync(signature, message, publicKey)).toBe(true);
  });
});
