import Constants from 'expo-constants';

/**
 * Where this build talks to, and what it is allowed to show.
 *
 * Two sources, checked in this order:
 *
 *   1. `EXPO_PUBLIC_NETLINK_API_URL` — an environment variable, read at bundle
 *      time. This is what you set while testing, because it means pointing the
 *      app at your own machine is one line in `.env` rather than an edit to a
 *      committed JSON file that you then have to remember to undo.
 *
 *   2. `extra.netlinkApiUrl` from `app.json` — what a real build ships with.
 *
 * There is deliberately **no setting inside the app** for this. A field that
 * accepts an arbitrary API URL is a phishing primitive: anyone who can persuade
 * somebody to paste a link into it gets their NetLink password and every code
 * that follows. The address a build talks to is fixed when it is built.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

const fromEnvironment = process.env.EXPO_PUBLIC_NETLINK_API_URL;
const fromConfig = typeof extra.netlinkApiUrl === 'string' ? extra.netlinkApiUrl : undefined;

export const API_URL = fromEnvironment || fromConfig || 'http://127.0.0.1:4000/api';

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

/**
 * True when this build is talking to a plain-HTTP address.
 *
 * Only legitimate while testing against a machine on your own network. The
 * Settings screen says so, because "it works on my Wi-Fi" is exactly the
 * configuration somebody forgets to change before handing the app to a friend,
 * and NetLink carries sign-in codes and session tokens.
 */
export const IS_INSECURE_TRANSPORT = API_URL.startsWith('http://');
