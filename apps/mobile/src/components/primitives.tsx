import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, fontSize, radius, space, touchTarget } from '../theme/tokens';

/**
 * The building blocks, matching the desktop component system.
 *
 * Deliberately a small set. The desktop app has nine components and this has
 * six, because a phone screen holds less and a component nobody uses is a
 * component that drifts.
 */

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  style,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.card, style]}>
      {(title || actions) && (
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            {title && <Text style={styles.cardTitle}>{title}</Text>}
            {subtitle && <Text style={styles.cardSubtitle}>{subtitle}</Text>}
          </View>
          {actions}
        </View>
      )}
      {children}
    </View>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
}) {
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.button,
        variantStyles[variant],
        pressed && !inactive ? styles.buttonPressed : null,
        inactive ? styles.buttonDisabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.textOnPrimary : colors.text} />
      ) : (
        <Text style={[styles.buttonLabel, variant === 'ghost' && styles.buttonLabelGhost]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export type Tone = 'online' | 'offline' | 'warning' | 'danger' | 'cyan' | 'neutral';

const TONE_COLOURS: Record<Tone, string> = {
  online: colors.success,
  offline: colors.offline,
  warning: colors.warning,
  danger: colors.danger,
  cyan: colors.cyan,
  neutral: colors.textMuted,
};

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <View style={styles.status} accessibilityRole="text" accessibilityLabel={label}>
      <View style={[styles.dot, { backgroundColor: TONE_COLOURS[tone] }]} />
      <Text style={styles.statusLabel}>{label}</Text>
    </View>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <View style={[styles.badge, { borderColor: TONE_COLOURS[tone] }]}>
      <Text style={[styles.badgeText, { color: TONE_COLOURS[tone] }]}>{children}</Text>
    </View>
  );
}

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: ReactNode;
}) {
  const colour =
    tone === 'danger'
      ? colors.danger
      : tone === 'warning'
        ? colors.warning
        : tone === 'success'
          ? colors.success
          : colors.cyan;

  return (
    <View
      // Announced by a screen reader when it appears, rather than sitting there
      // silently for somebody who cannot see it turn red.
      accessibilityLiveRegion="polite"
      style={[styles.alert, { borderColor: colour }]}
    >
      <Text style={[styles.alertText, { color: colour }]}>{children}</Text>
    </View>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{description}</Text>
    </View>
  );
}

const variantStyles: Record<ButtonVariant, ViewStyle> = {
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.border },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.danger },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: space[4] },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space[4],
    gap: space[3],
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  cardHeadText: { flex: 1, gap: space[1] },
  cardTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  cardSubtitle: { color: colors.textSecondary, fontSize: fontSize.sm },
  button: {
    minHeight: touchTarget,
    borderRadius: radius.base,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[5],
  },
  buttonPressed: { opacity: 0.85 },
  // Dimmed rather than hidden: a disabled control that explains itself is more
  // useful than one that vanishes and leaves a person wondering where it went.
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: colors.textOnPrimary, fontSize: fontSize.base, fontWeight: '600' },
  buttonLabelGhost: { color: colors.textSecondary },
  status: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: { width: 9, height: 9, borderRadius: radius.pill },
  statusLabel: { color: colors.textSecondary, fontSize: fontSize.xs },
  badge: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space[3],
    paddingVertical: space[1],
  },
  badgeText: { fontSize: fontSize.xs, fontWeight: '600' },
  alert: {
    borderWidth: 1,
    borderRadius: radius.base,
    padding: space[3],
    backgroundColor: colors.surfaceSunken,
  },
  alertText: { fontSize: fontSize.sm },
  empty: { alignItems: 'center', gap: space[2], paddingVertical: space[8] },
  emptyTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  emptyBody: { color: colors.textSecondary, fontSize: fontSize.sm, textAlign: 'center' },
});
