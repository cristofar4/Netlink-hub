import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fontSize, radius, space, touchTarget } from '../theme/tokens';
import { SHOW_DATA_POOL } from '../lib/config';
import { HomeScreen } from './HomeScreen';
import { DataPoolScreen } from './DataPoolScreen';
import { RemoteAccessScreen } from './RemoteAccessScreen';
import { PowerScreen } from './PowerScreen';
import { SettingsScreen } from './SettingsScreen';

/**
 * The signed-in shell.
 *
 * Four tabs, not ten. The desktop has ten sections because it is a control
 * surface someone sits in front of; a phone is something they pull out to do
 * one thing — usually "turn the computer at home on". Everything that does not
 * earn a permanent place on the bar is reachable from Home.
 *
 * A hand-rolled tab bar rather than a navigation library: a handful of fixed
 * destinations with no stacks, no deep links and no history is not a routing
 * problem, and a router would be more dependency than the whole shell.
 *
 * Power is not a tab of its own. It is where Remote Access and Home send you,
 * which keeps the bar to the four things people come here for while leaving the
 * most-used action one press from either.
 */

type TabId = 'home' | 'data' | 'remote' | 'settings';
type ScreenId = TabId | 'power';

const ALL_TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'home', label: 'Home', icon: '⌂' },
  // Hidden in release builds: the only provider today is a Demo Provider whose
  // usage is generated, and shipping simulated network usage to a store would
  // misrepresent what the app does. See lib/config.ts.
  { id: 'data', label: 'Data Pool', icon: '◔' },
  { id: 'remote', label: 'Remote', icon: '▭' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function Shell() {
  const [screen, setScreen] = useState<ScreenId>('home');
  const insets = useSafeAreaInsets();

  const tabs = ALL_TABS.filter((tab) => tab.id !== 'data' || SHOW_DATA_POOL);
  // Power is opened from another tab, so the bar keeps Remote highlighted
  // rather than showing nothing selected.
  const activeTab: TabId = screen === 'power' ? 'remote' : screen;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.body}>
        {screen === 'home' && (
          <HomeScreen
            onOpenTab={(tab) => setScreen(tab === 'data' && !SHOW_DATA_POOL ? 'home' : tab)}
          />
        )}
        {screen === 'data' && <DataPoolScreen />}
        {screen === 'remote' && <RemoteAccessScreen onOpenPower={() => setScreen('power')} />}
        {screen === 'power' && <PowerScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </View>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, space[2]) }]}>
        {tabs.map((entry) => {
          const selected = entry.id === activeTab;
          return (
            <Pressable
              key={entry.id}
              onPress={() => setScreen(entry.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={entry.label}
              style={styles.tab}
            >
              <Text style={[styles.tabIcon, selected && styles.tabIconOn]}>{entry.icon}</Text>
              <Text style={[styles.tabLabel, selected && styles.tabLabelOn]}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Re-exported so a screen can ask whether to offer the Data Pool at all. */
export const dataPoolVisible = SHOW_DATA_POOL;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgRaised,
    paddingTop: space[2],
  },
  tab: {
    flex: 1,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    borderRadius: radius.base,
  },
  tabIcon: { color: colors.textMuted, fontSize: fontSize.xl },
  tabIconOn: { color: colors.cyan },
  tabLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  tabLabelOn: { color: colors.text, fontWeight: '600' },
});
