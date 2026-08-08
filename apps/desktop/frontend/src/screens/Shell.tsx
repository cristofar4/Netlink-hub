import { useState } from 'react';
import { Badge, StatusDot } from '@netlink/ui';
import { useSession } from '../state/session';
import { ALL_SECTIONS, NAV_SECTIONS, type SectionId } from './sections';
import { SpacesScreen } from './SpacesScreen';
import { DataPoolScreen } from './DataPoolScreen';
import { MemberAccessScreen } from './MemberAccessScreen';
import { PowerScreen } from './PowerScreen';
import { FilesScreen } from './FilesScreen';
import { PrintersScreen } from './PrintersScreen';
import { SpaceProvider, useSpaces } from '../state/space';
import { DevicesScreen } from './DevicesScreen';
import { ActivityScreen } from './ActivityScreen';
import { SettingsScreen } from './SettingsScreen';
import { PlaceholderScreen } from './PlaceholderScreen';
import './shell.css';

/**
 * The signed-in application frame: a fixed sidebar and one section at a time.
 *
 * Sections that Phase 1 does not implement render a PlaceholderScreen that
 * states which phase builds them. Nothing here is a button that silently does
 * nothing.
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
  const { user, device, signOut } = useSession();
  // Detail sections (trusted devices, power, members) are opened from the map
  // rather than the sidebar, so the lookup spans both lists.
  const current = ALL_SECTIONS.find((item) => item.id === section);

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

        <div className="shell__sidebar-footer">
          <div className="shell__account">
            <div className="shell__avatar" aria-hidden="true">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="shell__account-detail">
              <div className="shell__account-name">{user?.name}</div>
              <div className="shell__account-email">{user?.email}</div>
            </div>
          </div>
          <button type="button" className="shell__signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="shell__main">
        <header className="shell__topbar">
          <div>
            <h1 className="shell__title">{current?.label}</h1>
            <p className="shell__subtitle">{current?.description}</p>
          </div>
          <div className="nl-spacer" />
          <div className="shell__device">
            {device?.trusted ? (
              <Badge tone="success">Trusted device</Badge>
            ) : (
              <Badge tone="warning">Not trusted</Badge>
            )}
            <StatusDot tone="secure" label={device?.name ?? 'This device'} />
          </div>
        </header>

        <div className="shell__content">
          <SectionContent section={section} onNavigate={setSection} />
        </div>
      </main>
    </div>
  );
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
      return <SpacesScreen onNavigate={onNavigate} />;
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
    case 'devices':
      return <DevicesScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'settings':
      return <SettingsScreen />;
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
