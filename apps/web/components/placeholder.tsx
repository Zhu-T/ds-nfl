import Link from 'next/link';

/**
 * An unbuilt screen, stated plainly.
 *
 * An empty screen should say what it will do and what the next step is, rather
 * than apologising or showing a spinner for work that was never started.
 */
export function Placeholder({
  title,
  what,
  needs,
}: {
  title: string;
  what: string;
  needs: string;
}) {
  return (
    <section className="placeholder">
      <h1 className="placeholder__title">{title}</h1>
      <p style={{ maxWidth: '38rem', margin: '0 auto 0.75rem' }}>{what}</p>
      <p style={{ maxWidth: '38rem', margin: '0 auto 1.25rem', color: 'var(--text-dim)' }}>
        {needs}
      </p>
      <Link href="/" className="btn">
        Back to lineup
      </Link>
    </section>
  );
}
