import { Badge, Card } from '@netlink/ui';

/**
 * The screen a section shows before its phase is built.
 *
 * It states which phase makes the section real and what it will do, so nothing
 * in the app looks finished when it is not, and no control here can be clicked
 * to no effect.
 */
export function PlaceholderScreen({
  title,
  phase,
  description,
  capabilities,
}: {
  title: string;
  phase: number;
  description: string;
  capabilities: string[];
}) {
  return (
    <Card>
      <div className="nl-row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 'var(--nl-text-xl)', fontWeight: 700 }}>{title}</h2>
        <Badge tone="later">Phase {phase}</Badge>
      </div>

      <p
        className="nl-muted"
        style={{ marginTop: 12, fontSize: 'var(--nl-text-base)', lineHeight: 1.7, maxWidth: 640 }}
      >
        {description}
      </p>

      {capabilities.length > 0 && (
        <>
          <h3
            style={{
              marginTop: 28,
              fontSize: 'var(--nl-text-xs)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--nl-text-muted)',
            }}
          >
            What this section will do
          </h3>
          <ul
            className="nl-stack"
            style={{ gap: 10, marginTop: 12, padding: 0, listStyle: 'none' }}
          >
            {capabilities.map((capability) => (
              <li
                key={capability}
                style={{
                  position: 'relative',
                  paddingLeft: 22,
                  fontSize: 'var(--nl-text-sm)',
                  color: 'var(--nl-text-secondary)',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 7,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    border: '1px solid var(--nl-cyan-dim)',
                  }}
                />
                {capability}
              </li>
            ))}
          </ul>
        </>
      )}

      <p
        className="nl-dim"
        style={{ marginTop: 28, fontSize: 'var(--nl-text-xs)', lineHeight: 1.6 }}
      >
        Nothing on this screen is wired up yet. It is shown so the navigation is complete and so it
        is clear what NetLink does and does not do today.
      </p>
    </Card>
  );
}
