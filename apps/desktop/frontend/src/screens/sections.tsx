import type { ReactNode } from 'react';

/**
 * The main navigation.
 *
 * `phase` is the development phase that makes a section real. It is rendered in
 * the sidebar and on the placeholder screens so the interface never implies a
 * capability that is not built yet.
 */
export type SectionId =
  | 'spaces'
  | 'data'
  | 'network'
  | 'files'
  | 'printers'
  | 'activity'
  | 'automations'
  | 'settings'
  | 'devices'
  | 'power'
  | 'members';

export type NavSection = {
  id: SectionId;
  label: string;
  description: string;
  icon: ReactNode;
  phase: number;
  placeholder?: string;
  capabilities?: string[];
};

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'spaces',
    label: 'My Spaces',
    description: 'Your locations and everything connected to them',
    phase: 1,
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <circle cx="4.5" cy="5.5" r="2" />
        <circle cx="19.5" cy="5.5" r="2" />
        <circle cx="4.5" cy="18.5" r="2" />
        <circle cx="19.5" cy="18.5" r="2" />
        <path d="M9.6 10.2 6.3 7M14.4 10.2 17.7 7M9.6 13.8 6.3 17M14.4 13.8 17.7 17" />
      </>,
    ),
  },
  {
    id: 'data',
    label: 'Data Pool',
    description: 'Shared internet data, allocations and NetLink Passes',
    phase: 1,
    icon: icon(
      <>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>,
    ),
  },
  {
    id: 'network',
    label: 'Network Access',
    description: 'How this device reaches your Spaces',
    phase: 6,
    placeholder:
      'Network Access shows how a connection is being made — directly between your devices where possible, or through an end-to-end encrypted relay when your network will not allow a direct path.',
    capabilities: [
      'Direct peer connections over WebRTC with ICE, STUN and TURN',
      'End-to-end encrypted relay fallback',
      'Connection quality, latency and route visibility',
      'Optional WireGuard private networking, considered later',
    ],
    icon: icon(
      <>
        <path d="M12 20v-6" />
        <circle cx="12" cy="21" r="1" />
        <path d="M5 12.5a10 10 0 0 1 14 0" />
        <path d="M8.5 16a5.5 5.5 0 0 1 7 0" />
        <path d="M2 9a15 15 0 0 1 20 0" />
      </>,
    ),
  },
  {
    id: 'files',
    label: 'Files',
    description: 'Folders you have approved on your computers',
    phase: 5,
    placeholder:
      'Only folders you explicitly approve are ever visible here. NetLink never exposes a whole hard drive, and file contents are not stored in the cloud.',
    capabilities: [
      'Browse, download and upload inside approved folders only',
      'Resumable transfers with progress and integrity checking',
      'Deleting requires its own permission and a confirmation',
      'Direct encrypted transfer between your devices',
    ],
    icon: icon(
      <>
        <path d="M4 7a2 2 0 0 1 2-2h3.5l2 2.5H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      </>,
    ),
  },
  {
    id: 'printers',
    label: 'Printers',
    description: 'Printers shared from your computers',
    phase: 5,
    placeholder:
      'Printers installed on your home computer, shared only when you approve them. Invited members need the printers.use permission before they can send anything.',
    capabilities: [
      'Discover printers installed on the home Windows computer',
      'Online and ready status',
      'PDF print jobs with preview, copies, colour and paper size',
      'An audit entry for every job',
    ],
    icon: icon(
      <>
        <path d="M7 9V4h10v5" />
        <rect x="4" y="9" width="16" height="7" rx="2" />
        <path d="M7 14h10v6H7z" />
      </>,
    ),
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Security events on your account',
    phase: 1,
    icon: icon(
      <>
        <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
      </>,
    ),
  },
  {
    id: 'automations',
    label: 'Automations',
    description: 'Rules that run without you',
    phase: 7,
    placeholder:
      'Automations will let a Space act on a schedule or a condition — putting a computer to sleep at night, or pausing an allocation when it runs low.',
    capabilities: [
      'Scheduled power actions',
      'Data allocation thresholds',
      'Notifications when something needs your attention',
    ],
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      </>,
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Your account, devices and how this installation is protected',
    phase: 1,
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
      </>,
    ),
  },
];

/**
 * Sections reachable from the dashboard but not in the sidebar: they belong to
 * a Space rather than to the account, so they are opened from the map.
 */
export const DETAIL_SECTIONS: NavSection[] = [
  {
    id: 'devices',
    label: 'Trusted devices',
    description: 'Every device enrolled on your NetLink account',
    phase: 1,
    icon: null,
  },
  {
    id: 'power',
    label: 'Device Power and Wake',
    description: 'Turn on, restart, lock or shut down a computer',
    phase: 1,
    icon: null,
  },
  {
    id: 'members',
    label: 'Member Access',
    description: 'People you have invited, and exactly what they can reach',
    phase: 1,
    icon: null,
  },
];

export const ALL_SECTIONS = [...NAV_SECTIONS, ...DETAIL_SECTIONS];
