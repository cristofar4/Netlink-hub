import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState } from '@netlink/ui';
import { AUDIT_ACTION_LABELS, type AuditRecord } from '@netlink/contracts';
import { api, ApiError } from '../lib/api';

/**
 * The Activity screen: the account's security audit trail.
 *
 * It shows what happened — sign-ins, device changes, denials — and deliberately
 * nothing about content. There is no file name, no message text and no browsing
 * history here, because the control plane never records any.
 */
export function ActivityScreen() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextCursor?: string) => {
    try {
      const page = await api.activity(50, nextCursor);
      setRecords((existing) => (nextCursor ? [...existing, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your activity.');
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  if (loading) return <Card>Loading your activity…</Card>;

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}

      <Alert tone="info">
        NetLink records what happened, never what was in it. No file contents, no messages, no
        passwords and no browsing history are stored here.
      </Alert>

      {records.length === 0 ? (
        <Card>
          <EmptyState title="Nothing yet" description="Security events will appear here." />
        </Card>
      ) : (
        <Card>
          <ul className="nl-stack" style={{ gap: 0, listStyle: 'none', padding: 0, margin: 0 }}>
            {records.map((record) => (
              <li
                key={record.id}
                className="nl-row"
                style={{
                  gap: 14,
                  padding: '14px 0',
                  borderBottom: '1px solid var(--nl-border)',
                  flexWrap: 'wrap',
                }}
              >
                <OutcomeBadge outcome={record.outcome} />
                <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <div style={{ fontWeight: 500 }}>
                    {AUDIT_ACTION_LABELS[record.action] ?? record.action}
                  </div>
                  <div className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)', marginTop: 2 }}>
                    {formatTimestamp(record.createdAt)}
                    {record.approximateLocation && ` · ${record.approximateLocation}`}
                    {record.ipAddress && ` · ${record.ipAddress}`}
                    {record.metadata?.reason && ` · ${String(record.metadata.reason)}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {cursor && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Button
                variant="secondary"
                loading={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void load(cursor).finally(() => setLoadingMore(false));
                }}
              >
                Load older activity
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: AuditRecord['outcome'] }) {
  switch (outcome) {
    case 'success':
      return <Badge tone="success">OK</Badge>;
    case 'denied':
      return <Badge tone="danger">Blocked</Badge>;
    default:
      return <Badge tone="warning">Failed</Badge>;
  }
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
