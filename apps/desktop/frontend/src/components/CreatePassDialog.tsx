import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Input } from '@netlink/ui';
import { GIGABYTE, formatBytes, type PassSummary } from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useBrandName } from '../state/brand';

/**
 * Create a NetLink Pass.
 *
 * The flow the brief describes, in order: pick a person, choose Data Only, set
 * a total, set a daily limit, set an expiry, decide about re-sharing, send.
 *
 * The "what they will and will not see" panel is not decoration — it is the
 * only place an owner is told, before they commit, exactly how little a
 * Data-Only pass grants.
 */
export function CreatePassDialog({
  spaceId,
  availableBytes,
  onClose,
  onCreated,
}: {
  spaceId: string;
  availableBytes: string;
  onClose: () => void;
  onCreated: (pass: PassSummary) => void;
}) {
  const brand = useBrandName();
  const [email, setEmail] = useState('');
  const [useEmail, setUseEmail] = useState(true);
  const [totalGb, setTotalGb] = useState('5');
  const [dailyGb, setDailyGb] = useState('1');
  const [useDaily, setUseDaily] = useState(true);
  const [expiryDays, setExpiryDays] = useState('30');
  const [allowResharing, setAllowResharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PassSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus starts inside — the minimum for a dialog that is
  // usable without a mouse.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.querySelector('input')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const totalBytes = gbToBytes(totalGb);
  const dailyBytes = useDaily ? gbToBytes(dailyGb) : null;
  const overBudget = totalBytes !== null && BigInt(totalBytes) > BigInt(availableBytes);

  const submit = async () => {
    setError(null);
    if (!totalBytes) {
      setError('Enter how much data this person may use.');
      return;
    }

    setBusy(true);
    try {
      const pass = await api.createPass(spaceId, {
        ...(useEmail && email.trim() ? { email: email.trim() } : {}),
        kind: 'data_only',
        permissions: [],
        totalBytes,
        ...(dailyBytes ? { dailyBytes } : {}),
        expiresAt: new Date(
          Date.now() + Math.max(Number(expiryDays) || 30, 1) * 86_400_000,
        ).toISOString(),
        allowResharing,
      });
      setCreated(pass);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create that Pass.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-pass-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="create-pass-title" className="dialog__title">
          {created ? 'Pass ready' : 'Add a person'}
        </h2>

        {created ? (
          <div className="nl-stack" style={{ gap: 16 }}>
            <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
              Send this link to {created.inviteeEmail ?? 'the person you want to share with'}. They
              accept it with their own {brand} account. It works once and expires{' '}
              {new Date(created.expiresAt).toLocaleDateString()}.
            </p>

            <pre className="dialog__token nl-mono">{created.claimToken}</pre>

            <div className="nl-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.claimToken ?? '');
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy pass code'}
              </Button>
              <Button variant="primary" onClick={() => onCreated(created)}>
                Done
              </Button>
            </div>

            <Alert tone="warning">
              This code is shown once and cannot be recovered. Anyone who has it can accept the Pass
              {created.inviteeEmail ? ' — but only from the email address you addressed it to' : ''}
              .
            </Alert>
          </div>
        ) : (
          <form
            className="nl-stack"
            style={{ gap: 18 }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="nl-stack" style={{ gap: 10 }}>
              <label className="dialog__choice">
                <input
                  type="radio"
                  checked={useEmail}
                  onChange={() => setUseEmail(true)}
                  name="pass-target"
                />
                <span>
                  <strong>Send to an email address</strong>
                  <span className="dialog__hint">
                    Only that {brand} account can accept the Pass.
                  </span>
                </span>
              </label>
              <label className="dialog__choice">
                <input
                  type="radio"
                  checked={!useEmail}
                  onChange={() => setUseEmail(false)}
                  name="pass-target"
                />
                <span>
                  <strong>Generate a code to share</strong>
                  <span className="dialog__hint">Anyone with the code can accept it, once.</span>
                </span>
              </label>
            </div>

            {useEmail && (
              <Input
                label="Their email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="them@example.com"
                disabled={busy}
              />
            )}

            <div className="dialog__row">
              <Input
                label="Total data (GB)"
                type="number"
                min="0.1"
                step="0.1"
                value={totalGb}
                onChange={(event) => setTotalGb(event.target.value)}
                hint={`${formatBytes(availableBytes)} available`}
                error={overBudget ? 'More than this pool has left' : undefined}
                disabled={busy}
              />
              <Input
                label="Expires in (days)"
                type="number"
                min="1"
                step="1"
                value={expiryDays}
                onChange={(event) => setExpiryDays(event.target.value)}
                disabled={busy}
              />
            </div>

            <div className="nl-stack" style={{ gap: 10 }}>
              <label className="dialog__check">
                <input
                  type="checkbox"
                  checked={useDaily}
                  onChange={(event) => setUseDaily(event.target.checked)}
                  disabled={busy}
                />
                <span>Set a daily limit</span>
              </label>
              {useDaily && (
                <Input
                  label="Daily limit (GB)"
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={dailyGb}
                  onChange={(event) => setDailyGb(event.target.value)}
                  disabled={busy}
                />
              )}
              <label className="dialog__check">
                <input
                  type="checkbox"
                  checked={allowResharing}
                  onChange={(event) => setAllowResharing(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Allow this person to re-share their data
                  <span className="dialog__hint">Off by default, which is the safer choice.</span>
                </span>
              </label>
            </div>

            <div className="dialog__summary">
              <div className="nl-row" style={{ gap: 8, marginBottom: 10 }}>
                <Badge tone="cyan">Data only</Badge>
              </div>
              <div className="dialog__summary-grid">
                <div>
                  <span className="dialog__summary-head">They will see</span>
                  <ul>
                    <li>Their allocation and how much is left</li>
                    <li>Their daily limit and today&rsquo;s usage</li>
                    <li>The expiry date and whether they are connected</li>
                  </ul>
                </div>
                <div>
                  <span className="dialog__summary-head">They will not see</span>
                  <ul>
                    <li>Your computers or any remote control</li>
                    <li>Your files or printers</li>
                    <li>Other people, your activity, or Space settings</li>
                  </ul>
                </div>
              </div>
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            <div className="nl-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={overBudget}>
                Create Pass
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Gigabytes to a whole number of bytes, without floating point.
 *
 * `2.5 * 1e9` is exact, but `0.1 * 1e9` is not — and byte counts have to be
 * integers all the way to the database, so the decimal is handled as digits.
 */
function gbToBytes(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const scaled = `${whole}${fraction.padEnd(9, '0').slice(0, 9)}`;
  const bytes = BigInt(scaled || '0');
  return bytes > 0n ? bytes.toString() : null;
}

export const __test = { gbToBytes, GIGABYTE };
