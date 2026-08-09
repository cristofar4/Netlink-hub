import { useId, type ReactNode } from 'react';
import './spacemap.css';

/**
 * The picture of a Space: one hub, its connections, and what sits at the end of
 * each one.
 *
 * The map is the product's centrepiece, so it is held to the same rule as the
 * rest of the interface — every node shows the state the server reported. A
 * connection that is not live is drawn as a faint dashed path rather than
 * omitted, because "you could share a printer here" and "a printer is shared
 * here" are different facts and the map has to distinguish them.
 *
 * Positions are angles on an ellipse rather than fixed coordinates, so the
 * layout survives a node being added or removed without anything overlapping.
 */

export type MapNodeIcon = 'monitor' | 'folder' | 'printer' | 'people' | 'data';

export type MapNode = {
  id: string;
  label: string;
  detail: string;
  icon: MapNodeIcon;
  tone: 'online' | 'offline' | 'warning';
  /** Degrees clockwise from twelve o'clock. */
  angle: number;
  /** True when this connection is actually carrying something. */
  live?: boolean;
  /** 0–100. Draws a progress ring around the node, as the Data Pool does. */
  ring?: number;
  onOpen: () => void;
};

const WIDTH = 900;
const HEIGHT = 420;
const CENTRE_X = WIDTH / 2;
const CENTRE_Y = HEIGHT / 2;
const RADIUS_X = 330;
const RADIUS_Y = 150;

export function SpaceMap({
  nodes,
  centreLabel,
  centreDetail,
  centreTone = 'secure',
  animated,
}: {
  nodes: MapNode[];
  centreLabel: string;
  centreDetail: string;
  centreTone?: 'secure' | 'warning';
  animated: boolean;
}) {
  const gradientId = useId();

  const positioned = nodes.map((node) => {
    const radians = ((node.angle - 90) * Math.PI) / 180;
    return {
      ...node,
      x: CENTRE_X + Math.cos(radians) * RADIUS_X,
      y: CENTRE_Y + Math.sin(radians) * RADIUS_Y,
    };
  });

  return (
    <div className="map">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="map__svg"
        role="img"
        aria-label={`${centreLabel}: ${centreDetail}. ${positioned
          .map((node) => `${node.label}, ${node.detail}`)
          .join('. ')}`}
      >
        <defs>
          <radialGradient id={gradientId}>
            <stop offset="0%" stopColor="#5b8cff" />
            <stop offset="100%" stopColor="#16307e" />
          </radialGradient>
        </defs>

        {positioned.map((node) => (
          <line
            key={`edge-${node.id}`}
            x1={CENTRE_X}
            y1={CENTRE_Y}
            x2={node.x}
            y2={node.y}
            className={`map__edge${node.live ? ' map__edge--live' : ''}${
              node.live && animated ? ' map__edge--flow' : ''
            }`}
          />
        ))}

        <circle cx={CENTRE_X} cy={CENTRE_Y} r="58" fill={`url(#${gradientId})`} />
        <circle
          cx={CENTRE_X}
          cy={CENTRE_Y}
          r="58"
          fill="none"
          className={`map__core-ring map__core-ring--${centreTone}`}
        />
        {animated && (
          <circle cx={CENTRE_X} cy={CENTRE_Y} r="58" fill="none" className="map__core-pulse" />
        )}
      </svg>

      <div className="map__core-label" aria-hidden="true">
        <span className="map__core-icon">
          <HomeGlyph />
        </span>
        <strong>{centreLabel}</strong>
        <span className={`map__core-state map__core-state--${centreTone}`}>{centreDetail}</span>
      </div>

      {positioned.map((node) => (
        <button
          key={node.id}
          type="button"
          className={`map__node map__node--${node.tone}`}
          style={{ left: `${(node.x / WIDTH) * 100}%`, top: `${(node.y / HEIGHT) * 100}%` }}
          onClick={node.onOpen}
        >
          <span className="map__node-disc" aria-hidden="true">
            {node.ring !== undefined && <NodeRing percent={node.ring} />}
            <span className="map__node-icon">{glyph(node.icon)}</span>
          </span>
          <span className="map__node-text">
            <span className="map__node-label">{node.label}</span>
            <span className="map__node-detail">
              <span className="map__node-dot" aria-hidden="true" />
              {node.detail}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The thin progress ring around the Data Pool node. */
function NodeRing({ percent }: { percent: number }) {
  const radius = 27;
  const circumference = 2 * Math.PI * radius;
  const safe = Math.min(Math.max(percent, 0), 100);
  return (
    <svg className="map__node-ring" viewBox="0 0 60 60" aria-hidden="true">
      <circle className="map__node-ring-track" cx="30" cy="30" r={radius} fill="none" />
      <circle
        className="map__node-ring-value"
        cx="30"
        cy="30"
        r={radius}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - safe / 100)}
        // Starts at twelve o'clock, so the ring fills the way a clock reads.
        transform="rotate(-90 30 30)"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const stroke = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function glyph(icon: MapNodeIcon): ReactNode {
  switch (icon) {
    case 'monitor':
      return (
        <svg {...stroke}>
          <rect x="3" y="4.5" width="18" height="12" rx="2" />
          <path d="M9 20h6M12 16.5V20" />
        </svg>
      );
    case 'folder':
      return (
        <svg {...stroke}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      );
    case 'printer':
      return (
        <svg {...stroke}>
          <path d="M7 9V4h10v5" />
          <rect x="4" y="9" width="16" height="7" rx="2" />
          <path d="M7 14h10v6H7z" />
        </svg>
      );
    case 'people':
      return (
        <svg {...stroke}>
          <circle cx="9" cy="9" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
          <path d="M16 7.5a3 3 0 0 1 0 5.5M17 19a5.5 5.5 0 0 0-2-4.3" />
        </svg>
      );
    case 'data':
      return (
        <svg {...stroke}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 4.5V12h7.5" />
        </svg>
      );
  }
}

function HomeGlyph() {
  return (
    <svg {...stroke} width={20} height={20}>
      <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
    </svg>
  );
}
