import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, OtpInput, StatusDot, usePrefersReducedMotion } from '@netlink/ui';
import {
  OTP_LENGTH,
  PASSWORD_RULES,
  registerRequestSchema,
  type ChallengeResponse,
} from '@netlink/contracts';
import { api, ApiError } from '../../lib/api';
import { getDeviceIdentity } from '../../lib/bridge';
import { useSession } from '../../state/session';
import { NetLinkMark } from '../../components/NetLinkMark';
import './auth.css';

type Step =
  | { name: 'welcome' }
  | { name: 'register' }
  | { name: 'verify-email'; challenge: ChallengeResponse }
  | { name: 'sign-in' }
  | { name: 'verify-device'; challenge: ChallengeResponse; email: string };

export function AuthFlow() {
  const [step, setStep] = useState<Step>({ name: 'welcome' });
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="auth">
      <div className="auth__aside" aria-hidden="true">
        <NetLinkMark animated={!reducedMotion} />
        <div className="auth__aside-copy">
          <h2 className="auth__aside-title">Your computers. Wherever you are.</h2>
          <p className="auth__aside-text">
            NetLink connects you to your own home or office computer — the files you choose, the
            printer in the next room, the data you decide to share. Nothing more.
          </p>
          <ul className="auth__promises">
            <li>Only folders you approve are ever visible</li>
            <li>Every device gets its own identity you can revoke</li>
            <li>People you invite bring their own NetLink account</li>
          </ul>
        </div>
      </div>

      <div className="auth__panel">
        <div className="auth__panel-inner">
          {/*
           * The wordmark repeats on every step. It is what a person checks
           * against the email they were just sent, and a sign-in form with no
           * identity on it is the shape a phishing page takes.
           */}
          <div className="auth__brand">
            <span className="auth__brand-mark" aria-hidden="true" />
            <span className="auth__brand-name">NetLink</span>
          </div>

          {step.name === 'welcome' && (
            <Welcome
              onRegister={() => setStep({ name: 'register' })}
              onSignIn={() => setStep({ name: 'sign-in' })}
            />
          )}

          {step.name === 'register' && (
            <RegisterStep
              onBack={() => setStep({ name: 'welcome' })}
              onSignIn={() => setStep({ name: 'sign-in' })}
              onChallenge={(challenge) => setStep({ name: 'verify-email', challenge })}
            />
          )}

          {step.name === 'verify-email' && (
            <VerifyEmailStep
              challenge={step.challenge}
              onBack={() => setStep({ name: 'register' })}
              onVerified={() => setStep({ name: 'sign-in' })}
            />
          )}

          {step.name === 'sign-in' && (
            <SignInStep
              onBack={() => setStep({ name: 'welcome' })}
              onRegister={() => setStep({ name: 'register' })}
              onDeviceChallenge={(challenge, email) =>
                setStep({ name: 'verify-device', challenge, email })
              }
              onEmailChallenge={(challenge) => setStep({ name: 'verify-email', challenge })}
            />
          )}

          {step.name === 'verify-device' && (
            <VerifyDeviceStep
              challenge={step.challenge}
              onBack={() => setStep({ name: 'sign-in' })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

function Welcome({ onRegister, onSignIn }: { onRegister: () => void; onSignIn: () => void }) {
  return (
    <>
      <header className="auth__header">
        <p className="auth__eyebrow">Welcome to NetLink</p>
        <h1 className="auth__title">Reach your own computers, securely</h1>
        <p className="auth__lead">
          Create a NetLink account to link this device to your Spaces. You will never be asked to
          share your password with anyone.
        </p>
      </header>

      <div className="nl-stack" style={{ gap: 12, marginTop: 32 }}>
        <Button variant="primary" size="lg" block onClick={onRegister}>
          Create a NetLink account
        </Button>
        <Button variant="secondary" size="lg" block onClick={onSignIn}>
          I already have an account
        </Button>
      </div>

      <ControlPlaneStatus />
    </>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function RegisterStep({
  onBack,
  onSignIn,
  onChallenge,
}: {
  onBack: () => void;
  onSignIn: () => void;
  onChallenge: (challenge: ChallengeResponse) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);

    // Validated with the same schema the API uses, so the user sees the problem
    // before a round trip rather than after one.
    const parsed = registerRequestSchema.safeParse({ name, email, password });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    setBusy(true);
    try {
      onChallenge(await api.register(parsed.data));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="auth__header">
        <button className="auth__back" onClick={onBack} type="button">
          ← Back
        </button>
        <h1 className="auth__title">Create your account</h1>
        <p className="auth__lead">We will send a six-digit code to confirm your email address.</p>
      </header>

      <form
        className="nl-stack"
        style={{ gap: 16, marginTop: 24 }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          label="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Christopher"
          autoComplete="name"
          error={fieldErrors.name}
          disabled={busy}
        />
        <Input
          label="Email address"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          error={fieldErrors.email}
          disabled={busy}
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 12 characters"
          autoComplete="new-password"
          error={fieldErrors.password}
          disabled={busy}
        />

        {/*
         * The rules are shown as they are met, rather than as a sentence under
         * the field. A password refused after submitting — with the same
         * sentence repeated back in red — is the most avoidable failure in any
         * sign-up form.
         */}
        <PasswordRules password={password} />

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? 'Creating your account…' : 'Continue'}
        </Button>
      </form>

      <p className="auth__footnote">
        Already have an account?{' '}
        <button className="auth__link" type="button" onClick={onSignIn}>
          Sign in
        </button>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Verify email
// ---------------------------------------------------------------------------

function VerifyEmailStep({
  challenge,
  onBack,
  onVerified,
}: {
  challenge: ChallengeResponse;
  onBack: () => void;
  onVerified: () => void;
}) {
  const [current, setCurrent] = useState(challenge);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (value: string) => {
      setError(null);
      setBusy(true);
      try {
        await api.verifyEmail({ challengeId: current.challengeId, code: value });
        onVerified();
      } catch (caught) {
        setError(messageFor(caught));
        setCode('');
      } finally {
        setBusy(false);
      }
    },
    [current.challengeId, onVerified],
  );

  return (
    <CodeStep
      title="Confirm your email"
      lead={
        <>
          Enter the {OTP_LENGTH}-digit code we sent to <strong>{current.maskedEmail}</strong>.
        </>
      }
      challenge={current}
      code={code}
      onCodeChange={setCode}
      onComplete={submit}
      onSubmit={() => submit(code)}
      onResent={(next) => {
        setCurrent(next);
        setCode('');
        setError(null);
        setNotice('A new code is on its way. The previous code no longer works.');
      }}
      error={error}
      notice={notice}
      busy={busy}
      onBack={onBack}
      backLabel="← Use a different email"
    />
  );
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function SignInStep({
  onBack,
  onRegister,
  onDeviceChallenge,
  onEmailChallenge,
}: {
  onBack: () => void;
  onRegister: () => void;
  onDeviceChallenge: (challenge: ChallengeResponse, email: string) => void;
  onEmailChallenge: (challenge: ChallengeResponse) => void;
}) {
  const { setSession } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email address and password.');
      return;
    }

    setBusy(true);
    try {
      // Every sign-in is bound to this installation's device identity, so the
      // server always knows which machine is asking.
      const device = await getDeviceIdentity();
      const response = await api.login({ email: email.trim(), password, device });

      if (response.status === 'authenticated') {
        setSession({
          user: response.user,
          device: response.device,
          tokens: response.tokens,
        });
        return;
      }

      if (response.challenge.purpose === 'email_verification') {
        onEmailChallenge(response.challenge);
      } else {
        onDeviceChallenge(response.challenge, email.trim());
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="auth__header">
        <button className="auth__back" onClick={onBack} type="button">
          ← Back
        </button>
        <h1 className="auth__title">Sign in to NetLink</h1>
        <p className="auth__lead">
          If this device is new, we will send a code to your email before letting it in.
        </p>
      </header>

      <form
        className="nl-stack"
        style={{ gap: 16, marginTop: 24 }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          label="Email address"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          disabled={busy}
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="auth__footnote">
        New to NetLink?{' '}
        <button className="auth__link" type="button" onClick={onRegister}>
          Create an account
        </button>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Verify new device
// ---------------------------------------------------------------------------

function VerifyDeviceStep({
  challenge,
  onBack,
}: {
  challenge: ChallengeResponse;
  onBack: () => void;
}) {
  const { setSession } = useSession();
  const [current, setCurrent] = useState(challenge);
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read at submit time rather than captured, so toggling the checkbox after
  // the last digit is typed still takes effect.
  const trustRef = useRef(trustDevice);
  trustRef.current = trustDevice;

  const submit = useCallback(
    async (value: string) => {
      setError(null);
      setBusy(true);
      try {
        const response = await api.verifyDevice({
          challengeId: current.challengeId,
          code: value,
          trustDevice: trustRef.current,
        });
        setSession({
          user: response.user,
          device: response.device,
          tokens: response.tokens,
        });
      } catch (caught) {
        setError(messageFor(caught));
        setCode('');
      } finally {
        setBusy(false);
      }
    },
    [current.challengeId, setSession],
  );

  return (
    <CodeStep
      title="Approve this device"
      lead={
        <>
          This device has not been used with your account before. Enter the {OTP_LENGTH}-digit code
          we sent to <strong>{current.maskedEmail}</strong>.
        </>
      }
      /*
       * What is actually being approved, stated before the code box. The email
       * names the device and roughly where it is; showing the same facts here
       * lets someone compare the two, which is the whole defence against being
       * talked through this by a stranger on the phone.
       */
      subject={<DeviceUnderReview />}
      challenge={current}
      code={code}
      onCodeChange={setCode}
      onComplete={submit}
      onSubmit={() => submit(code)}
      onResent={(next) => {
        setCurrent(next);
        setCode('');
        setError(null);
        setNotice('A new code is on its way. The previous code no longer works.');
      }}
      error={error}
      notice={notice}
      busy={busy}
      onBack={onBack}
      backLabel="← Back to sign in"
      extra={
        <label className="auth__checkbox">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(event) => setTrustDevice(event.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>Trust this device</strong>
            <span className="auth__checkbox-hint">
              Skip the code next time on this computer. Leave it off on a shared or borrowed machine
              — that session will expire within a day.
            </span>
          </span>
        </label>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Shared code-entry step
// ---------------------------------------------------------------------------

function CodeStep({
  title,
  lead,
  challenge,
  code,
  onCodeChange,
  onComplete,
  onSubmit,
  onResent,
  error,
  notice,
  busy,
  onBack,
  backLabel,
  subject,
  extra,
}: {
  title: string;
  lead: React.ReactNode;
  challenge: ChallengeResponse;
  code: string;
  onCodeChange: (value: string) => void;
  onComplete: (value: string) => void;
  onSubmit: () => void;
  onResent: (challenge: ChallengeResponse) => void;
  error: string | null;
  notice: string | null;
  busy: boolean;
  onBack: () => void;
  backLabel: string;
  subject?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const secondsLeft = useCountdown(challenge.resendAvailableAt);

  const resend = async () => {
    setResendError(null);
    setResending(true);
    try {
      onResent(await api.resendCode(challenge.challengeId));
    } catch (caught) {
      setResendError(messageFor(caught));
    } finally {
      setResending(false);
    }
  };

  return (
    <>
      <header className="auth__header">
        <button className="auth__back" onClick={onBack} type="button">
          {backLabel}
        </button>
        <h1 className="auth__title">{title}</h1>
        <p className="auth__lead">{lead}</p>
      </header>

      <form
        className="nl-stack"
        style={{ gap: 20, marginTop: 28 }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {subject}

        <OtpInput
          value={code}
          onChange={onCodeChange}
          onComplete={onComplete}
          disabled={busy}
          invalid={Boolean(error)}
          autoFocus
        />

        {extra}

        {error && <Alert tone="error">{error}</Alert>}
        {!error && notice && <Alert tone="info">{notice}</Alert>}
        {resendError && <Alert tone="error">{resendError}</Alert>}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={busy}
          disabled={code.length < OTP_LENGTH}
        >
          {busy ? 'Checking…' : 'Verify'}
        </Button>

        <div className="auth__resend">
          <span className="nl-dim">The code expires in 10 minutes.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void resend()}
            loading={resending}
            disabled={secondsLeft > 0 || challenge.resendsRemaining === 0 || busy}
          >
            {challenge.resendsRemaining === 0
              ? 'No codes left'
              : secondsLeft > 0
                ? `Send a new code in ${secondsLeft}s`
                : 'Send a new code'}
          </Button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// The device being approved
// ---------------------------------------------------------------------------

/**
 * This installation, as the server will record it.
 *
 * Read from the same source the sign-in request used, so what is shown here is
 * what is actually being approved rather than a description of it.
 */
function DeviceUnderReview() {
  const [identity, setIdentity] = useState<{ name: string; platform: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDeviceIdentity()
      .then((device) => {
        if (!cancelled) setIdentity({ name: device.name, platform: device.platform });
      })
      .catch(() => {
        /* The code still works without the summary. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!identity) return null;

  return (
    <div className="auth__device">
      <span className="auth__device-icon" aria-hidden="true">
        <MonitorGlyph />
      </span>
      <span className="auth__device-text">
        <strong>{identity.name}</strong>
        <span>
          {/* Only the platform is title-cased — it arrives lowercase from the
              identity ("windows", "macos"). The rest is a sentence. */}
          <span className="auth__device-platform">{identity.platform}</span> · requested just now
        </span>
      </span>
    </div>
  );
}

function MonitorGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Password rules
// ---------------------------------------------------------------------------

/**
 * The password requirements, ticking off as they are met.
 *
 * The list comes from the contracts package — the same one the schema is built
 * from — so it cannot promise a rule the server does not enforce, or miss one
 * it does. Nothing is marked failed until something has been typed: a form that
 * greets you with four red crosses is telling you off for not having started.
 */
function PasswordRules({ password }: { password: string }) {
  const started = password.length > 0;

  return (
    <ul className="auth__rules">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(password);
        return (
          <li
            key={rule.id}
            className={`auth__rule${met ? ' auth__rule--met' : started ? ' auth__rule--unmet' : ''}`}
          >
            <span className="auth__rule-mark" aria-hidden="true">
              {met ? '✓' : '·'}
            </span>
            {rule.label}
            <span className="nl-visually-hidden">{met ? ' — met' : ' — not met yet'}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seconds remaining until `isoTime`, ticking down to zero. */
function useCountdown(isoTime: string): number {
  const compute = useCallback(() => {
    const remaining = Math.ceil((new Date(isoTime).getTime() - Date.now()) / 1000);
    return Number.isFinite(remaining) ? Math.max(remaining, 0) : 0;
  }, [isoTime]);

  const [seconds, setSeconds] = useState(compute);

  useEffect(() => {
    setSeconds(compute());
    const timer = window.setInterval(() => {
      const next = compute();
      setSeconds(next);
      if (next <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [compute]);

  return seconds;
}

function ControlPlaneStatus() {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    let cancelled = false;
    void api
      .health()
      .then(() => !cancelled && setState('up'))
      .catch(() => !cancelled && setState('down'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="auth__status">
      {state === 'checking' && <StatusDot tone="connecting" label="Checking NetLink service…" />}
      {state === 'up' && <StatusDot tone="secure" label="NetLink service reachable" />}
      {state === 'down' && (
        <StatusDot tone="warning" label="NetLink service is not reachable right now" />
      )}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.fieldErrors?.length) {
      return error.fieldErrors.map((issue) => issue.message).join(' ');
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
