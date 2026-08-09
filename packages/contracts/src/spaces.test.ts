import { describe, expect, it } from 'vitest';
import { HEALTH_SIGNAL_IDS, HEALTH_SIGNAL_WEIGHTS, healthScore, type HealthSignal } from './spaces';

function signal(id: HealthSignal['id'], ok: boolean): HealthSignal {
  return { id, label: id, ok, detail: 'because', weight: HEALTH_SIGNAL_WEIGHTS[id] };
}

describe('network health', () => {
  it('scores the weights of the checks that passed', () => {
    const signals = [signal('computers.online', true), signal('wake.helper', false)];
    expect(healthScore(signals)).toBe(HEALTH_SIGNAL_WEIGHTS['computers.online']);
  });

  it('is 100 only when every check passes, and 0 when none do', () => {
    const all = HEALTH_SIGNAL_IDS.map((id) => signal(id, true));
    expect(healthScore(all)).toBe(100);
    expect(healthScore(HEALTH_SIGNAL_IDS.map((id) => signal(id, false)))).toBe(0);
  });

  it('has weights that add up to a hundred', () => {
    // If these ever drift, a perfectly healthy Space would score 97 or 103 and
    // the number on the dashboard would stop meaning "out of a hundred".
    const total = HEALTH_SIGNAL_IDS.reduce((sum, id) => sum + HEALTH_SIGNAL_WEIGHTS[id], 0);
    expect(total).toBe(100);
  });
});
