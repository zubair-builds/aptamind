import s from './ConfidenceIndicator.module.css';

export type ConfidenceLevelName = 'high' | 'medium' | 'low' | 'unknown';

const FILLED: Record<ConfidenceLevelName, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

/**
 * 3-segment confidence meter (high 3, medium 2, low 1, unknown 0 outlined). The level (and score,
 * when the API provides one) is its accessible name; `showLabel` also prints the level as a word,
 * so neither colour nor bars are the only visible signal.
 */
export function ConfidenceIndicator({
  level,
  score,
  showLabel = false,
}: {
  level: ConfidenceLevelName;
  score?: number | null;
  /** Also print the level as a word next to the bars. */
  showLabel?: boolean;
}) {
  const label = `Confidence: ${level}${typeof score === 'number' ? `, score ${score.toFixed(2)}` : ''}`;
  const filled = FILLED[level] ?? 0;
  const meter = (
    <span className={s.meter} data-level={level} role="img" aria-label={label} title={label}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={s.bar} data-on={i < filled || undefined} />
      ))}
    </span>
  );
  if (!showLabel) return meter;
  return (
    <span className={s.labelled}>
      {meter}
      <span className={s.word} aria-hidden="true">
        {level.charAt(0).toUpperCase() + level.slice(1)}
      </span>
    </span>
  );
}
