import { describe, expect, it } from 'vitest';
import { ringAngles } from '../lib/ring';

/**
 * The ring is two rotated half-discs, so the arithmetic is the whole component.
 * Everything a person sees depends on these two numbers being right.
 */
describe('ringAngles', () => {
  it('sweeps the right half first, then hands over to the left', () => {
    expect(ringAngles(0)).toEqual({ right: 0, left: 0 });
    expect(ringAngles(25)).toEqual({ right: 90, left: 0 });
    expect(ringAngles(50)).toEqual({ right: 180, left: 0 });
    expect(ringAngles(75)).toEqual({ right: 180, left: 90 });
    expect(ringAngles(100)).toEqual({ right: 180, left: 180 });
  });

  it('clamps rather than spinning the discs past the ends of the track', () => {
    expect(ringAngles(140)).toEqual({ right: 180, left: 180 });
    expect(ringAngles(-20)).toEqual({ right: 0, left: 0 });
    expect(ringAngles(Number.NaN)).toEqual({ right: 0, left: 0 });
  });
});
