import { useEffect, useRef, useState } from 'react';
import type { InfoAction, InfoContent, InfoStatus, InfoTable } from '../core/module';
import type { ModuleManager, Selection } from '../core/moduleManager';
import { shareUrl } from '../core/shareState';
import { useSelectionInfo } from './hooks';
import { Icon } from './icons';

type SelectionInfo = NonNullable<ReturnType<ModuleManager['describeSelection']>>;

/**
 * Fiche de l'objet sélectionné, à droite sur ordinateur. Elle est recalculée en continu :
 * un train avance, son retard change, le tableau d'une gare se met à jour.
 */
export function InfoPanel({ manager }: { manager: ModuleManager }) {
  const { selection, info } = useSelectionInfo(manager);
  if (!selection || !info) return null;
  return (
    <aside className="panel info" aria-label={info.content.title}>
      <InfoBody manager={manager} selection={selection} info={info} />
    </aside>
  );
}

/** Contenu de la fiche (ordinateur et feuille du téléphone). */
export function InfoBody({ manager, selection, info }: { manager: ModuleManager; selection: Selection; info: SelectionInfo }) {
  const { content } = info;
  const select = (value: unknown) => manager.setSelection(selection.moduleId, value);
  const figures = content.figures?.slice(0, 3) ?? [];

  return (
    <>
      <header className="info__head">
        <div className="info__titles">
          <span className="kicker">{content.kind ?? info.moduleName}</span>
          <h2 className="info__title">{content.title}</h2>
          {content.subtitle && <p className="info__subtitle">{content.subtitle}</p>}
        </div>
        <button type="button" className="icon-button" onClick={() => manager.setSelection(null, null)} aria-label="Fermer la fiche (Échap)">
          <Icon name="x" size={16} />
        </button>
      </header>
      {content.status && <StatusBadge status={content.status} />}
      {figures.length > 0 && (
        <dl className="figures">
          {figures.map((figure) => (
            <div key={figure.label} className="figures__cell">
              <dt className="figures__label">{figure.label}</dt>
              <dd className="figures__value">
                {figure.value}
                {figure.unit && <span className="figures__unit"> {figure.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
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
      {content.note && <p className="info__note">{content.note}</p>}
      {content.tables?.map((table) => (
        <Table key={table.title} table={table} onSelect={select} />
      ))}
      <Actions manager={manager} selection={selection} info={info} content={content} />
    </>
  );
}

function StatusBadge({ status }: { status: InfoStatus }) {
  return (
    <span className={`badge badge--${status.tone}`}>
      {status.tone !== 'none' && <span className="badge__dot" aria-hidden="true" />}
      {status.text}
    </span>
  );
}

function Actions({ manager, selection, info, content }: { manager: ModuleManager; selection: Selection; info: SelectionInfo; content: InfoContent }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const share = async () => {
    const copiedOk = await copyText(shareUrl(manager));
    if (!copiedOk) window.prompt('Copiez l’adresse de cette vue :', window.location.href);
    setCopied(copiedOk);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="actions">
      {info.canFollow && (
        <button
          type="button"
          className={`btn btn--primary${selection.following ? ' btn--on' : ''}`}
          aria-pressed={selection.following}
          onClick={() => manager.setFollowing(!selection.following)}
          title="La caméra suit la sélection. Déplacer la carte arrête le suivi."
        >
          <Icon name="follow" size={16} />
          {selection.following ? 'Suivi en cours' : 'Suivre'}
        </button>
      )}
      <button type="button" className="btn" onClick={share} title="Copier l’adresse de cette vue, sélection comprise">
        <Icon name={copied ? 'check' : 'share'} size={16} />
        <span aria-live="polite">{copied ? 'Adresse copiée' : 'Partager'}</span>
      </button>
      {content.actions?.map((action, i) => (
        <ActionButton key={`${action.label}-${i}`} action={action} primary={action.primary && !info.canFollow} />
      ))}
      {content.link && (
        <a className="btn" href={content.link.href} target="_blank" rel="noreferrer">
          {content.link.label}
          <Icon name="external" size={14} />
        </a>
      )}
    </div>
  );
}

function ActionButton({ action, primary }: { action: InfoAction; primary?: boolean }) {
  const className = `btn${primary ? ' btn--primary' : ''}`;
  if (action.href) {
    return (
      <a className={className} href={action.href} target="_blank" rel="noreferrer">
        {action.label}
        <Icon name="external" size={14} />
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

/** Copie dans le presse-papiers ; le site tourne parfois en http sur le réseau local, où l'API moderne est absente. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refusé : on essaie l'ancienne méthode
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Heures, retards et mesures (« 08:40 », « +4 min », « 293 km/h ») : en police à chasse fixe, pour que les colonnes s'alignent. */
const NUMERIC_CELL = /^[+−-]?\d[\d:.,   ]*(?:\s?(?:min|h|s|km\/h|km|m|%|°|m\/s))?$/;

/** Noir ou blanc, selon ce qui se lit le mieux sur `hex` (luminance relative approchée). */
function readableOn(hex: string): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0)) / 255 > 0.6 ? '#141a26' : '#ffffff';
}

/** Pastille d'une ligne aux couleurs du GTFS (hexadécimal sans dièse) ; sans couleur, une pastille neutre. */
function LineBadge({ text, color, textColor }: { text: string; color?: string; textColor?: string }) {
  const valid = (c?: string) => (c && /^[0-9a-fA-F]{6}$/.test(c) ? c : undefined);
  const background = valid(color);
  // La couleur du texte du GTFS quand il la donne, sinon noir ou blanc selon le fond.
  const official = valid(textColor);
  const ink = background ? (official ? `#${official}` : readableOn(background)) : undefined;
  return (
    <span className="line-badge" style={background ? { background: `#${background}`, color: ink } : undefined}>
      {text}
    </span>
  );
}

function Table({ table, onSelect }: { table: InfoTable; onSelect: (value: unknown) => void }) {
  return (
    <section className="info__table">
      <h3 className="kicker">{table.title}</h3>
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
                  <td key={j} className={NUMERIC_CELL.test(cell) ? 'num' : undefined}>
                    {j === 1 && row.badge && <LineBadge {...row.badge} />}
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Résumé d'une ligne pour la poignée de la feuille du téléphone : type, titre, premier chiffre, statut. */
export function InfoSummary({ info }: { info: SelectionInfo }) {
  const { content } = info;
  const figure = content.figures?.[0];
  return (
    <div className="summary">
      <div className="summary__text">
        <span className="kicker">{content.kind ?? info.moduleName}</span>
        <b className="summary__title">{content.title}</b>
        {content.status && <span className="summary__status">{content.status.text}</span>}
      </div>
      {figure && (
        <span className="summary__figure">
          {figure.value}
          <small>{figure.unit ? ` ${figure.unit}` : ` ${figure.label}`}</small>
        </span>
      )}
    </div>
  );
}
