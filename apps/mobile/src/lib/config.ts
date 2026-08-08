import Constants from 'expo-constants';

/**
 * Where this build talks to, and what it is allowed to show.
 *
 * `netlinkApiUrl` comes from `app.json` so a build points at one control plane
 * and cannot be repointed at runtime — a settings field that accepts an
 * arbitrary API URL is a phishing primitive, not a feature.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

export const API_URL =
  typeof extra.netlinkApiUrl === 'string' ? extra.netlinkApiUrl : 'http://127.0.0.1:4000/api';

/**
 * Whether the Data Pool section is shown at all.
 *
 * Off in release builds, and this is a compliance decision rather than a
 * product one. The only provider that exists today is a Demo Provider whose
 * usage numbers are generated, and shipping a screen of simulated network usage
 * to the Play Store would be misrepresenting the app's functionality. That is a
 * policy violation with account-level consequences, not a cosmetic issue.
 *
 * The code is complete and tested. It becomes visible the day a real carrier
 * adapter exists, by flipping this and nothing else.
 */
export const SHOW_DATA_POOL = __DEV__;

/** Shown on the settings screen so a tester can see which build they have. */
export const BUILD_KIND = __DEV__ ? 'development' : 'release';
