import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from './src/theme/tokens';
import { SessionProvider, useSession } from './src/state/session';
import { SpaceProvider } from './src/state/space';
import { AuthFlow } from './src/screens/AuthFlow';
import { Shell } from './src/screens/Shell';

/**
 * The app.
 *
 * Two states and nothing in between: signed in, or not. While the stored
 * session is being checked the app shows a spinner rather than the sign-in
 * screen — flashing "sign in" at somebody who is already signed in reads as a
 * bug, and on a phone that check involves a Keystore read and a token refresh,
 * so it is not instant.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <SessionProvider>
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { session, restoring } = useSession();

  if (restoring) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.cyan} />
      </View>
    );
  }

  if (!session) return <AuthFlow />;

  return (
    <SpaceProvider>
      <Shell />
    </SpaceProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
