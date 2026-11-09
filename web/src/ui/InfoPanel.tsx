import { useEffect } from 'react';
import type { Pick } from '../map/MapView';

export function InfoPanel({ pick, onClose }: { pick: Pick; onClose: () => void }) {
  const { content } = pick;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <aside className="panel info" aria-label={content.title}>
      <header className="info__header">
        <span className="info__kicker">{pick.moduleName}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer la fiche (Échap)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <h2 className="info__title">{content.title}</h2>
      {content.subtitle && <p className="info__subtitle">{content.subtitle}</p>}
      {content.fields && content.fields.length > 0 && (
        <dl className="info__fields">
          {content.fields.map(([label, value]) => (
            <div key={label} className="info__field">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {content.link && (
        <a className="info__link" href={content.link.href} target="_blank" rel="noreferrer">
          {content.link.label} ↗
        </a>
      )}
    </aside>
  );
}
