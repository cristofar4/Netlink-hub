import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BarChart, Meter, RadialGauge, Toggle, clampPercent, niceCeiling } from '@netlink/ui';
import { greeting } from '../screens/Shell';
import { splitAmount } from '../screens/DataPoolScreen';

/**
 * The instruments have one job: never show a number that is not the number.
 *
 * These tests care about what a person reads off the component — the text and
 * the accessible name — rather than the shape of the SVG behind it.
 */

describe('niceCeiling', () => {
  it('rounds an axis up to something a person can divide by eye', () => {
    expect(niceCeiling(17.3)).toBe(20);
    expect(niceCeiling(4.2)).toBe(5);
    expect(niceCeiling(0.7)).toBe(1);
    expect(niceCeiling(6_400_000_000)).toBe(10_000_000_000);
  });

  it('leaves an empty series with a flat axis rather than an invented one', () => {
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(-5)).toBe(0);
    expect(niceCeiling(Number.NaN)).toBe(0);
  });
});

describe('clampPercent', () => {
  it('keeps a value on the dial', () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(-12)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('RadialGauge', () => {
  it('shows the figure in text, not only as an arc', () => {
    render(
      <RadialGauge
        percent={64.8}
        value="64.8"
        unit="GB"
        caption="remaining"
        footnote="of 100 GB"
      />,
    );
    expect(screen.getByText('64.8')).toBeInTheDocument();
    expect(screen.getByText('GB')).toBeInTheDocument();
    expect(screen.getByText('remaining')).toBeInTheDocument();
    expect(screen.getByText('of 100 GB')).toBeInTheDocument();
  });

  it('reads out a sentence a screen reader can use', () => {
    render(
      <RadialGauge
        percent={12}
        value="12"
        unit="GB"
        caption="remaining"
        label="12 GB remaining of 100 GB"
      />,
    );
    expect(screen.getByRole('img', { name: '12 GB remaining of 100 GB' })).toBeInTheDocument();
  });
});

describe('BarChart', () => {
  const bars = [
    { key: 'a', value: 0, title: 'nothing on Monday', label: 'Mon' },
    { key: 'b', value: 4, title: '4 on Tuesday' },
  ];

  it('describes the whole series to a screen reader', () => {
    render(<BarChart bars={bars} formatTick={(v) => `${v}`} caption="Four in total" />);
    expect(screen.getByRole('img', { name: 'Four in total' })).toBeInTheDocument();
  });

  it('says so when a window has no usage instead of drawing an empty frame', () => {
    render(
      <BarChart
        bars={[{ key: 'a', value: 0, title: 'nothing' }]}
        formatTick={(v) => `${v}`}
        caption="Nothing this week"
        emptyMessage="No usage recorded in this window."
      />,
    );
    expect(screen.getByText('No usage recorded in this window.')).toBeInTheDocument();
  });

  it('keeps a slot for every day, including the quiet ones', () => {
    const { container } = render(
      <BarChart bars={bars} formatTick={(v) => `${v}`} caption="Two days" />,
    );
    expect(container.querySelectorAll('.nl-chart__slot')).toHaveLength(2);
  });
});

describe('Meter', () => {
  it('reports its position to assistive technology', () => {
    render(<Meter percent={37.4} ariaLabel="Emily has used 18.7 GB of 30 GB" />);
    const bar = screen.getByRole('progressbar', { name: 'Emily has used 18.7 GB of 30 GB' });
    expect(bar).toHaveAttribute('aria-valuenow', '37');
  });
});

describe('Toggle', () => {
  it('is a switch, and says which way it is set in words', () => {
    render(
      <Toggle checked onChange={() => undefined} label="Connection alerts" stateLabel="Enabled" />,
    );
    expect(screen.getByRole('switch', { name: 'Connection alerts' })).toBeChecked();
    // The state is in text as well as in the knob's position.
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('reports the value the caller should move to', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function Harness() {
      const [checked, setChecked] = useState(false);
      return (
        <Toggle
          checked={checked}
          onChange={(next) => {
            onChange(next);
            setChecked(next);
          }}
          label="Biometric login"
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('switch', { name: 'Biometric login' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch', { name: 'Biometric login' })).toBeChecked();
  });

  it('cannot be moved when it is disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} disabled onChange={onChange} label="Data usage alerts" />);
    await user.click(screen.getByRole('switch', { name: 'Data usage alerts' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('greeting', () => {
  it('follows the clock and uses the first name', () => {
    expect(greeting('Christopher Praise', new Date('2026-05-20T09:41:00'))).toBe(
      'Good morning, Christopher',
    );
    expect(greeting('Christopher', new Date('2026-05-20T13:00:00'))).toBe(
      'Good afternoon, Christopher',
    );
    expect(greeting('Christopher', new Date('2026-05-20T20:00:00'))).toBe(
      'Good evening, Christopher',
    );
  });

  it('greets someone whose name is not loaded yet without a trailing comma', () => {
    expect(greeting(undefined, new Date('2026-05-20T09:41:00'))).toBe('Good morning');
  });
});

describe('splitAmount', () => {
  it('separates the figure from its unit so the two are set differently', () => {
    expect(splitAmount(64_800_000_000)).toEqual({ value: '64.8', unit: 'GB' });
    expect(splitAmount('512')).toEqual({ value: '512', unit: 'B' });
  });
});
