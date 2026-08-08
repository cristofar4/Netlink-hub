/**
 * A usage meter.
 *
 * Colour shifts from cyan through amber to red as the allowance runs down, but
 * the figure beside it always says the same thing in words — colour alone must
 * never be the only signal that someone is about to run out.
 */
export function UsageBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const tone = clamped >= 95 ? 'danger' : clamped >= 80 ? 'warning' : 'ok';

  return (
    <div className="usage">
      <div className="usage__head">
        <span className="usage__label">{label}</span>
        <span className={`usage__percent usage__percent--${tone}`}>{clamped.toFixed(0)}%</span>
      </div>
      <div
        className="usage__track"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`usage__fill usage__fill--${tone}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
