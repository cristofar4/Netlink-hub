import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, StatusDot } from '@netlink/ui';
import {
  PERMISSION_LABELS,
  formatBytes,
  percentUsed,
  type MemberAccessRow,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { UsageBar } from '../components/UsageBar';
import './data.css';

/**
 * Member Access.
 *
 * Everything the brief asks an owner to be able to see and do about one
 * person, on one row: who they are, which device, whether they are connected,
 * usage today, usage total, what remains, their daily limit, their expiry —
 * and Pause, Edit Limit and Revoke.
 *
 * The permission list is spelled out in words rather than left implicit. An
 * owner should be able to read exactly what they granted without having to
 * remember what "Data Only" meant when they clicked it.
 */
export function MemberAccessScreen({ space }: { space: SpaceSummary | null }) {
  const [rows, setRows] = useState<MemberAccessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!space) return;
    try {
      setRows(await api.memberAccess(space.id));
      setError(null);
    } catch (caught) {
      setRows([]);
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load the people in this Space.',
      );
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (rows === null) return <Card>Loading members…</Card>;

  const invited = rows.filter((row) => row.role !== 'owner');

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      <Alert tone="info">
        Everyone here uses their own NetLink account. You have never shared your password, and you
        can end any of this at any time.
      </Alert>

      {invited.length === 0 ? (
        <Card>
          <EmptyState
            title="Nobody else yet"
            description="Invite someone from the Data Pool to share part of your allowance with them."
          />
        </Card>
      ) : (
        invited.map((row) => (
          <Card key={row.memberId}>
            <div className="nl-row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 'var(--nl-text-lg)' }}>{row.name}</strong>
                  {row.suspended ? (
                    <Badge tone="danger">Access revoked</Badge>
                  ) : row.allocation?.status === 'paused' ? (
                    <Badge tone="warning">Paused</Badge>
                  ) : row.allocation?.status === 'expired' ? (
                    <Badge tone="warning">Expired</Badge>
                  ) : (
                    <Badge tone="success">Active</Badge>
                  )}
                </div>
                <div className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', marginTop: 4 }}>
                  {row.email}
                  {row.approvedDeviceName && ` · ${row.approvedDeviceName}`}
                </div>
              </div>
              <StatusDot
                tone={row.connected ? 'online' : 'offline'}
                label={row.connected ? 'Connected' : 'Disconnected'}
              />
            </div>

            {row.allocation && (
              <div style={{ marginTop: 20 }}>
                <UsageBar
                  percent={percentUsed(row.allocation.allocatedBytes, row.allocation.usedBytes)}
                  label={`${formatBytes(row.allocation.usedBytes)} of ${formatBytes(row.allocation.allocatedBytes)} used`}
                />

                <dl className="data__facts">
                  <div>
                    <dt>Today</dt>
                    <dd style={{ fontSize: 'var(--nl-text-lg)' }}>
                      {formatBytes(row.allocation.usedTodayBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Total used</dt>
                    <dd style={{ fontSize: 'var(--nl-text-lg)' }}>
                      {formatBytes(row.allocation.usedBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Remaining</dt>
                    <dd className="data__fact-ok" style={{ fontSize: 'var(--nl-text-lg)' }}>
                      {formatBytes(row.allocation.remainingBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Daily limit</dt>
                    <dd style={{ fontSize: 'var(--nl-text-lg)' }}>
                      {row.allocation.dailyLimitBytes
                        ? formatBytes(row.allocation.dailyLimitBytes)
                        : 'None'}
                    </dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd style={{ fontSize: 'var(--nl-text-lg)' }}>
                      {new Date(row.allocation.expiresAt).toLocaleDateString()}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            <div style={{ marginTop: 20 }}>
              <span
                style={{
                  fontSize: 'var(--nl-text-xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--nl-text-muted)',
                }}
              >
                What they can do
              </span>
              <div className="nl-row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {row.permissions.length === 0 ? (
                  <Badge>Nothing</Badge>
                ) : (
                  row.permissions.map((permission) => (
                    <Badge key={permission} tone="cyan">
                      {PERMISSION_LABELS[permission]}
                    </Badge>
                  ))
                )}
              </div>
            </div>

            {!row.suspended && (
              <div className="nl-row" style={{ gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
                {row.allocation && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busyId === row.memberId}
                      onClick={async () => {
                        setBusyId(row.memberId);
                        try {
                          const paused = row.allocation?.status !== 'paused';
                          await api.pauseMemberData(space.id, row.memberId, paused);
                          setNotice(
                            paused
                              ? `${row.name}'s data is paused.`
                              : `${row.name}'s data is active again.`,
                          );
                          await load();
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      {row.allocation.status === 'paused' ? 'Resume data' : 'Pause data'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing(editing === row.memberId ? null : row.memberId)}
                    >
                      Edit limit
                    </Button>
                  </>
                )}
                <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(row.memberId)}>
                  Revoke access
                </Button>
              </div>
            )}

            {editing === row.memberId && row.allocation && (
              <EditLimit
                spaceId={space.id}
                memberId={row.memberId}
                current={row.allocation}
                onDone={async (message) => {
                  setEditing(null);
                  setNotice(message);
                  await load();
                }}
                onCancel={() => setEditing(null)}
              />
            )}

            {confirmRevoke === row.memberId && (
              <div className="member__confirm">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Revoke {row.name}&rsquo;s access?
                </div>
                <div style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
                  Their data allocation ends and every permission they hold is cleared. They keep
                  their own NetLink account; they simply lose access to this Space.
                </div>
                <div className="nl-row" style={{ gap: 8, marginTop: 14 }}>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busyId === row.memberId}
                    onClick={async () => {
                      setBusyId(row.memberId);
                      try {
                        await api.revokeMemberAccess(space.id, row.memberId);
                        setConfirmRevoke(null);
                        setNotice(`${row.name} no longer has access to this Space.`);
                        await load();
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    Yes, revoke
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>
                    Keep their access
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

function EditLimit({
  spaceId,
  memberId,
  current,
  onDone,
  onCancel,
}: {
  spaceId: string;
  memberId: string;
  current: NonNullable<MemberAccessRow['allocation']>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [totalGb, setTotalGb] = useState(bytesToGb(current.allocatedBytes));
  const [dailyGb, setDailyGb] = useState(
    current.dailyLimitBytes ? bytesToGb(current.dailyLimitBytes) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="member__edit"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setBusy(true);
        try {
          await api.updateMemberAllocation(spaceId, memberId, {
            totalBytes: gbToBytes(totalGb) ?? undefined,
            dailyBytes: dailyGb.trim() === '' ? null : (gbToBytes(dailyGb) ?? undefined),
          });
          onDone('Limits updated.');
        } catch (caught) {
          setError(caught instanceof ApiError ? caught.message : 'Could not update that limit.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="dialog__row">
        <Input
          label="Total data (GB)"
          type="number"
          min="0.1"
          step="0.1"
          value={totalGb}
          onChange={(event) => setTotalGb(event.target.value)}
          disabled={busy}
        />
        <Input
          label="Daily limit (GB)"
          type="number"
          min="0"
          step="0.1"
          value={dailyGb}
          onChange={(event) => setDailyGb(event.target.value)}
          hint="Leave empty for no daily limit"
          disabled={busy}
        />
      </div>
      {error && (
        <div style={{ marginTop: 12 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="nl-row" style={{ gap: 8, marginTop: 14 }}>
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Bytes to a gigabyte string for display in a number field. */
function bytesToGb(bytes: string): string {
  const value = BigInt(bytes);
  const whole = value / 1_000_000_000n;
  const fraction = value % 1_000_000_000n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

/** Gigabytes to whole bytes, digit by digit so no float rounding creeps in. */
function gbToBytes(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const bytes = BigInt(`${whole}${fraction.padEnd(9, '0').slice(0, 9)}` || '0');
  return bytes > 0n ? bytes.toString() : null;
}
