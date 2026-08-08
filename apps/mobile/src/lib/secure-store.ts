import * as SecureStore from 'expo-secure-store';

/**
 * Everything NetLink keeps on the phone, and where it keeps it.
 *
 * `expo-secure-store` is backed by the **Android Keystore** — the key that
 * encrypts these values is held by the operating system, is not extractable by
 * the app, and on most devices is enforced by hardware. That is a meaningfully
 * stronger place than the desktop app has, and it is why this app can do
 * something the desktop deliberately does not:
 *
 * **it persists the refresh token.**
 *
 * On Windows the desktop app keeps its refresh token in memory only, because
 * writing a long-lived credential to a file readable by any process running as
 * that user is worse than asking somebody to sign in again. On Android the
 * sandbox plus the Keystore change that calculation: another app cannot read
 * this, and a person who has to re-authenticate every time they open their
 * phone will stop using the product.
 *
 * The private device key is stored the same way and is never read out of here
 * for any purpose except signing.
 */

const KEYS = {
  installationId: 'netlink.installation.id',
  privateKey: 'netlink.device.private',
  publicKey: 'netlink.device.public',
  refreshToken: 'netlink.session.refresh',
  session: 'netlink.session.meta',
} as const;

export type SecureKey = keyof typeof KEYS;

/**
 * Requires the device to be unlocked before the value can be read.
 *
 * Without this, a value is readable while the phone is locked, which defeats
 * the point of storing it in the Keystore at all for a credential that grants
 * access to somebody's home computer.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function readSecure(key: SecureKey): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEYS[key], OPTIONS);
  } catch {
    // A read can fail if the Keystore entry was invalidated — which happens
    // when the user removes their screen lock, and on some devices when they
    // add a new fingerprint. Treating that as "not signed in" is correct: the
    // credential really is gone, and the honest response is to ask again.
    return null;
  }
}

export async function writeSecure(key: SecureKey, value: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS[key], value, OPTIONS);
}

export async function deleteSecure(key: SecureKey): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS[key], OPTIONS);
}

/**
 * Clears the session but keeps the device identity.
 *
 * Signing out must not discard the key pair. The key is *this installation's*
 * identity — the owner sees it in their device list and may have named it.
 * Throwing it away on sign-out would create a new device row on every
 * sign-in, and turn the device list into a graveyard.
 */
export async function clearSession(): Promise<void> {
  await Promise.all([deleteSecure('refreshToken'), deleteSecure('session')]);
}

/** Used when the owner revokes this device, or the server rejects its key. */
export async function forgetEverything(): Promise<void> {
  await Promise.all([
    deleteSecure('refreshToken'),
    deleteSecure('session'),
    deleteSecure('privateKey'),
    deleteSecure('publicKey'),
    deleteSecure('installationId'),
  ]);
}
