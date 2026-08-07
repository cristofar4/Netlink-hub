import { useState } from 'react';
import { Alert, Badge, Button, Card, ComingLater, StatusDot } from '@netlink/ui';
import { useSession } from '../state/session';
import { forgetDeviceIdentity } from '../lib/bridge';

/**
 * Settings.
 *
 * The "How this device is protected" card states the *actual* protection in
 * use, reported by the Go side. Outside Wails — or on a platform without a
 * secure store — it says so rather than implying something stronger.
 */
export function SettingsScreen() {
  const { user, device, environment, signOut } = useSession();
  const [forgetting, setForgetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const dpapi = environment?.keyProtection === 'windows-dpapi';

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title="Account">
        <dl className="nl-stack" style={{ gap: 12, margin: 0 }}>
          <Row label="Name" value={user?.name ?? '—'} />
          <Row label="Email" value={user?.email ?? '—'} />
          <Row label="Email confirmed" value={user?.emailVerified ? 'Yes' : 'No'} />
        </dl>
        <div className="nl-row" style={{ gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
          <span className="nl-row" style={{ gap: 8 }}>
            <Button variant="secondary" disabled>
              Change password
            </Button>
            <ComingLater>Phase 7</ComingLater>
          </span>
        </div>
      </Card>

      <Card
        title="How this device is protected"
        subtitle="What NetLink is actually doing on this machine, not what it aims to do."
      >
        <dl className="nl-stack" style={{ gap: 12, margin: 0 }}>
          <Row label="Device name" value={device?.name ?? '—'} />
          <Row
            label="Trusted"
            value={
              device?.trusted ? (
                <Badge tone="success">Yes — no code needed here</Badge>
              ) : (
                <Badge tone="warning">No — a code is required each sign-in</Badge>
              )
            }
          />
          <Row
            label="Private key protection"
            value={
              dpapi ? (
                <StatusDot tone="secure" label="Windows DPAPI, machine-scoped" />
              ) : (
                <StatusDot
                  tone="warning"
                  label={`${environment?.keyProtection ?? 'unknown'} — not a secure store`}
                />
              )
            }
          />
          <Row
            label="Identity stored in"
            value={<code>{environment?.dataDirectory ?? '—'}</code>}
          />
          <Row label="Control plane" value={<code>{environment?.apiBaseUrl ?? '—'}</code>} />
          <Row label="App version" value={environment?.appVersion ?? '—'} />
        </dl>

        {!dpapi && (
          <div style={{ marginTop: 16 }}>
            <Alert tone="warning">
              This installation is not using a hardware-backed or OS-protected key store. That is
              expected when running the app in a browser or on a non-Windows machine during
              development; a real Windows installation protects the key with DPAPI.
            </Alert>
          </div>
        )}
      </Card>

      <Card
        title="Reset this installation"
        subtitle="Use this after revoking this device from another computer."
      >
        <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
          Removes this installation's key pair and identity from this machine. NetLink will enroll
          as a brand-new device the next time you sign in. Your account, your other devices and
          everything in your Spaces are untouched.
        </p>
        <div style={{ marginTop: 16 }}>
          <Button
            variant="danger"
            loading={forgetting}
            onClick={async () => {
              setForgetting(true);
              try {
                await forgetDeviceIdentity();
                await signOut();
                setNotice('This installation now has no device identity. Sign in to enroll again.');
              } finally {
                setForgetting(false);
              }
            }}
          >
            Forget this device identity
          </Button>
        </div>
      </Card>

      <Card title="Coming later" subtitle="Planned, and deliberately not pretended to exist yet.">
        <ul className="nl-stack" style={{ gap: 10, listStyle: 'none', padding: 0, margin: 0 }}>
          {[
            ['Passkeys and authenticator apps', 'Phase 7'],
            ['Biometric unlock', 'Phase 7'],
            ['Signed installers and automatic updates', 'Phase 7'],
            ['Notifications', 'Phase 7'],
          ].map(([label, phase]) => (
            <li key={label} className="nl-row" style={{ gap: 10 }}>
              <span className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)' }}>
                {label}
              </span>
              <div className="nl-spacer" />
              <ComingLater>{phase}</ComingLater>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="nl-row" style={{ gap: 16, flexWrap: 'wrap' }}>
      <dt className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', minWidth: 180 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 'var(--nl-text-sm)' }}>{value}</dd>
    </div>
  );
}
