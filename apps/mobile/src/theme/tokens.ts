/**
 * NetLink design tokens for React Native.
 *
 * The same palette, spacing and type scale as `packages/ui/src/tokens.css`,
 * expressed as objects because React Native has no CSS custom properties.
 *
 * These are kept as a deliberate port rather than a generated file. A generator
 * would have to understand `rgba()`, `cubic-bezier` and media queries — and the
 * two platforms genuinely differ in places (there are no shadows-by-string on
 * Android, and touch targets have a minimum size the desktop does not need).
 * A test asserts the shared values match, so drift fails loudly.
 */

export const colors = {
  // Ground
  bg: '#060b18',
  bgDeep: '#04070f',
  bgRaised: '#0a1226',

  // Surfaces: dark blue glass
  surface: 'rgba(16, 28, 54, 0.72)',
  surfaceStrong: 'rgba(20, 35, 66, 0.92)',
  surfaceHover: 'rgba(24, 42, 78, 0.85)',
  surfaceSunken: 'rgba(8, 16, 33, 0.72)',
  border: 'rgba(94, 132, 199, 0.22)',
  borderStrong: 'rgba(120, 165, 240, 0.38)',

  // Brand: electric blue for actions, cyan reserved for connections
  primary: '#2f6bff',
  primaryHover: '#4880ff',
  primaryActive: '#1d55e0',
  primarySoft: 'rgba(47, 107, 255, 0.16)',
  primaryRing: 'rgba(47, 107, 255, 0.45)',

  cyan: '#22d3ee',
  cyanDim: 'rgba(34, 211, 238, 0.35)',
  cyanFaint: 'rgba(34, 211, 238, 0.12)',

  // Status. Green is secure and online. Red is for danger only — never
  // decoration, and never for a merely-offline state.
  success: '#34d399',
  successSoft: 'rgba(52, 211, 153, 0.15)',
  warning: '#fbbf24',
  warningSoft: 'rgba(251, 191, 36, 0.15)',
  danger: '#f43f5e',
  dangerHover: '#fb5570',
  dangerSoft: 'rgba(244, 63, 94, 0.14)',
  // Offline is absence, not alarm.
  offline: '#64748b',
  offlineSoft: 'rgba(100, 116, 139, 0.18)',

  // Text
  text: '#f2f6ff',
  textSecondary: '#a3b5d4',
  textMuted: '#6f84a8',
  textOnPrimary: '#ffffff',
} as const;

export const radius = {
  sm: 8,
  base: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/** 4px base, same steps as the desktop. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

/**
 * Type scale.
 *
 * Every step is two points larger than the desktop's. A phone is held further
 * from the eye than a monitor is, and 13px body text that reads comfortably in
 * a desktop window is genuinely hard to read on a phone in daylight.
 */
export const fontSize = {
  xs: 13,
  sm: 15,
  base: 16,
  lg: 18,
  xl: 22,
  '2xl': 28,
  '3xl': 36,
} as const;

export const duration = {
  fast: 120,
  base: 200,
  slow: 320,
  /** Ambient loops. Set to 0 under reduced motion. */
  pulse: 2400,
} as const;

/**
 * The minimum size of anything a finger has to hit.
 *
 * 48dp is the Android accessibility guideline, and it has no desktop
 * equivalent — a mouse pointer is one pixel. Every pressable in this app is at
 * least this tall, which is why the button styles set a height rather than
 * relying on padding around whatever text happens to be inside.
 */
export const touchTarget = 48;

export const theme = { colors, radius, space, fontSize, duration, touchTarget } as const;
export type Theme = typeof theme;
