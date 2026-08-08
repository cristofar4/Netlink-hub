/**
 * base64url without padding — the encoding the control plane uses throughout.
 *
 * Its own module, with no React Native imports, for two reasons. It is pure
 * data manipulation with no business being coupled to a platform, and keeping
 * it separate means it can be tested in Node against `Buffer.toString('base64url')`
 * — which is the implementation the *server* uses, and therefore the only
 * meaningful thing to check it against.
 *
 * Hand-written because React Native has no `Buffer`, and its `btoa` polyfill
 * produces standard base64 with `+`, `/` and `=` — all three of which the
 * control plane's schemas reject.
 */

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
    // Characters outside the alphabet are skipped rather than throwing: a
    // stored key that picked up a stray newline should still decode, and a
    // genuinely corrupt one fails later at signature verification, which is
    // where a wrong key should be caught anyway.
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
