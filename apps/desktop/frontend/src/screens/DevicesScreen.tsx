import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, StatusDot } from '@netlink/ui';
import type { AuthenticatedDevice } from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useSession } from '../state/session';

/**
 * Trusted devices.
 *
 * Fully working in Phase 1: list, rename and revoke. Revoking is destructive
 * and irreversible for that installation, so it asks for confirmation and says
 * plainly what will happen — including that other devices are unaffected.
 */
export function DevicesScreen() {
  const { device: currentDevice } = useSession();
  const [devices, setDevices] = useState<AuthenticatedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<AuthenticatedDevice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await api.listDevices());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your devices.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitRename = async (device: AuthenticatedDevice) => {
    const name = renameValue.trim();
    if (!name) return;

    setBusyId(device.id);
    try {
      await api.renameDevice(device.id, name);
      setRenaming(null);
      setNotice(`Renamed to “${name}”.`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not rename that device.');
    } finally {
      setBusyId(null);
    }
  };

  const submitRevoke = async (device: AuthenticatedDevice) => {
    setBusyId(device.id);
    try {
      await api.revokeDevice(device.id);
      setConfirmRevoke(null);
      setNotice(
        `“${device.name}” has been revoked. Its sessions ended immediately; your other devices are unaffected.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke that device.');
    } finally {
      setBusyId(null);
    }
  };

  if (devices === null) {
    return <Card>Loading your devices…</Card>;
  }

  const active = devices.filter((device) => !device.revokedAt);
  const revoked = devices.filter((device) => device.revokedAt);

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      <Alert tone="info">
        Every NetLink installation generates its own key pair. The private half never leaves that
        machine — only the public half is registered here. Revoking one device does not affect any
        other.
      </Alert>

      {active.length === 0 ? (
        <Card>
          <EmptyState
            title="No active devices"
            description="Sign in from a computer to enroll it."
          />
        </Card>
      ) : (
        active.map((device) => (
          <Card key={device.id}>
            <div className="nl-row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                {renaming === device.id ? (
                  <form
                    className="nl-row"
                    style={{ gap: 8 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitRename(device);
                    }}
                  >
                    <Input
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      maxLength={64}
                      autoFocus
                      aria-label={`New name for ${device.name}`}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={busyId === device.id}
                      disabled={!renameValue.trim()}
                    >
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--nl-text-lg)', fontWeight: 600 }}>
                        {device.name}
                      </span>
                      {device.id === currentDevice?.id && <Badge tone="cyan">This device</Badge>}
                      {device.trusted ? (
                        <Badge tone="success">Trusted</Badge>
                      ) : (
                        <Badge tone="warning">Not trusted</Badge>
                      )}
                    </div>
                    <div
                      className="nl-muted"
                      style={{ marginTop: 6, fontSize: 'var(--nl-text-sm)' }}
                    >
                      {device.platform} · {device.kind} · enrolled {formatDate(device.createdAt)}
                      {device.lastSeenAt && ` · last seen ${formatRelative(device.lastSeenAt)}`}
                      {device.approximateLocation && ` · near ${device.approximateLocation}`}
                    </div>
                  </>
                )}
              </div>

              {renaming !== device.id && (
                <div className="nl-row" style={{ gap: 8 }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRenaming(device.id);
                      setRenameValue(device.name);
                      setNotice(null);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmRevoke(device);
                      setNotice(null);
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </div>

            {confirmRevoke?.id === device.id && (
              <div
                style={{
                  marginTop: 16,
                  padding: 16,
                  borderRadius: 'var(--nl-radius)',
                  border: '1px solid rgba(244, 63, 94, 0.4)',
                  background: 'var(--nl-danger-soft)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Revoke “{device.name}”?</div>
                <div style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
                  Its sessions end immediately and it will need to enroll again as a new device.
                  {device.id === currentDevice?.id && (
                    <strong> This is the device you are using — you will be signed out.</strong>
                  )}{' '}
                  Your other devices keep working.
                </div>
                <div className="nl-row" style={{ gap: 8, marginTop: 14 }}>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busyId === device.id}
                    onClick={() => void submitRevoke(device)}
                  >
                    Yes, revoke it
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>
                    Keep this device
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))
      )}

      {revoked.length > 0 && (
        <Card title="Revoked" subtitle="Kept for your records. These devices have no access.">
          <div className="nl-stack" style={{ gap: 10 }}>
            {revoked.map((device) => (
              <div key={device.id} className="nl-row" style={{ gap: 12 }}>
                <StatusDot tone="offline" label={device.name} />
                <div className="nl-spacer" />
                <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                  revoked {formatDate(device.revokedAt!)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatRelative(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return formatDate(iso);
}
