import { describe, expect, it } from 'vitest';
import { projectDaysRemaining } from './data';

describe('projectDaysRemaining', () => {
  it('divides what is left by what a day costs', () => {
    expect(projectDaysRemaining('100', '10')).toBe(10);
    // Rounds down: nine and a half days of data is nine days you can count on.
    expect(projectDaysRemaining('95', '10')).toBe(9);
  });

  it('says nothing rather than guessing', () => {
    // No usage history yet — any number here would be an invention.
    expect(projectDaysRemaining('100', '0')).toBeNull();
    // Nothing left to project.
    expect(projectDaysRemaining('0', '10')).toBeNull();
  });

  it('handles allowances larger than a float can hold exactly', () => {
    // Two petabytes at one terabyte a day. Done in doubles this drifts; the
    // whole reason the wire format is a decimal string is to avoid that.
    const remaining = 2_000_000_000_000_000n.toString();
    const perDay = 1_000_000_000_000n.toString();
    expect(projectDaysRemaining(remaining, perDay)).toBe(2000);
  });
});
