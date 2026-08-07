import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OtpInput } from '@netlink/ui';

/** Wrapper so the tests exercise the component the way the app uses it. */
function Harness({ onComplete }: { onComplete?: (value: string) => void }) {
  const [value, setValue] = useState('');
  return <OtpInput value={value} onChange={setValue} onComplete={onComplete} autoFocus />;
}

describe('OtpInput', () => {
  it('renders one box per digit, each labelled', () => {
    render(<Harness />);
    const cells = screen.getAllByRole('textbox');
    expect(cells).toHaveLength(6);
    expect(screen.getByLabelText('Digit 1 of 6')).toBeInTheDocument();
    expect(screen.getByLabelText('Digit 6 of 6')).toBeInTheDocument();
  });

  it('advances as digits are typed and fires onComplete at six', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);

    await user.keyboard('123456');

    expect(onComplete).toHaveBeenCalledWith('123456');
    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells.map((cell) => cell.value).join('')).toBe('123456');
  });

  it('accepts a pasted code from the first box', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);

    await user.click(screen.getByLabelText('Digit 1 of 6'));
    await user.paste('987654');

    expect(onComplete).toHaveBeenCalledWith('987654');
  });

  it('ignores non-digits', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.keyboard('1a2b3c');

    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells.map((cell) => cell.value).join('')).toBe('123');
  });

  it('steps back and clears on Backspace in an empty box', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.keyboard('12');
    // Focus is now on the third box, which is empty.
    await user.keyboard('{Backspace}');

    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells[1]?.value).toBe('');
    expect(document.activeElement).toBe(cells[1]);
  });

  it('moves between boxes with the arrow keys without wiping them', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.keyboard('123');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');

    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells.map((cell) => cell.value).join('')).toBe('123');
    expect(document.activeElement).toBe(cells[1]);
  });

  it('offers the browser one-time-code autofill on the first box only', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByLabelText('Digit 2 of 6')).toHaveAttribute('autocomplete', 'off');
  });

  it('cannot be typed into while disabled', async () => {
    const user = userEvent.setup();
    render(<OtpInput value="" onChange={vi.fn()} disabled />);

    await user.keyboard('123456');

    const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(cells.every((cell) => cell.disabled)).toBe(true);
    expect(cells.map((cell) => cell.value).join('')).toBe('');
  });

  it('marks the group invalid so the error is not colour-only', () => {
    render(<OtpInput value="123" onChange={vi.fn()} invalid />);
    expect(screen.getByRole('group')).toHaveAttribute('data-invalid', 'true');
  });
});
