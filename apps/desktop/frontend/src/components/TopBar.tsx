import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, StatusDot } from '@netlink/ui';
import { AUDIT_ACTION_LABELS, type AuditRecord, type SpaceSummary } from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useSession } from '../state/session';
import { useBrandName } from '../state/brand';
import { NAV_SECTIONS, type SectionId } from '../screens/sections';
import './topbar.css';

/**
 * The bar across the top of every screen: where you are, which Space you are
 * looking at, and the three things that belong to the account rather than to
 * the section — search, what has happened recently, and who is signed in.
 *
 * Each control here does something. A search box that filters nothing and a
 * bell that never rings are worse than no search box and no bell: they teach
 * people that the chrome is decoration.
 */
export function TopBar({
  title,
  subtitle,
  spaces,
  activeSpace,
  onSelectSpace,
  onNavigate,
}: {
  title: string;
  subtitle?: string;
  spaces: SpaceSummary[];
  activeSpace: SpaceSummary | null;
  onSelectSpace: (id: string) => void;
  onNavigate: (section: SectionId) => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar__heading">
        <h1 className="topbar__title">{title}</h1>
        {subtitle && <p className="topbar__subtitle">{subtitle}</p>}
      </div>

      <div className="topbar__controls">
        {spaces.length > 0 && (
          <SpacePicker spaces={spaces} activeSpace={activeSpace} onSelect={onSelectSpace} />
        )}
        <GlobalSearch space={activeSpace} onNavigate={onNavigate} />
        <NotificationBell onNavigate={onNavigate} />
        <AccountMenu onNavigate={onNavigate} />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Space picker
// ---------------------------------------------------------------------------

function SpacePicker({
  spaces,
  activeSpace,
  onSelect,
}: {
  spaces: SpaceSummary[];
  activeSpace: SpaceSummary | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));

  return (
    <div className="topbar__menu" ref={ref}>
      <button
        type="button"
        className="topbar__pill"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <HomeIcon />
        <span className="topbar__pill-label">{activeSpace?.name ?? 'Select a Space'}</span>
        <ChevronIcon />
      </button>

      {open && (
        <ul className="topbar__dropdown" role="listbox" aria-label="Spaces">
          {spaces.map((space) => (
            <li key={space.id}>
              <button
                type="button"
                role="option"
                aria-selected={space.id === activeSpace?.id}
                className={`topbar__option${space.id === activeSpace?.id ? ' topbar__option--active' : ''}`}
                onClick={() => {
                  onSelect(space.id);
                  setOpen(false);
                }}
              >
                <span className="topbar__option-name">{space.name}</span>
                <span className="topbar__option-detail">
                  {space.onlineAgentCount > 0
                    ? `${space.onlineAgentCount} online`
                    : space.agentCount > 0
                      ? 'All offline'
                      : 'No computers yet'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type SearchHit = {
  id: string;
  label: string;
  detail: string;
  section: SectionId;
};

/**
 * Search across the sections and whatever the active Space contains.
 *
 * The index is built when the box is first opened rather than on every render:
 * a Space's computers and shared folders change rarely, and fetching them on
 * the chance that somebody might search would cost two requests per screen.
 */
function GlobalSearch({
  space,
  onNavigate,
}: {
  space: SpaceSummary | null;
  onNavigate: (section: SectionId) => void;
}) {
  const brand = useBrandName();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<SearchHit[] | null>(null);
  const ref = useDismissable(() => setOpen(false));

  const sectionHits = useMemo<SearchHit[]>(
    () =>
      NAV_SECTIONS.map((section) => ({
        id: `section:${section.id}`,
        label: section.label,
        detail: section.description,
        section: section.id,
      })),
    [],
  );

  const buildIndex = useCallback(async () => {
    if (!space) {
      setIndex([]);
      return;
    }
    try {
      const [agents, resources] = await Promise.all([
        api.listAgents(space.id),
        api.listResources(space.id),
      ]);

      setIndex([
        ...agents.map((agent) => ({
          id: `agent:${agent.id}`,
          label: agent.name,
          detail: agent.status === 'online' ? 'Computer · online' : 'Computer · offline',
          section: 'network' as SectionId,
        })),
        ...resources.map((resource) => ({
          id: `resource:${resource.id}`,
          label: resource.name,
          detail: `${resource.kind === 'folder' ? 'Folder' : 'Printer'} on ${resource.agentName}`,
          section: (resource.kind === 'folder' ? 'files' : 'printers') as SectionId,
        })),
      ]);
    } catch {
      // A Space the caller may not enumerate simply contributes nothing to the
      // index; the sections are still searchable.
      setIndex([]);
    }
  }, [space]);

  // A different Space is a different index.
  useEffect(() => setIndex(null), [space?.id]);

  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? [...sectionHits, ...(index ?? [])]
        .filter(
          (hit) =>
            hit.label.toLowerCase().includes(trimmed) || hit.detail.toLowerCase().includes(trimmed),
        )
        .slice(0, 8)
    : [];

  return (
    <div className="topbar__search" ref={ref}>
      <label className="topbar__search-field">
        <SearchIcon />
        <input
          type="search"
          className="topbar__search-input"
          placeholder="Search"
          aria-label={`Search ${brand}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            if (index === null) void buildIndex();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        />
      </label>

      {open && trimmed.length > 0 && (
        <ul className="topbar__dropdown topbar__dropdown--wide" aria-label="Search results">
          {results.length === 0 ? (
            <li className="topbar__empty">Nothing here matches “{query.trim()}”.</li>
          ) : (
            results.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="topbar__option"
                  onClick={() => {
                    onNavigate(hit.section);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="topbar__option-name">{hit.label}</span>
                  <span className="topbar__option-detail">{hit.detail}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Recent security events, from the same audit log the Activity screen shows.
 *
 * The count is of events since this window last opened the panel, so it means
 * "things you have not looked at" rather than "things that exist".
 */
function NotificationBell({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<number>(() => Date.now());
  const ref = useDismissable(() => setOpen(false));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const page = await api.activity(8);
        if (!cancelled) {
          setEvents(page.items);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Could not load recent activity.');
        }
      }
    };

    void load();
    // Slow on purpose. This is a background indicator, not a live feed; the
    // Activity screen is where someone goes to actually read the log.
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const unseen = events.filter((event) => new Date(event.createdAt).getTime() > seenAt).length;

  return (
    <div className="topbar__menu" ref={ref}>
      <button
        type="button"
        className="topbar__icon-button"
        aria-label={unseen > 0 ? `Notifications, ${unseen} new` : 'Notifications'}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setSeenAt(Date.now());
        }}
      >
        <BellIcon />
        {unseen > 0 && <span className="topbar__dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="topbar__dropdown topbar__dropdown--wide topbar__panel">
          <div className="topbar__panel-head">
            <strong>Recent activity</strong>
            <button
              type="button"
              className="topbar__link"
              onClick={() => {
                onNavigate('activity');
                setOpen(false);
              }}
            >
              View all
            </button>
          </div>

          {error && <p className="topbar__empty">{error}</p>}
          {!error && events.length === 0 && <p className="topbar__empty">Nothing yet.</p>}

          <ul className="topbar__events">
            {events.map((event) => (
              <li key={event.id} className="topbar__event">
                <StatusDot
                  tone={
                    event.outcome === 'success'
                      ? 'online'
                      : event.outcome === 'failure'
                        ? 'danger'
                        : 'warning'
                  }
                  label=""
                />
                <span className="topbar__event-text">
                  <span>{AUDIT_ACTION_LABELS[event.action] ?? event.action}</span>
                  <span className="topbar__event-time">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountMenu({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const { user, device, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));

  return (
    <div className="topbar__menu" ref={ref}>
      <button
        type="button"
        className="topbar__avatar"
        aria-label={`Account: ${user?.name ?? 'signed in'}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {initials(user?.name)}
      </button>

      {open && (
        <div className="topbar__dropdown topbar__dropdown--wide topbar__panel">
          <div className="topbar__identity">
            <span className="topbar__identity-name">{user?.name}</span>
            <span className="topbar__identity-email">{user?.email}</span>
          </div>

          <div className="topbar__identity-device">
            {device?.trusted ? (
              <Badge tone="success">Trusted device</Badge>
            ) : (
              <Badge tone="warning">Not a trusted device</Badge>
            )}
            <span className="topbar__event-time">{device?.name}</span>
          </div>

          <button
            type="button"
            className="topbar__menu-action"
            onClick={() => {
              onNavigate('settings');
              setOpen(false);
            }}
          >
            Settings
          </button>
          <button type="button" className="topbar__menu-action" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function initials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.slice(0, 1).toUpperCase()).join('') || '?';
}

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

/** Closes a popover on an outside click or Escape, the way a menu should. */
function useDismissable(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  return ref;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const strokeProps = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function HomeIcon() {
  return (
    <svg {...strokeProps}>
      <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...strokeProps} width={14} height={14}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...strokeProps}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg {...strokeProps} width={18} height={18}>
      <path d="M18 15V10a6 6 0 1 0-12 0v5l-1.5 3h15Z" />
      <path d="M10 21h4" />
    </svg>
  );
}
