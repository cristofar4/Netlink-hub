import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as Crypto from 'expo-crypto';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { readSecure, writeSecure } from './secure-store';

/**
 * This installation's identity.
 *
 * Every NetLink installation generates its own Ed25519 key pair. There is no
 * shared key, no key derived from a user id, and no key that travels with an
 * account — which is what makes "revoke this phone" mean something specific
 * rather than "sign out everywhere".
 *
 * The private half lives in the Android Keystore, is never transmitted, never
 * logged, and is never returned by any function here. Only the public half
 * reaches the server.
 */

// @noble/ed25519 keeps its hash pluggable so it can stay dependency-free.
// React Native has no WebCrypto, so the pure-JS SHA-512 from @noble/hashes is
// wired in here — once, at module load, before any key is generated.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(ed25519.etc.concatBytes(...messages));

export type DeviceIdentity = {
  installationId: string;
  /** Base64url, raw 32 bytes — the format the control plane expects. */
  publicKey: string;
};

/**
 * Loads this installation's identity, creating it on first run.
 *
 * The installation id is a random UUID rather than anything derived from
 * hardware. Android's device identifiers are restricted, are a privacy concern
 * in their own right, and would make two installations on one phone
 * indistinguishable — which the owner's device list should not be.
 */
export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const existingId = await readSecure('installationId');
  const existingPublic = await readSecure('publicKey');
  const existingPrivate = await readSecure('privateKey');

  if (existingId && existingPublic && existingPrivate) {
    return { installationId: existingId, publicKey: existingPublic };
  }

  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);

  const installationId = Crypto.randomUUID();
  const publicKeyB64 = toBase64Url(publicKey);

  await writeSecure('privateKey', toBase64Url(privateKey));
  await writeSecure('publicKey', publicKeyB64);
  await writeSecure('installationId', installationId);

  return { installationId, publicKey: publicKeyB64 };
}

/**
 * Signs a message with this installation's key.
 *
 * The private key is read, used, and goes out of scope. It is deliberately not
 * cached in a module variable: a long-lived copy on the JavaScript heap is a
 * strictly worse place for it than the Keystore.
 */
export async function sign(message: Uint8Array): Promise<string> {
  const stored = await readSecure('privateKey');
  if (!stored) throw new Error('This installation has no signing key.');
  const signature = await ed25519.signAsync(message, fromBase64Url(stored));
  return toBase64Url(signature);
}

/**
 * A human-readable name for this phone, shown in the owner's device list.
 *
 * Deliberately not the hardware model. "Pixel 8 Pro" is more identifying than a
 * list the owner reads to answer "which of my devices is this?" needs to be,
 * and they can rename it to whatever actually helps them.
 */
export function defaultDeviceName(): string {
  const suffix = Platform.OS === 'android' ? 'Android phone' : 'Mobile device';
  return `${Application.applicationName ?? 'NetLink'} on ${suffix}`;
}

export function devicePlatform(): 'android' | 'ios' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

// ---------------------------------------------------------------------------
// base64url without padding — the encoding the control plane uses throughout.
//
// Hand-written because React Native has no `Buffer` and its `btoa` is a
// polyfill that produces standard base64, which would need translating anyway.
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];

    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 63];
  }
  return out;
}

export function fromBase64Url(value: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let index = 0; index < ALPHABET.length; index += 1) lookup.set(ALPHABET[index], index);

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    const digit = lookup.get(character);
    if (digit === undefined) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
