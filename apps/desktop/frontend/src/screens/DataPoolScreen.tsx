import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  BarChart,
  Button,
  Card,
  EmptyState,
  Input,
  Meter,
  RadialGauge,
  StatTile,
  StatusDot,
  type VizTone,
} from '@netlink/ui';
import {
  GIGABYTE,
  USAGE_HISTORY_DEFAULT_DAYS,
  formatBytes,
  percentUsed,
  projectDaysRemaining,
  remainingBytes,
  type DataPoolSummary,
  type DataUsageSeries,
  type MemberAccessRow,
  type MyAllocation,
  type PassSummary,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useBrandName } from '../state/brand';
import { CreatePassDialog } from '../components/CreatePassDialog';
import { UsageBar } from '../components/UsageBar';
import './data.css';

const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: USAGE_HISTORY_DEFAULT_DAYS, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/**
 * The Data Pool.
 *
 * Two entirely different screens live here, chosen by what the caller is
 * allowed to see. An owner gets the pool, the history and the ability to hand
 * data out. A Data-Only member gets their own allowance and nothing else — not
 * because the UI hides the rest, but because the API refuses it. This component
 * asks for what it is entitled to and renders whichever answer it gets.
 */
export function DataPoolScreen({ space }: { space: SpaceSummary | null }) {
  const brand = useBrandName();
  const [pool, setPool] = useState<DataPoolSummary | null>(null);
  const [mine, setMine] = useState<MyAllocation | null>(null);
  const [members, setMembers] = useState<MemberAccessRow[]>([]);
  const [passes, setPasses] = useState<PassSummary[]>([]);
  const [usage, setUsage] = useState<DataUsageSeries | null>(null);
  const [days, setDays] = useState(USAGE_HISTORY_DEFAULT_DAYS);
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
      setMine(null);
      // Members and passes are the owner's view of the same pool; a failure in
      // either should not blank the screen that already loaded.
      const [passList, memberList] = await Promise.all([
        api.listPasses(space.id).catch(() => []),
        api.memberAccess(space.id).catch(() => []),
      ]);
      setPasses(passList);
      setMembers(memberList);
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

  // The chart reloads on its own when the window changes, without disturbing
  // the rest of the screen.
  useEffect(() => {
    if (!space) return;
    let cancelled = false;
    void api
      .dataUsage(space.id, days)
      .then((series) => {
        if (!cancelled) setUsage(series);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [space, days, pool, mine]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (loading) return <Card>Loading the Data Pool…</Card>;

  if (mine) return <MyAllocationView allocation={mine} usage={usage} />;

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

  const remaining = remainingBytes(pool.balanceBytes, pool.usedBytes);
  const remainingPercent = 100 - percentUsed(pool.balanceBytes, pool.usedBytes);
  const projectedDays = usage ? projectDaysRemaining(remaining, usage.dailyAverageBytes) : null;

  return (
    <div className="data">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {pool.isDemo && (
        <Alert tone="warning">
          <div>
            <strong>This is the Demo Provider.</strong> No real internet data is being shared and no
            real usage is being measured. Sharing data for real requires an integration with a
            licensed telecom, ISP or MVNO — {brand} does not work around carrier billing.
          </div>
        </Alert>
      )}

      <div className="data__top">
        <section className="data__gauge-card nl-card">
          <RadialGauge
            percent={remainingPercent}
            value={splitAmount(remaining).value}
            unit={splitAmount(remaining).unit}
            caption="remaining"
            footnote={`of ${formatBytes(pool.balanceBytes)} total`}
            tone={gaugeTone(remainingPercent)}
            label={`${formatBytes(remaining)} remaining of ${formatBytes(pool.balanceBytes)}`}
          />
        </section>

        <div className="data__tiles">
          <StatTile
            icon={<DatabaseIcon />}
            label="Total data"
            value={splitAmount(pool.balanceBytes).value}
            unit={splitAmount(pool.balanceBytes).unit}
          />
          <StatTile
            icon={<PieIcon />}
            label="Used"
            value={splitAmount(pool.usedBytes).value}
            unit={splitAmount(pool.usedBytes).unit}
            tone="cyan"
          />
          <StatTile
            icon={<PeopleIcon />}
            label="Shared with"
            value={pool.memberCount}
            detail={pool.memberCount === 1 ? 'person' : 'people'}
            tone="success"
          />
          <StatTile
            icon={<CalendarIcon />}
            label="May last"
            // Null means no usage has been recorded yet. A projection from no
            // measurements would be a guess wearing a number's clothes.
            value={projectedDays === null ? 'Unknown' : projectedDays}
            unit={projectedDays === null ? undefined : projectedDays === 1 ? 'day' : 'days'}
            detail={projectedDays === null ? 'No usage recorded yet' : 'At the recent rate'}
            tone="warning"
          />
        </div>
      </div>

      <div className="data__body">
        <div className="data__main">
          <Card
            title="Data usage"
            actions={
              <select
                className="data__window"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                aria-label="Chart window"
              >
                {WINDOWS.map((window) => (
                  <option key={window.days} value={window.days}>
                    {window.label}
                  </option>
                ))}
              </select>
            }
          >
            <UsageChart usage={usage} />
          </Card>

          <div className="data__split">
            <Card title="Share this allowance">
              <p className="data__lede">
                Everyone you invite uses their own {brand} account. You never share your password,
                and you can take an allocation back at any time.
              </p>
              <div className="data__buttons">
                <Button variant="primary" onClick={() => setShowCreate(true)}>
                  <PeopleIcon /> Share data
                </Button>
                <Button variant="secondary" onClick={() => setShowCreate(true)}>
                  <QrIcon /> Generate a code
                </Button>
              </div>
            </Card>

            <Card title="Connected internet account">
              <div className="data__account">
                <span className="data__account-mark" aria-hidden="true">
                  <GlobeIcon />
                </span>
                <div className="data__account-text">
                  <strong>{pool.planName ?? 'Data plan'}</strong>
                  <StatusDot tone="online" label={pool.isDemo ? 'Demo provider' : 'Active'} />
                </div>
                <div className="nl-spacer" />
                <span className="data__account-ref">{pool.accountRef}</span>
              </div>
            </Card>
          </div>

          <Card
            title={`${brand} Passes`}
            subtitle="An invitation that is waiting, accepted or spent."
          >
            {passes.length === 0 ? (
              <EmptyState
                title="No passes yet"
                description="Create a pass to share part of your data allowance with someone."
                action={
                  <Button variant="secondary" onClick={() => setShowCreate(true)}>
                    Share data
                  </Button>
                }
              />
            ) : (
              <ul className="data__passes">
                {passes.map((pass) => (
                  <li key={pass.id} className="data__pass">
                    <div className="data__pass-detail">
                      <div className="nl-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <strong>{pass.inviteeEmail ?? 'Anyone with the link'}</strong>
                        {pass.kind === 'data_only' ? (
                          <Badge tone="cyan">Data only</Badge>
                        ) : (
                          <Badge tone="primary">Custom</Badge>
                        )}
                        <PassStatusBadge status={pass.status} />
                      </div>
                      <div className="data__pass-meta">
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
        </div>

        <Card title="Shared members" subtitle="How much each person has used of their allowance.">
          <MemberList members={members} />
        </Card>
      </div>

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
// The usage chart
// ---------------------------------------------------------------------------

/**
 * Daily usage, in whatever unit the busiest day calls for.
 *
 * Byte counts arrive as decimal strings because they can exceed what a double
 * holds exactly. They are converted to numbers only here, for the geometry of
 * the bars — a pixel height does not need more precision than a double has.
 */
function UsageChart({ usage }: { usage: DataUsageSeries | null }) {
  const bars = useMemo(() => {
    if (!usage) return [];
    // One label roughly every fifth bar, so a 90-day window does not turn its
    // axis into a smear.
    const step = Math.max(1, Math.ceil(usage.buckets.length / 6));
    return usage.buckets.map((bucket, index) => ({
      key: bucket.day,
      value: Number(bucket.bytes),
      label: index % step === 0 ? shortDay(bucket.day) : undefined,
      title: `${formatBytes(bucket.bytes)} on ${longDay(bucket.day)}`,
    }));
  }, [usage]);

  if (!usage) return <p className="nl-muted data__lede">Usage history is not available here.</p>;

  return (
    <BarChart
      bars={bars}
      formatTick={(value) => formatBytes(Math.round(value))}
      caption={`Daily data usage from ${longDay(usage.fromDay)} to ${longDay(usage.toDay)}. ${formatBytes(usage.totalBytes)} in total, ${formatBytes(usage.peakBytes)} on the busiest day.`}
      emptyMessage="No usage recorded in this window."
    />
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** The palette for member bars, so two people beside each other differ. */
const MEMBER_TONES: VizTone[] = ['primary', 'cyan', 'success', 'warning'];

function MemberList({ members }: { members: MemberAccessRow[] }) {
  const withData = members.filter((member) => member.allocation !== null);

  if (withData.length === 0) {
    return (
      <p className="nl-muted data__lede">
        Nobody has an allocation from this pool yet. Share data to add someone.
      </p>
    );
  }

  return (
    <ul className="data__members">
      {withData.map((member, index) => {
        const allocation = member.allocation!;
        return (
          <li key={member.memberId} className="data__member">
            <span
              className="data__member-avatar"
              style={{ background: avatarColour(index) }}
              aria-hidden="true"
            >
              {member.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="data__member-body">
              <div className="data__member-head">
                <span className="data__member-name">
                  {member.name}
                  {member.role === 'owner' && <span className="data__member-role"> (owner)</span>}
                </span>
                <span className="data__member-figure">
                  {formatBytes(allocation.usedBytes)} / {formatBytes(allocation.allocatedBytes)}
                </span>
              </div>
              <Meter
                percent={percentUsed(allocation.allocatedBytes, allocation.usedBytes)}
                tone={MEMBER_TONES[index % MEMBER_TONES.length]}
                ariaLabel={`${member.name} has used ${formatBytes(allocation.usedBytes)} of ${formatBytes(allocation.allocatedBytes)}`}
              />
              {allocation.status !== 'active' && (
                <span className="data__member-status">{describeStatus(allocation.status)}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
function MyAllocationView({
  allocation,
  usage,
}: {
  allocation: MyAllocation;
  usage: DataUsageSeries | null;
}) {
  const brand = useBrandName();
  const used = percentUsed(allocation.allocatedBytes, allocation.usedBytes);
  const dailyUsed = allocation.dailyLimitBytes
    ? percentUsed(allocation.dailyLimitBytes, allocation.usedTodayBytes)
    : null;

  return (
    <div className="data">
      <div className="data__top">
        <section className="data__gauge-card nl-card">
          <RadialGauge
            percent={100 - used}
            value={splitAmount(allocation.remainingBytes).value}
            unit={splitAmount(allocation.remainingBytes).unit}
            caption="remaining"
            footnote={`of ${formatBytes(allocation.allocatedBytes)} shared with you`}
            tone={gaugeTone(100 - used)}
            label={`${formatBytes(allocation.remainingBytes)} remaining of ${formatBytes(allocation.allocatedBytes)}`}
          />
        </section>

        <div className="data__tiles">
          <StatTile
            icon={<DatabaseIcon />}
            label="Shared with you"
            value={splitAmount(allocation.allocatedBytes).value}
            unit={splitAmount(allocation.allocatedBytes).unit}
            detail={`in ${allocation.spaceName}`}
          />
          <StatTile
            icon={<PieIcon />}
            label="Used"
            value={splitAmount(allocation.usedBytes).value}
            unit={splitAmount(allocation.usedBytes).unit}
            tone="cyan"
          />
          <StatTile
            icon={<CalendarIcon />}
            label="Expires"
            value={new Date(allocation.expiresAt).toLocaleDateString()}
            tone="warning"
          />
          <StatTile
            icon={<GlobeIcon />}
            label="Status"
            value={describeStatus(allocation.status)}
            tone={allocation.status === 'active' ? 'success' : 'warning'}
          />
        </div>
      </div>

      {allocation.dailyLimitBytes && (
        <Card title="Today" subtitle="Your daily limit resets each day.">
          <UsageBar
            percent={dailyUsed ?? 0}
            label={`${formatBytes(allocation.usedTodayBytes)} of ${formatBytes(allocation.dailyLimitBytes)} today`}
          />
        </Card>
      )}

      <Card title="Your usage">
        <UsageChart usage={usage} />
      </Card>

      {allocation.status === 'paused' && (
        <Alert tone="warning">
          Your data is paused. That happens when you reach a limit, or when the owner pauses it.
        </Alert>
      )}
      {allocation.status === 'expired' && (
        <Alert tone="warning">This allocation has expired. Ask the owner for a new one.</Alert>
      )}

      <Card title="What you can see here">
        <p className="data__lede">
          This Pass shares data only. It gives you no access to the owner&rsquo;s computers, files,
          printers or settings, and you cannot see other people in this Space. {brand} records how
          much data you use and for how long — never what you visited or sent.
        </p>
      </Card>
    </div>
  );
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
  const brand = useBrandName();
  const [accountRef, setAccountRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      <Alert tone="info">
        <div>
          {brand} shares an allowance you already pay a provider for. It does not create data and
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Splits `64.8 GB` into its number and its unit.
 *
 * The gauge sets them in different sizes, and re-deriving the unit from the
 * byte count in two places is how the two end up disagreeing.
 */
export function splitAmount(bytes: string | number): { value: string; unit: string } {
  const formatted = formatBytes(bytes);
  const index = formatted.lastIndexOf(' ');
  return index === -1
    ? { value: formatted, unit: '' }
    : { value: formatted.slice(0, index), unit: formatted.slice(index + 1) };
}

function gaugeTone(remainingPercent: number): VizTone {
  if (remainingPercent <= 5) return 'danger';
  if (remainingPercent <= 20) return 'warning';
  return 'primary';
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Distinct hues for member avatars, in a fixed order so they do not shuffle. */
function avatarColour(index: number): string {
  const colours = ['#2f6bff', '#0e9f8f', '#7c5cff', '#e08a2f'];
  return colours[index % colours.length];
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
// Icons
// ---------------------------------------------------------------------------

const stroke = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function DatabaseIcon() {
  return (
    <svg {...stroke}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </svg>
  );
}

function PieIcon() {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v8h8" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 7.5a3 3 0 0 1 0 5.5M17 19a5.5 5.5 0 0 0-2-4.3" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...stroke}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" />
    </svg>
  );
}

function QrIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2.5v2.5H14zM19.5 14H20v6h-6v-2.5h5.5z" />
    </svg>
  );
}
