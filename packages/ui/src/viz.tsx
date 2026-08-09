import { useId, type ReactNode } from 'react';

/**
 * The measuring instruments.
 *
 * Everything here draws a number someone has to act on — how much data is left,
 * whether a week was busy, how a connection is holding up. Three rules follow
 * from that and are worth stating once rather than repeating in each component:
 *
 *   * A chart is a picture of a number, so every one of these carries the
 *     number in text as well. Screen readers get a sentence, and nobody has to
 *     estimate a value by eye off a bar.
 *   * Nothing invents data. An empty series draws an empty chart with its axis
 *     intact, rather than a plausible-looking shape.
 *   * Colour never carries meaning on its own. Tone changes the hue *and* the
 *     label, because a red ring and a blue ring look identical to a good number
 *     of people.
 */

export type VizTone = 'primary' | 'cyan' | 'success' | 'warning' | 'danger';

// ---------------------------------------------------------------------------
// Radial gauge
// ---------------------------------------------------------------------------

/** Where the ring opens, in degrees of the full circle. */
const GAUGE_SWEEP = 274;
const GAUGE_START = 133;

export type RadialGaugeProps = {
  /** 0–100. Values outside are clamped rather than drawn off the ring. */
  percent: number;
  /** The headline figure, already formatted (e.g. `64.8`). */
  value: string;
  /** The unit shown beside the figure (e.g. `GB`). */
  unit?: string;
  /** The line under the figure (e.g. `remaining`). */
  caption?: string;
  /** A smaller line under that (e.g. `of 100 GB total`). */
  footnote?: string;
  size?: number;
  thickness?: number;
  tone?: VizTone;
  /** Read out instead of the assembled default, when that would be clearer. */
  label?: string;
};

/**
 * The ring on the Data Pool screen.
 *
 * It is drawn as an arc that stops short of a full circle, so "nearly empty"
 * and "completely full" cannot be confused at a glance — a closed ring has no
 * visible start, and at 99% and 1% it looks much the same.
 */
