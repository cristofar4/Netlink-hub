import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fontSize, radius, space, touchTarget } from '../theme/tokens';
import { SHOW_DATA_POOL } from '../lib/config';
import { PowerScreen } from './PowerScreen';
import { SpacesScreen } from './SpacesScreen';
import { ActivityScreen } from './ActivityScreen';
import { SettingsScreen } from './SettingsScreen';

/**
 * The signed-in shell.
 *
 * Four tabs, not ten. The desktop has ten sections because it is a control
 * surface someone sits in front of; a phone is something they pull out to do
 * one thing — usually "turn the computer at home on". Everything that does not
 * earn a permanent place on a five-tab bar lives inside My Spaces.
 *
 * A hand-rolled tab bar rather than a navigation library: four fixed
 * destinations with no stacks, no deep links and no history is not a routing
 * problem, and a router would be more dependency than the whole shell.
 */

const TABS = [
  { id: 'spaces', label: 'Spaces', icon: '◈' },
  { id: 'power', label: 'Power', icon: '⏻' },
  { id: 'activity', label: 'Activity', icon: '☰' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function Shell() {
  const [tab, setTab] = useState<TabId>('spaces');
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.body}>
        {tab === 'spaces' && <SpacesScreen onOpenPower={() => setTab('power')} />}
        {tab === 'power' && <PowerScreen />}
        {tab === 'activity' && <ActivityScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, space[2]) }]}>
        {TABS.map((entry) => {
          const selected = entry.id === tab;
          return (
            <Pressable
              key={entry.id}
              onPress={() => setTab(entry.id)}
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
