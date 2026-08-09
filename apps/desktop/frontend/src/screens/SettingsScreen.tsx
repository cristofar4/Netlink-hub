import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ComingLater, StatusDot, SubNav, Toggle } from '@netlink/ui';
import type { DataPoolSummary, SpaceSummary } from '@netlink/contracts';
import { useSession } from '../state/session';
import { useSpaces } from '../state/space';
import { api } from '../lib/api';
import { forgetDeviceIdentity } from '../lib/bridge';
import { DevicesScreen } from './DevicesScreen';
import { ActivityScreen } from './ActivityScreen';
import { initials } from '../components/TopBar';
import type { SectionId } from './sections';
import './settings.css';

const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security' },
  { id: 'internet', label: 'Internet accounts' },
  { id: 'devices', label: 'Device access' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'activity', label: 'Activity' },
  { id: 'privacy', label: 'Privacy' },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * Settings.
 *
 * Grouped the way people look for things — who am I, how am I protected, what
 * is connected — rather than the way the code is organised.
 *
 * Every panel states what NetLink actually does. Where a control would be a
 * promise rather than a setting, it is shown as not built yet instead of as a
 * switch that flips something nothing reads. The "how this device is protected"
 * panel in particular reports what the Go side found, so on a machine without a
 * secure key store it says so rather than implying something stronger.
 */
