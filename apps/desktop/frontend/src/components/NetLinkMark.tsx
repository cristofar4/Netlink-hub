/**
 * The NetLink connection mark: a hub with resources orbiting it, joined by
 * cyan paths.
 *
 * The same visual language the Spaces map uses, so the sign-in screen is
 * recognisably part of the same product. When `animated` is false — which the
 * caller derives from `prefers-reduced-motion` — the paths render solid and
 * static rather than as a dashed flow.
 */
export function NetLinkMark({ animated = true }: { animated?: boolean }) {
  const nodes = [
    { x: 60, y: 62, label: 'files' },
    { x: 240, y: 52, label: 'printer' },
    { x: 42, y: 196, label: 'data' },
    { x: 258, y: 206, label: 'people' },
  ];

  return (
    <svg
      className="netlink-mark"
      viewBox="0 0 300 260"
      width="300"
      height="260"
      role="img"
      aria-label="A NetLink hub connected to files, a printer, shared data and invited people"
    >
      <defs>
        <radialGradient id="nl-mark-core" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#5b8cff" />
          <stop offset="100%" stopColor="#1d3fa8" />
        </radialGradient>
        <filter id="nl-mark-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {nodes.map((node) => (
        <line
          key={`line-${node.label}`}
          x1="150"
          y1="130"
          x2={node.x}
          y2={node.y}
          stroke="var(--nl-cyan)"
          strokeWidth="1.5"
          strokeOpacity={animated ? 0.85 : 0.4}
          strokeLinecap="round"
          strokeDasharray={animated ? '5 9' : undefined}
          className={animated ? 'netlink-mark__flow' : undefined}
        />
      ))}

      {nodes.map((node) => (
        <g key={`node-${node.label}`}>
          <circle cx={node.x} cy={node.y} r="16" fill="var(--nl-surface-strong)" />
          <circle
            cx={node.x}
            cy={node.y}
            r="16"
            fill="none"
            stroke="var(--nl-border-strong)"
            strokeWidth="1"
          />
          <circle cx={node.x} cy={node.y} r="4" fill="var(--nl-cyan)" />
        </g>
      ))}

      <circle cx="150" cy="130" r="42" fill="url(#nl-mark-core)" filter="url(#nl-mark-glow)" />
      <circle
        cx="150"
        cy="130"
        r="42"
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1"
      />
      {animated && (
        <circle
          cx="150"
          cy="130"
          r="42"
          fill="none"
          stroke="var(--nl-cyan)"
          strokeWidth="1"
          className="netlink-mark__pulse"
        />
      )}
      <path
        d="M138 121 L150 113 L162 121 L162 141 L150 149 L138 141 Z"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
