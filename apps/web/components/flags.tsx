/**
 * The short notes after a player's position on a row, e.g. "WR · market 13.7 ·
 * form ×1.10", each with its full wording as a tooltip.
 */

export interface Flag {
  readonly text: string;
  readonly title?: string;
  /** Colour: news in amber, adjustments in green, game context dimmed, plain for advice; none is a warning (e.g. an injury). */
  readonly tone?: 'news' | 'market' | 'game' | 'plain';
}

export function Flags({ items }: { items: readonly (Flag | null | undefined | false | '')[] }) {
  return (
    <>
      {items.filter((f): f is Flag => Boolean(f)).map((f, i) => (
        <span key={i} className={`flag${f.tone ? ` flag--${f.tone}` : ''}`} {...(f.title ? { title: f.title } : {})}>
          {' · '}
          {f.text}
        </span>
      ))}
    </>
  );
}
