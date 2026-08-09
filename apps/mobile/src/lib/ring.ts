/**
 * The arithmetic behind the data ring.
 *
 * Kept out of the component, and out of anything that imports React Native, so
 * it can be tested in Node — the mobile test runner deliberately does not stand
 * up a React Native renderer to check a number.
 */

/**
 * Splits a percentage into the rotation of each half of the ring.
 *
 * The ring is drawn as two rotated half-discs behind a mask. The right half
 * sweeps the first 180°; past halfway it stays put and the left half takes
 * over. Anything outside 0–100 is clamped rather than allowed to spin a disc
 * past the end of the track.
 */
export function ringAngles(percent: number): { right: number; left: number } {
  const safe = Math.min(Math.max(Number.isFinite(percent) ? percent : 0, 0), 100);
  const degrees = safe * 3.6;
  return {
    right: Math.min(degrees, 180),
    left: Math.max(degrees - 180, 0),
  };
}