export function RadialGauge({
  percent,
  value,
  unit,
  caption,
  footnote,
  size = 208,
  thickness = 14,
  tone = 'primary',
  label,
}: RadialGaugeProps) {
  const gradientId = useId();
  const safe = clampPercent(percent);
  const radius = (size - thickness) / 2;
  const centre = size / 2;
  const arc = (Math.PI * 2 * radius * GAUGE_SWEEP) / 360;

  const path = describeArc(centre, centre, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP);

  return (
    <figure className={`nl-gauge nl-gauge--${tone}`} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label ?? `${value}${unit ? ` ${unit}` : ''} ${caption ?? ''}`.trim()}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" className="nl-gauge__from" />
            <stop offset="100%" className="nl-gauge__to" />
          </linearGradient>
        </defs>

        <path className="nl-gauge__track" d={path} strokeWidth={thickness} fill="none" />
        <path
          className="nl-gauge__value"
          d={path}
          strokeWidth={thickness}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeDasharray={arc}
          // Drawn from the start of the arc: the offset is the part not yet
          // filled, so 0% shows nothing rather than a stub of colour.
          strokeDashoffset={arc * (1 - safe / 100)}
        />
      </svg>

      <figcaption className="nl-gauge__readout">
        <span className="nl-gauge__value-text">
          {value}
          {unit && <span className="nl-gauge__unit">{unit}</span>}
        </span>
        {caption && <span className="nl-gauge__caption">{caption}</span>}
        {footnote && <span className="nl-gauge__footnote">{footnote}</span>}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

export type StatTileProps = {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: string;
  tone?: VizTone;
  onOpen?: () => void;
};

/** One headline number with its name — the row across the top of a screen. */
export function StatTile({
  icon,
  label,
  value,
  unit,
  detail,
  tone = 'primary',
  onOpen,
}: StatTileProps) {
  const body = (
    <>
      {icon && (
        <span className="nl-tile__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="nl-tile__body">
        <span className="nl-tile__label">{label}</span>
        <span className="nl-tile__value">
          {value}
          {unit && <span className="nl-tile__unit">{unit}</span>}
        </span>
        {detail && <span className="nl-tile__detail">{detail}</span>}
      </span>
    </>
  );

  if (onOpen) {
    return (
      <button type="button" className={`nl-tile nl-tile--${tone} nl-tile--button`} onClick={onOpen}>
        {body}
      </button>
    );
  }
  return <div className={`nl-tile nl-tile--${tone}`}>{body}</div>;
}

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

export type ChartBar = {
  /** The x-axis key. Unique within the series. */
  key: string;
  /** Shown under the bar; omit on most bars so the axis stays readable. */
  label?: string;
  value: number;
  /** What a reader should be told this bar means, e.g. `2.4 GB on 3 May`. */
  title: string;
};

export type BarChartProps = {
  bars: ChartBar[];
  /** Turns an axis value into its label (e.g. bytes into `15 GB`). */
  formatTick: (value: number) => string;
  /** Overrides the top of the axis. Defaults to the tallest bar. */
  max?: number;
  /** How many horizontal gridlines, including zero. */
  ticks?: number;
  height?: number;
  emptyMessage?: string;
  caption: string;
};

/**
 * Daily usage.
 *
 * The axis is built from the data rather than fixed, but it is rounded up to a
 * whole tick so the tallest bar never touches the ceiling — a bar flush with
 * the top of a chart reads as "at the limit", which is a different claim from
 * "the largest in this window".
 */
export function BarChart({
  bars,
  formatTick,
  max,
  ticks = 5,
  height = 210,
  emptyMessage = 'No usage recorded yet.',
  caption,
}: BarChartProps) {
  const peak = max ?? Math.max(0, ...bars.map((bar) => bar.value));
  const top = niceCeiling(peak);
  const gridlines = Array.from(
    { length: ticks },
    (_, index) => (top / (ticks - 1)) * index,
  ).reverse();
  const hasData = bars.some((bar) => bar.value > 0);

  return (
    <figure className="nl-chart">
      <div className="nl-chart__frame" style={{ height }}>
        {/*
         * Keyed by position rather than by value: an empty series has a flat
         * axis where every tick is zero, and duplicate keys make React drop
         * gridlines. The position is what identifies a gridline anyway.
         */}
        <div className="nl-chart__axis" aria-hidden="true">
          {gridlines.map((tick, index) => (
            <span key={index} className="nl-chart__tick">
              {formatTick(tick)}
            </span>
          ))}
        </div>

        <div className="nl-chart__plot" role="img" aria-label={caption}>
          {gridlines.map((_, index) => (
            <span key={index} className="nl-chart__grid" aria-hidden="true" />
          ))}

          <div className="nl-chart__bars">
            {bars.map((bar) => (
              <div key={bar.key} className="nl-chart__slot" title={bar.title}>
                <div
                  className="nl-chart__bar"
                  // A day with no usage keeps its slot but draws nothing, so a
                  // quiet week is visibly quiet rather than missing.
                  style={{ height: top > 0 ? `${(bar.value / top) * 100}%` : '0%' }}
                />
              </div>
            ))}
          </div>

          {!hasData && <p className="nl-chart__empty">{emptyMessage}</p>}
        </div>
      </div>

      <div className="nl-chart__labels" aria-hidden="true">
        {bars.map((bar) => (
          <span key={bar.key} className="nl-chart__label">
            {bar.label ?? ''}
          </span>
        ))}
      </div>
      <figcaption className="nl-visually-hidden">{caption}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export type SparklineProps = {
  points: number[];
  /** The axis ceiling. Fixed by the caller so the line does not rescale itself. */
  max: number;
  label: string;
  /** Drawn at the right-hand end, e.g. `Now`. */
  trailingLabel?: string;
  height?: number;
  tone?: VizTone;
};

/**
 * A small line of recent history, as on the remote session panel.
 *
 * The scale is the caller's, not the data's. A sparkline that renormalises
 * every time a sample arrives makes a steady connection look as dramatic as a
 * failing one.
 */
export function Sparkline({
  points,
  max,
  label,
  trailingLabel,
  height = 84,
  tone = 'cyan',
}: SparklineProps) {
  const width = 100;
  const ceiling = max > 0 ? max : 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const line = points
    .map((point, index) => {
      const x = index * step;
      const y = 100 - (clamp(point, 0, ceiling) / ceiling) * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <figure className={`nl-spark nl-spark--${tone}`}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        height={height}
        role="img"
        aria-label={label}
      >
        <line className="nl-spark__grid" x1="0" y1="50" x2="100" y2="50" />
        {points.length > 1 && (
          <path className="nl-spark__line" d={line} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {trailingLabel && <figcaption className="nl-spark__trailing">{trailingLabel}</figcaption>}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export type MeterProps = {
  percent: number;
  label?: ReactNode;
  value?: ReactNode;
  tone?: VizTone;
  /** Announced instead of the percentage when the caller has better words. */
  ariaLabel?: string;
};

/** A labelled bar — one member's share, one folder's transfer. */
export function Meter({ percent, label, value, tone = 'primary', ariaLabel }: MeterProps) {
  const safe = clampPercent(percent);
  return (
    <div className="nl-meter">
      {(label || value) && (
        <div className="nl-meter__head">
          {label && <span className="nl-meter__label">{label}</span>}
          {value && <span className="nl-meter__value">{value}</span>}
        </div>
      )}
      <div
        className={`nl-meter__track nl-meter__track--${tone}`}
        role="progressbar"
        aria-valuenow={Math.round(safe)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel}
      >
        <div className="nl-meter__fill" style={{ width: `${safe}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export type ToggleProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Sits beside the switch, e.g. `Enabled`. */
  stateLabel?: string;
  icon?: ReactNode;
  description?: string;
  disabled?: boolean;
};

/**
 * A setting that is on or off.
 *
 * The state is in text next to the switch, not only in its position and colour.
 * "Is this on?" should not require knowing which way the product's switches
 * point.
 */
export function Toggle({
  checked,
  onChange,
  label,
  stateLabel,
  icon,
  description,
  disabled,
}: ToggleProps) {
  return (
    <div className="nl-toggle">
      {icon && (
        <span className="nl-toggle__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="nl-toggle__text">
        <span className="nl-toggle__label">{label}</span>
        {description && <span className="nl-toggle__description">{description}</span>}
      </span>
      {stateLabel && (
        <span className={`nl-toggle__state${checked ? ' nl-toggle__state--on' : ''}`}>
          {stateLabel}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="nl-toggle__switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="nl-toggle__knob" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub navigation
// ---------------------------------------------------------------------------

export type SubNavItem<Id extends string> = {
  id: Id;
  label: string;
  icon?: ReactNode;
};

export function SubNav<Id extends string>({
  items,
  active,
  onSelect,
  label,
}: {
  items: ReadonlyArray<SubNavItem<Id>>;
  active: Id;
  onSelect: (id: Id) => void;
  label: string;
}) {
  return (
    <nav className="nl-subnav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`nl-subnav__item${item.id === active ? ' nl-subnav__item--active' : ''}`}
          aria-current={item.id === active ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.icon && (
            <span className="nl-subnav__icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          {item.label}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Geometry and scales
// ---------------------------------------------------------------------------

export function clampPercent(percent: number): number {
  return clamp(Number.isFinite(percent) ? percent : 0, 0, 100);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Rounds an axis up to a round number: 1, 2 or 5 times a power of ten.
 *
 * Without this the top gridline reads `17.3 GB`, which nobody can divide by
 * eye. Zero stays zero — an empty chart draws a flat axis rather than one
 * invented ceiling.
 */
export function niceCeiling(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalised = peak / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** A point on a circle, with 0° at twelve o'clock and angles running clockwise. */
function polar(cx: number, cy: number, radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

/** An SVG arc path between two angles. */
export function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polar(cx, cy, radius, startAngle);
  const end = polar(cx, cy, radius, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}
