import { StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, space } from '../theme/tokens';
import { ringAngles } from '../lib/ring';

/**
 * The data ring, without a drawing library.
 *
 * React Native has no SVG in the box, and pulling one in for a single circle
 * would add a native module to every build. Instead the ring is two rotated
 * half-discs behind a mask — the standard trick, and the reason the angle
 * arithmetic below is separated out and tested rather than inlined.
 *
 * The figure in the middle is text, so the value is readable whether or not the
 * ring renders as intended on a given device.
 */

export type GaugeTone = 'primary' | 'warning' | 'danger';

const TONE_COLOURS: Record<GaugeTone, string> = {
  primary: colors.cyan,
  warning: colors.warning,
  danger: colors.danger,
};

export function Gauge({
  percent,
  value,
  unit,
  caption,
  footnote,
  size = 200,
  thickness = 12,
  tone = 'primary',
  accessibilityLabel,
}: {
  percent: number;
  value: string;
  unit?: string;
  caption?: string;
  footnote?: string;
  size?: number;
  thickness?: number;
  tone?: GaugeTone;
  accessibilityLabel: string;
}) {
  const angles = ringAngles(percent);
  const colour = TONE_COLOURS[tone];
  const half = size / 2;

  const discBase = {
    position: 'absolute' as const,
    width: size,
    height: size,
    borderRadius: half,
    borderWidth: thickness,
    borderTopColor: colour,
    borderRightColor: colour,
    // The other two edges stay clear: each half only ever shows a quarter-turn
    // of colour at a time, and the rotation carries it round.
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
  };

  return (
    <View
      style={[styles.root, { width: size, height: size }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
    >
      <View
        style={[
          styles.track,
          { width: size, height: size, borderRadius: half, borderWidth: thickness },
        ]}
      />

      {/* Right half of the ring: the first 180 degrees. */}
      <View style={[styles.mask, { width: half, height: size, right: 0 }]}>
        <View
          style={[discBase, { right: 0, transform: [{ rotate: `${angles.right - 45}deg` }] }]}
        />
      </View>

      {/* Left half: only once the value passes halfway. */}
      {angles.left > 0 && (
        <View style={[styles.mask, { width: half, height: size, left: 0 }]}>
          <View
            style={[discBase, { left: 0, transform: [{ rotate: `${angles.left + 135}deg` }] }]}
          />
        </View>
      )}

      <View style={styles.readout}>
        <View style={styles.valueRow}>
          <Text style={styles.value}>{value}</Text>
          {unit && <Text style={styles.unit}>{unit}</Text>}
        </View>
        {caption && <Text style={styles.caption}>{caption}</Text>}
        {footnote && <Text style={styles.footnote}>{footnote}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  track: {
    position: 'absolute',
    borderColor: 'rgba(94, 132, 199, 0.18)',
  },
  mask: { position: 'absolute', overflow: 'hidden' },
  readout: { alignItems: 'center', gap: 2 },
  valueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[1] },
  value: { color: colors.text, fontSize: 40, fontWeight: '700', lineHeight: 44 },
  unit: { color: colors.textSecondary, fontSize: fontSize.lg, fontWeight: '600', paddingBottom: 6 },
  caption: { color: colors.textSecondary, fontSize: fontSize.base },
  footnote: { color: colors.textMuted, fontSize: fontSize.sm, marginTop: space[1] },
});
