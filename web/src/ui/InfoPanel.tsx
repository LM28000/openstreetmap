import { useEffect, useSyncExternalStore } from 'react';
import type { InfoTable } from '../core/module';
import type { ModuleManager } from '../core/moduleManager';
import { useClockTime } from './hooks';

/**
 * Fiche de l'objet sélectionné. Elle est recalculée en continu : un train avance,
 * son retard change, le tableau d'une gare se met à jour.
 */
export function InfoPanel({ manager }: { manager: ModuleManager }) {
  const selection = useSyncExternalStore(manager.subscribe, manager.getSelection);
  const time = useClockTime(500);
  const info = selection ? manager.describeSelection(time) : null;
  const close = () => manager.setSelection(null, null);

  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') manager.setSelection(null, null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [manager, selection]);

  if (!selection || !info) return null;
  const { content } = info;
  const select = (value: unknown) => manager.setSelection(selection.moduleId, value);

  return (
    <aside className="panel info" aria-label={content.title}>
      <header className="info__header">
        <span className="info__kicker">{info.moduleName}</span>
        <div className="info__actions">
          {info.canFollow && (
            <button
              type="button"
              className={`follow-button${selection.following ? ' follow-button--on' : ''}`}
              aria-pressed={selection.following}
              onClick={() => manager.setFollowing(!selection.following)}
              title="La caméra suit la sélection. Déplacer la carte arrête le suivi."
            >
              {selection.following ? 'Suivi en cours' : 'Suivre'}
            </button>
          )}
          <button type="button" className="icon-button" onClick={close} aria-label="Fermer la fiche (Échap)">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
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
      {content.tables?.map((table) => (
        <Table key={table.title} table={table} onSelect={select} />
      ))}
      {content.link && (
        <a className="info__link" href={content.link.href} target="_blank" rel="noreferrer">
          {content.link.label} ↗
        </a>
      )}
    </aside>
  );
}

function Table({ table, onSelect }: { table: InfoTable; onSelect: (value: unknown) => void }) {
  return (
    <section className="info__table">
      <h3 className="info__table-title">{table.title}</h3>
      {table.rows.length === 0 ? (
        <p className="info__empty">{table.empty ?? 'Rien à afficher.'}</p>
      ) : (
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr
                key={i}
                className={`${row.tone ? `row--${row.tone}` : ''}${row.select !== undefined ? ' row--link' : ''}`}
                onClick={row.select !== undefined ? () => onSelect(row.select) : undefined}
                onKeyDown={
                  row.select !== undefined
                    ? (event) => {
                        if (event.key === 'Enter') onSelect(row.select);
                      }
                    : undefined
                }
                tabIndex={row.select !== undefined ? 0 : undefined}
              >
                {row.cells.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