export function SettingsScreen({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const [section, setSection] = useState<SettingsSectionId>('profile');

  return (
    <div className="settings">
      <aside className="settings__nav nl-card">
        <SubNav
          items={SETTINGS_SECTIONS}
          active={section}
          onSelect={setSection}
          label="Settings sections"
        />
      </aside>

      <div className="settings__panel">
        <SettingsPanel section={section} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function SettingsPanel({
  section,
  onNavigate,
}: {
  section: SettingsSectionId;
  onNavigate: (section: SectionId) => void;
}) {
  switch (section) {
    case 'profile':
      return <ProfilePanel />;
    case 'account':
      return <AccountPanel />;
    case 'security':
      return <SecurityPanel />;
    case 'internet':
      return <InternetPanel onNavigate={onNavigate} />;
    case 'devices':
      return <DevicesScreen />;
    case 'notifications':
      return <NotificationsPanel />;
    case 'activity':
      return <ActivityScreen />;
    case 'privacy':
      return <PrivacyPanel />;
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfilePanel() {
  const { user } = useSession();

  return (
    <Card title="Profile">
      <div className="settings__identity">
        <span className="settings__avatar" aria-hidden="true">
          {initials(user?.name)}
        </span>
        <div className="settings__identity-text">
          <strong>{user?.name ?? '—'}</strong>
          <span>{user?.email ?? '—'}</span>
          {user?.emailVerified ? (
            <Badge tone="success">Email confirmed</Badge>
          ) : (
            <Badge tone="warning">Email not confirmed</Badge>
          )}
        </div>
      </div>

      <div className="settings__note">
        {/*
         * There is no endpoint that changes a name or an email address, so
         * there is no button here that would appear to. Changing the address on
         * an account is a security operation — it needs re-verification of both
         * addresses — and it is not built yet.
         */}
        <span>Changing your name or email address</span>
        <ComingLater>Not built yet</ComingLater>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountPanel() {
  const { environment, signOut } = useSession();
  const [forgetting, setForgetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="settings__stack">
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title="This installation">
        <dl className="settings__facts">
          <Fact label="App version" value={environment?.appVersion ?? '—'} />
          <Fact label="Control plane" value={<code>{environment?.apiBaseUrl ?? '—'}</code>} />
          <Fact
            label="Identity stored in"
            value={<code>{environment?.dataDirectory ?? '—'}</code>}
          />
        </dl>

        <div className="settings__buttons">
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
          <span className="settings__inline">
            <Button variant="secondary" disabled>
              Change password
            </Button>
            <ComingLater>Not built yet</ComingLater>
          </span>
        </div>
      </Card>

      <Card
        title="Reset this installation"
        subtitle="Use this after revoking this device from another computer."
      >
        <p className="settings__lede">
          Removes this installation&rsquo;s key pair and identity from this machine. NetLink will
          enroll as a brand-new device the next time you sign in. Your account, your other devices
          and everything in your Spaces are untouched.
        </p>
        <div className="settings__buttons">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function SecurityPanel() {
  const { device, environment } = useSession();
  const dpapi = environment?.keyProtection === 'windows-dpapi';

  return (
    <div className="settings__stack">
      <Card title="Account security">
        {/*
         * New-device verification is not a preference. Every device that has
         * not been trusted gets a six-digit code before a session is issued,
         * and there is no switch that turns that off — so it is stated as a
         * fact rather than drawn as a toggle somebody could believe they had
         * disabled.
         */}
        <div className="settings__row">
          <span className="settings__row-text">
            <strong>New-device verification</strong>
            <span>
              Any device that is not already trusted must enter a six-digit code emailed to you.
            </span>
          </span>
          <Badge tone="success">Always on</Badge>
        </div>

        <div className="settings__row">
          <span className="settings__row-text">
            <strong>This device</strong>
            <span>{device?.name ?? 'This installation'}</span>
          </span>
          {device?.trusted ? (
            <Badge tone="success">Trusted</Badge>
          ) : (
            <Badge tone="warning">A code is required each sign-in</Badge>
          )}
        </div>

        <div className="settings__row">
          <span className="settings__row-text">
            <strong>Passkeys and biometric unlock</strong>
            <span>Sign in with the fingerprint reader or face unlock on this machine.</span>
          </span>
          <ComingLater>Not built yet</ComingLater>
        </div>
      </Card>

      <Card
        title="How this device is protected"
        subtitle="What NetLink is actually doing on this machine, not what it aims to do."
      >
        <dl className="settings__facts">
          <Fact
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
          <Fact label="Key algorithm" value="Ed25519, generated on this machine" />
          <Fact label="Key ever transmitted" value="No — only the public half leaves this device" />
        </dl>

        {!dpapi && (
          <div className="settings__alert">
            <Alert tone="warning">
              This installation is not using a hardware-backed or OS-protected key store. That is
              expected when running the app in a browser or on a non-Windows machine during
              development; a real Windows installation protects the key with DPAPI.
            </Alert>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internet accounts
// ---------------------------------------------------------------------------

/**
 * The provider accounts behind each Space's Data Pool.
 *
 * A Space with no pool is listed as not connected rather than omitted, because
 * "you have not set this up" is the answer somebody opening this panel is
 * looking for.
 */
function InternetPanel({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const { spaces } = useSpaces();
  const [pools, setPools] = useState<Map<string, DataPoolSummary | null>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        spaces.map(async (space: SpaceSummary) => {
          const pool = await api.dataPool(space.id).catch(() => null);
          return [space.id, pool] as const;
        }),
      );
      if (!cancelled) {
        setPools(new Map(entries));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaces]);

  return (
    <Card
      title="Connected internet accounts"
      subtitle="The provider account each Space shares its allowance from."
    >
      {loading ? (
        <p className="settings__lede">Checking your Spaces…</p>
      ) : spaces.length === 0 ? (
        <p className="settings__lede">You have no Spaces yet.</p>
      ) : (
        <ul className="settings__accounts">
          {spaces.map((space) => {
            const pool = pools.get(space.id) ?? null;
            return (
              <li key={space.id} className="settings__account">
                <span className="settings__account-mark" aria-hidden="true">
                  <GlobeIcon />
                </span>
                <span className="settings__account-text">
                  <strong>{space.name}</strong>
                  <span>
                    {pool
                      ? `${pool.planName ?? 'Data plan'} · ${pool.accountRef}`
                      : 'No account connected'}
                  </span>
                </span>
                <span className="nl-spacer" />
                {pool ? (
                  <StatusDot tone="online" label={pool.isDemo ? 'Demo provider' : 'Active'} />
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => onNavigate('data')}>
                    Connect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="settings__lede settings__lede--spaced">
        NetLink shares an allowance you already pay a provider for. It does not create data and does
        not work around carrier billing.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Notification preferences.
 *
 * The switches are disabled, and they are disabled honestly: there is no
 * delivery mechanism behind them yet. A toggle that saves a preference nothing
 * ever reads is worse than one that says what it is.
 */
function NotificationsPanel() {
  return (
    <Card
      title="Notifications"
      subtitle="Alerts outside the app are not built yet. The bell in the top bar shows recent activity from the audit log."
    >
      <Toggle
        checked={false}
        disabled
        onChange={() => undefined}
        label="Connection alerts"
        description="Tell me when someone connects to a computer in one of my Spaces."
        stateLabel="Not built yet"
      />
      <Toggle
        checked={false}
        disabled
        onChange={() => undefined}
        label="Data usage alerts"
        description="Tell me when an allowance is nearly spent."
        stateLabel="Not built yet"
      />
      <Toggle
        checked={false}
        disabled
        onChange={() => undefined}
        label="New device alerts"
        description="Tell me when a new device signs in to this account."
        stateLabel="Not built yet"
      />

      <div className="settings__alert">
        <Alert tone="info">
          Every one of these events is already recorded and visible on the Activity screen. What is
          missing is delivery — email, push and desktop notifications.
        </Alert>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

function PrivacyPanel() {
  return (
    <div className="settings__stack">
      <Card title="What NetLink records">
        <ul className="settings__list">
          <li>
            That a session happened: who connected, to which computer, in which mode, for how long.
          </li>
          <li>How much data an allocation used, and when.</li>
          <li>Security events: sign-ins, new devices, refused permissions.</li>
        </ul>
      </Card>

      <Card title="What NetLink never records">
        <ul className="settings__list settings__list--never">
          <li>What was on a screen during a remote session.</li>
          <li>Keystrokes, pointer movement or clipboard contents.</li>
          <li>Which sites were visited or what was sent over shared data.</li>
          <li>The contents or names of files, beyond a transfer you started yourself.</li>
        </ul>
      </Card>

      <Card title="Where the pixels go">
        <p className="settings__lede">
          A remote session travels directly between the two devices whenever a direct path exists.
          When it cannot, it goes through a relay that forwards encrypted packets it cannot read.
          The control plane introduces the two ends and records that they met — it never carries the
          picture.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="settings__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function GlobeIcon() {
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
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" />
    </svg>
  );
}
