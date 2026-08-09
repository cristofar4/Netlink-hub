import { useState } from 'react';
import { useSession } from '../state/session';
import { ALL_SECTIONS, NAV_SECTIONS, type SectionId } from './sections';
import { OverviewScreen } from './OverviewScreen';
import { DataPoolScreen } from './DataPoolScreen';
import { MemberAccessScreen } from './MemberAccessScreen';
import { PowerScreen } from './PowerScreen';
import { FilesScreen } from './FilesScreen';
import { PrintersScreen } from './PrintersScreen';
import { RemoteScreen } from './RemoteScreen';
import { SpaceProvider, useSpaces } from '../state/space';
import { DevicesScreen } from './DevicesScreen';
import { ActivityScreen } from './ActivityScreen';
import { SettingsScreen } from './SettingsScreen';
import { PlaceholderScreen } from './PlaceholderScreen';
import { TopBar } from '../components/TopBar';
import './shell.css';

/**
 * The signed-in application frame: a fixed sidebar, a top bar and one section
 * at a time.
 *
 * Sections that are not built yet render a PlaceholderScreen saying which phase
 * builds them. Nothing here is a button that silently does nothing.
 */
export function Shell() {
  return (
    <SpaceProvider>
      <ShellContent />
    </SpaceProvider>
  );
}

function ShellContent() {
  const [section, setSection] = useState<SectionId>('spaces');
  const { user } = useSession();
  const { spaces, activeSpace, setActiveSpaceId } = useSpaces();

  // Detail sections (trusted devices, power, members) are opened from the
  // dashboard rather than the sidebar, so the lookup spans both lists.
  const current = ALL_SECTIONS.find((item) => item.id === section);
  const onOverview = section === 'spaces';

  return (
    <div className="shell">
      <nav className="shell__sidebar" aria-label="Main">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true" />
          <span className="shell__brand-name">NetLink</span>
        </div>

        <ul className="shell__nav">
          {NAV_SECTIONS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`shell__nav-item${section === item.id ? ' shell__nav-item--active' : ''}`}
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? 'page' : undefined}
              >
                <span className="shell__nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="shell__nav-label">{item.label}</span>
                {item.phase > 1 && (
                  <span className="shell__nav-phase" aria-hidden="true">
                    {item.phase}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {/*
         * The standing security claim, in the corner of every screen.
         *
         * It states what NetLink does architecturally — remote sessions and
         * transfers are encrypted end to end between the two devices — rather
         * than reporting a live measurement, so it says "connections are" and
         * not "your connection is".
         */}
        <footer className="shell__secure">
          <span className="shell__secure-mark" aria-hidden="true">
            <LockIcon />
          </span>
          <span className="shell__secure-text">
            <strong>End-to-end encrypted</strong>
            <span>Sessions and transfers stay between your devices</span>
          </span>
        </footer>
      </nav>

      <main className="shell__main">
        <TopBar
          title={onOverview ? greeting(user?.name) : (current?.label ?? 'NetLink')}
          subtitle={onOverview ? undefined : current?.description}
          spaces={spaces}
          activeSpace={activeSpace}
          onSelectSpace={setActiveSpaceId}
          onNavigate={setSection}
        />

        <div className="shell__content">
          <SectionContent section={section} onNavigate={setSection} />
        </div>
      </main>
    </div>
  );
}

/** "Good morning, Christopher" — the time of day comes from the local clock. */
export function greeting(name: string | undefined, now: Date = new Date()): string {
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

function SectionContent({
  section,
  onNavigate,
}: {
  section: SectionId;
  onNavigate: (section: SectionId) => void;
}) {
  const { activeSpace } = useSpaces();

  switch (section) {
    case 'spaces':
      return <OverviewScreen onNavigate={onNavigate} />;
    case 'data':
      return <DataPoolScreen space={activeSpace} />;
    case 'members':
      return <MemberAccessScreen space={activeSpace} />;
    case 'power':
      return <PowerScreen space={activeSpace} />;
    case 'files':
      return <FilesScreen space={activeSpace} />;
    case 'printers':
      return <PrintersScreen space={activeSpace} />;
    case 'network':
      return <RemoteScreen space={activeSpace} onNavigate={onNavigate} />;
    case 'devices':
      return <DevicesScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'settings':
      return <SettingsScreen onNavigate={onNavigate} />;
    default: {
      const meta = ALL_SECTIONS.find((item) => item.id === section);
      return (
        <PlaceholderScreen
          title={meta?.label ?? 'Coming later'}
          phase={meta?.phase ?? 2}
          description={meta?.placeholder ?? ''}
          capabilities={meta?.capabilities ?? []}
        />
      );
    }
  }
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V7.8a3.5 3.5 0 1 1 7 0v2.7" />
    </svg>
  );
}
