import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, StatusDot } from '@netlink/ui';
import {
  GIGABYTE,
  formatBytes,
  percentUsed,
  type DataPoolSummary,
  type MyAllocation,
  type PassSummary,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { CreatePassDialog } from '../components/CreatePassDialog';
import { UsageBar } from '../components/UsageBar';
import './data.css';

/**
 * The Data Pool.
 *
 * Two entirely different screens live here, chosen by what the caller is
 * allowed to see. An owner gets the pool, the passes and the ability to hand
 * data out. A Data-Only member gets their own allowance and nothing else —
 * not because the UI hides the rest, but because the API refuses it. This
 * component simply asks for what it is entitled to and renders whichever
 * answer it gets.
 */
export function DataPoolScreen({ space }: { space: SpaceSummary | null }) {
  const [pool, setPool] = useState<DataPoolSummary | null>(null);
  const [mine, setMine] = useState<MyAllocation | null>(null);
  const [passes, setPasses] = useState<PassSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!space) return;
    setError(null);

    try {
      const summary = await api.dataPool(space.id);
      setPool(summary);
      setPasses(await api.listPasses(space.id));
      setMine(null);
    } catch (poolError) {
      // Not an owner, or no pool. Fall back to the member view; if that is
      // refused too, this Space simply has no data for this person.
      setPool(null);
      try {
        setMine(await api.myAllocation(space.id));
      } catch (mineError) {
        setMine(null);
        if (
          poolError instanceof ApiError &&
          mineError instanceof ApiError &&
          poolError.status !== 404 &&
          mineError.status !== 404 &&
          mineError.status !== 403
        ) {
          setError(mineError.message);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (loading) return <Card>Loading the Data Pool…</Card>;

  // --- The Data-Only member's view -----------------------------------------
  if (mine) return <MyAllocationView allocation={mine} />;

  // --- No pool yet ---------------------------------------------------------
  if (!pool) {
    return space.isOwner ? (
      <ConnectPoolCard spaceId={space.id} onConnected={() => void load()} error={error} />
    ) : (
      <Card>
        <EmptyState
          title="No data shared with you"
          description="The owner of this Space has not given you a data allocation."
        />
      </Card>
    );
  }

  // --- The owner's view ----------------------------------------------------
  const used = percentUsed(pool.balanceBytes, pool.usedBytes);

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {pool.isDemo && (
        <Alert tone="warning">
          <div>
            <strong>This is the Demo Provider.</strong> No real internet data is being shared and no
            real usage is being measured. Sharing data for real requires an integration with a
            licensed telecom, ISP or MVNO — NetLink does not work around carrier billing.
          </div>
        </Alert>
      )}

      <Card
        title={pool.planName ?? 'Data Pool'}
        subtitle={`Provider: ${pool.provider}${pool.isDemo ? ' (demo)' : ''} · account ${pool.accountRef}`}
        actions={
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            Add person
          </Button>
        }
      >
        <UsageBar
          percent={used}
          label={`${formatBytes(pool.usedBytes)} used of ${formatBytes(pool.balanceBytes)}`}
        />

        <dl className="data__facts">
          <div>
            <dt>Balance</dt>
            <dd>{formatBytes(pool.balanceBytes)}</dd>
          </div>
          <div>
            <dt>Allocated</dt>
            <dd>{formatBytes(pool.allocatedBytes)}</dd>
          </div>
          <div>
            <dt>Still available</dt>
            <dd className="data__fact-ok">{formatBytes(pool.availableBytes)}</dd>
          </div>
          <div>
            <dt>People sharing</dt>
            <dd>{pool.memberCount}</dd>
          </div>
        </dl>
      </Card>

      <Card
        title="NetLink Passes"
        subtitle="Each person you invite uses their own NetLink account. You never share your password."
      >
        {passes.length === 0 ? (
          <EmptyState
            title="No passes yet"
            description="Create a pass to share part of your data allowance with someone."
            action={
              <Button variant="secondary" onClick={() => setShowCreate(true)}>
                Add person
              </Button>
            }
          />
        ) : (
          <ul className="nl-stack" style={{ gap: 14, listStyle: 'none', padding: 0, margin: 0 }}>
            {passes.map((pass) => (
              <li key={pass.id} className="data__pass">
                <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <div className="nl-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong>{pass.inviteeEmail ?? 'Anyone with the link'}</strong>
                    {pass.kind === 'data_only' ? (
                      <Badge tone="cyan">Data only</Badge>
                    ) : (
                      <Badge tone="primary">Custom</Badge>
                    )}
                    <PassStatusBadge status={pass.status} />
                  </div>
                  <div className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)', marginTop: 4 }}>
                    {pass.totalBytes ? formatBytes(pass.totalBytes) : 'No data'}
                    {pass.dailyBytes && ` · ${formatBytes(pass.dailyBytes)} a day`}
                    {' · expires '}
                    {new Date(pass.expiresAt).toLocaleDateString()}
                    {!pass.allowResharing && ' · cannot be re-shared'}
                  </div>
                </div>
                {pass.status === 'pending' && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      await api.revokePass(space.id, pass.id);
                      setNotice('That Pass has been revoked.');
                      await load();
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {showCreate && (
        <CreatePassDialog
          spaceId={space.id}
          availableBytes={pool.availableBytes}
          onClose={() => setShowCreate(false)}
          onCreated={async (created) => {
            setShowCreate(false);
            setNotice(
              created.inviteeEmail
                ? `A Pass for ${created.inviteeEmail} is ready.`
                : 'A Pass is ready to share.',
            );
            await load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Data-Only member's view
// ---------------------------------------------------------------------------

/**
 * Everything a Data-Only member is entitled to see, and nothing more.
 *
 * There is deliberately no computer, file, printer, member or setting on this
 * screen — the API would refuse to supply any of it, and the interface should
 * not imply otherwise.
 */
function MyAllocationView({ allocation }: { allocation: MyAllocation }) {
  const used = percentUsed(allocation.allocatedBytes, allocation.usedBytes);
  const dailyUsed = allocation.dailyLimitBytes
    ? percentUsed(allocation.dailyLimitBytes, allocation.usedTodayBytes)
    : null;

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      <Card
        title={`Your data in ${allocation.spaceName}`}
        subtitle="Shared with you by the owner of this Space."
        actions={
          <StatusDot
            tone={allocation.connected ? 'online' : 'offline'}
            label={describeStatus(allocation.status)}
          />
        }
      >
        <UsageBar
          percent={used}
          label={`${formatBytes(allocation.usedBytes)} used of ${formatBytes(allocation.allocatedBytes)}`}
        />

        <dl className="data__facts">
          <div>
            <dt>Allocated</dt>
            <dd>{formatBytes(allocation.allocatedBytes)}</dd>
          </div>
          <div>
            <dt>Used</dt>
            <dd>{formatBytes(allocation.usedBytes)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd className="data__fact-ok">{formatBytes(allocation.remainingBytes)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd style={{ fontSize: 'var(--nl-text-base)' }}>
              {new Date(allocation.expiresAt).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </Card>

      {allocation.dailyLimitBytes && (
        <Card title="Today" subtitle="Your daily limit resets each day.">
          <UsageBar
            percent={dailyUsed ?? 0}
            label={`${formatBytes(allocation.usedTodayBytes)} of ${formatBytes(allocation.dailyLimitBytes)} today`}
          />
        </Card>
      )}

      {allocation.status === 'paused' && (
        <Alert tone="warning">
          Your data is paused. That happens when you reach a limit, or when the owner pauses it.
        </Alert>
      )}
      {allocation.status === 'expired' && (
        <Alert tone="warning">This allocation has expired. Ask the owner for a new one.</Alert>
      )}

      <Card title="What you can see here">
        <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.7 }}>
          This Pass shares data only. It gives you no access to the owner&rsquo;s computers, files,
          printers or settings, and you cannot see other people in this Space. NetLink records how
          much data you use and for how long — never what you visited or sent.
        </p>
      </Card>
    </div>
  );
}

function describeStatus(status: MyAllocation['status']): string {
  switch (status) {
    case 'active':
      return 'Connected';
    case 'paused':
      return 'Paused';
    case 'expired':
      return 'Expired';
    default:
      return 'Revoked';
  }
}

function PassStatusBadge({ status }: { status: PassSummary['status'] }) {
  switch (status) {
    case 'claimed':
      return <Badge tone="success">Accepted</Badge>;
    case 'revoked':
      return <Badge tone="danger">Revoked</Badge>;
    case 'expired':
      return <Badge tone="warning">Expired</Badge>;
    default:
      return <Badge>Waiting</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Connecting a pool
// ---------------------------------------------------------------------------

function ConnectPoolCard({
  spaceId,
  onConnected,
  error,
}: {
  spaceId: string;
  onConnected: () => void;
  error: string | null;
}) {
  const [accountRef, setAccountRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      <Alert tone="info">
        <div>
          NetLink shares an allowance you already pay a provider for. It does not create data and
          does not work around carrier billing. Until a licensed telecom, ISP or MVNO integration is
          in place, the <strong>Demo Provider</strong> lets you try the whole flow with{' '}
          {formatBytes(100 * GIGABYTE)} of pretend allowance.
        </div>
      </Alert>

      <Card
        title="Connect a data account"
        subtitle="Enter the account this Space should share from."
      >
        <form
          className="nl-stack"
          style={{ gap: 16 }}
          onSubmit={async (event) => {
            event.preventDefault();
            setFailure(null);
            setBusy(true);
            try {
              await api.connectDataPool(spaceId, accountRef.trim());
              onConnected();
            } catch (caught) {
              setFailure(
                caught instanceof ApiError ? caught.message : 'Could not connect that account.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            label="Account reference"
            value={accountRef}
            onChange={(event) => setAccountRef(event.target.value)}
            placeholder="e.g. your mobile number"
            hint="With the Demo Provider, any reference of four characters or more is accepted."
            disabled={busy}
          />
          {(failure ?? error) && <Alert tone="error">{failure ?? error}</Alert>}
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={accountRef.trim().length < 4}
          >
            Connect
          </Button>
        </form>
      </Card>
    </div>
  );
}
