/**
 * The short notes after a player's position on a row, e.g. "WR · market 13.7 ·
 * form ×1.10", each with its full wording as a tooltip.
 */

export interface Flag {
  readonly text: string;
  readonly title?: string;
  /** Drawn in place of the text, in the flag's colour. Only a padlock so far. */
  readonly icon?: 'lock';
  /** Colour: news in amber, adjustments in green, game context dimmed, a lock in gold, plain for advice; none is a warning (e.g. an injury). */
  readonly tone?: 'news' | 'market' | 'game' | 'plain' | 'lock';
}

/**
 * The padlock shown beside a locked player's name: their game has started, so
 * no move involving them can be made.
 */
export function LockTag() {
  return (
    <span className="flag flag--lock lock-tag" title="Their game has started, so they cannot be moved.">
      <LockIcon label="Locked" />
    </span>
  );
}

/** A padlock that takes the colour of the text around it. */
function LockIcon({ label }: { label: string }) {
  return (
    <svg className="flag__icon" viewBox="0 0 10 12" role="img" aria-label={label} fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="0.7" y="5" width="8.6" height="6.3" rx="1.2" fill="currentColor" stroke="none" />
      <path d="M2.8 5V3.4a2.2 2.2 0 0 1 4.4 0V5" />
    </svg>
  );
}

export function Flags({ items }: { items: readonly (Flag | null | undefined | false | '')[] }) {
  return (
    <>
      {items.filter((f): f is Flag => Boolean(f)).map((f, i) => (
        <span key={i} className={`flag${f.tone ? ` flag--${f.tone}` : ''}`} {...(f.title ? { title: f.title } : {})}>
          {' · '}
          {f.icon === 'lock' ? <LockIcon label={f.text} /> : f.text}
        </span>
      ))}
    </>
  );
}
