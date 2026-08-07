import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, loading, icon, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'nl-button',
        `nl-button--${variant}`,
        size !== 'md' && `nl-button--${size}`,
        block && 'nl-button--block',
        className,
      )}
      // A button mid-request must not be clickable twice, and assistive tech
      // needs to hear that it is busy rather than just seeing a spinner.
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="nl-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export type CardProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  interactive?: boolean;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
};

export function Card({
  title,
  subtitle,
  actions,
  interactive,
  className,
  children,
  onClick,
}: CardProps) {
  const clickable = Boolean(onClick);
  return (
    <div
      className={cx('nl-card', (interactive || clickable) && 'nl-card--interactive', className)}
      onClick={onClick}
      // A clickable div is only acceptable if it is also reachable and
      // operable from the keyboard.
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {(title || actions) && (
        <div className="nl-row" style={{ marginBottom: subtitle ? 4 : 16, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            {title && <div className="nl-card__title">{title}</div>}
            {subtitle && <div className="nl-card__subtitle">{subtitle}</div>}
          </div>
          <div className="nl-spacer" />
          {actions}
        </div>
      )}
      {subtitle && (title || actions) ? <div style={{ height: 12 }} /> : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field + Input
// ---------------------------------------------------------------------------

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="nl-field">
      {label && (
        <label className="nl-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cx('nl-input', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <span className="nl-field__error" id={`${inputId}-error`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="nl-field__hint" id={`${inputId}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Six-digit code input
// ---------------------------------------------------------------------------

export type OtpInputProps = {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  label?: string;
};

/**
 * Six separate boxes that behave like one field.
 *
 * The behaviour people expect and usually do not get: pasting the whole code
 * works from any box, Backspace on an empty box steps back, and arrow keys
 * move between boxes without wiping what is in them.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  autoFocus,
  label = 'Verification code',
}: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const groupId = useId();

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const setDigit = useCallback(
    (index: number, digit: string) => {
      const next = value.split('');
      while (next.length < length) next.push('');
      next[index] = digit;
      const joined = next.join('').slice(0, length);
      onChange(joined);
      // Empty slots collapse in the join, so a full-length result is exactly
      // the "every box filled" condition. (Checking `!joined.includes('')`
      // would never fire — every string contains the empty string.)
      if (joined.length === length && onComplete) {
        onComplete(joined);
      }
    },
    [length, onChange, onComplete, value],
  );

  const handleChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      setDigit(index, '');
      return;
    }

    // Typing or pasting more than one digit fills forward from this box.
    if (digits.length > 1) {
      const merged = (value.slice(0, index) + digits).slice(0, length);
      onChange(merged);
      const focusIndex = Math.min(merged.length, length - 1);
      refs.current[focusIndex]?.focus();
      if (merged.length === length && onComplete) onComplete(merged);
      return;
    }

    setDigit(index, digits);
    if (index < length - 1) refs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      event.preventDefault();
      refs.current[index - 1]?.focus();
      setDigit(index - 1, '');
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      refs.current[index - 1]?.focus();
    }
    if (event.key === 'ArrowRight' && index < length - 1) {
      event.preventDefault();
      refs.current[index + 1]?.focus();
    }
  };

  return (
    <div
      className="nl-otp"
      data-invalid={invalid ? 'true' : undefined}
      role="group"
      aria-label={label}
      aria-describedby={groupId}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          className={cx('nl-otp__cell', value[index] && 'nl-otp__cell--filled')}
          value={value[index] ?? ''}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onFocus={(event) => event.target.select()}
          disabled={disabled}
          // A numeric keypad on touch, and the browser's own one-time-code
          // autofill on desktop.
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          aria-label={`Digit ${index + 1} of ${length}`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StatusTone = 'online' | 'offline' | 'connecting' | 'secure' | 'warning' | 'danger';

export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={cx('nl-status', `nl-status--${tone}`)}>
      <span className="nl-status__dot" aria-hidden="true" />
      {/* The dot is decorative; the text is what a screen reader announces. */}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'cyan' | 'warning' | 'danger' | 'later';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cx('nl-badge', tone !== 'neutral' && `nl-badge--${tone}`)}>{children}</span>
  );
}

/**
 * The one honest way to show a control that is planned but not built.
 *
 * Nothing in a finished phase may be a dead button; anything not yet wired up
 * says so in the interface rather than failing silently when clicked.
 */
export function ComingLater({ children = 'Coming later' }: { children?: ReactNode }) {
  return <Badge tone="later">{children}</Badge>;
}

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

export function Alert({ tone = 'info', children }: { tone?: AlertTone; children: ReactNode }) {
  return (
    <div
      className={cx('nl-alert', `nl-alert--${tone}`)}
      // Errors interrupt; everything else is announced politely when the user
      // gets there.
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="nl-stack"
      style={{ alignItems: 'center', textAlign: 'center', padding: '48px 24px', gap: 12 }}
    >
      {icon && <div style={{ opacity: 0.6 }}>{icon}</div>}
      <div style={{ fontSize: 'var(--nl-text-lg)', fontWeight: 600 }}>{title}</div>
      {description && (
        <div className="nl-muted" style={{ maxWidth: 420, fontSize: 'var(--nl-text-sm)' }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * Reports the user's reduced-motion preference, and keeps reporting it if they
 * change it while the app is open.
 *
 * The CSS already handles ambient animation. This exists for the cases CSS
 * cannot reach — chiefly the Spaces map, which should render its connection
 * paths statically rather than animate a `stroke-dashoffset` loop.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefers, setPrefers] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setPrefers(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return prefers;
}
