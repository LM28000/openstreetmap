import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BLOCS, SCRUTINS } from '../modules/elections';
import {
  type AccidentSection,
  type HousingSection,
  type MobileSection,
  type PopulationSection,
  type SalesGroup,
  type ZoneAnalysis,
  ok,
  shapeAreaKm2,
  useZone,
  zoneStore,
} from '../core/zone';
import { Icon } from './icons';

/**
 * Le panneau des résultats d'une zone : à droite sur ordinateur (même place que la fiche d'un objet), feuille du bas sur téléphone.
 * Une section par jeu de données, chaque chiffre en police de mesures ; chaque section dit sa **précision** (taille des carreaux lus)
 * puisqu'un chiffre de zone n'a de sens qu'avec elle.
 */

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} M` : fmt(n));
const pct = (n: number, digits = 1) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: digits })} %`;
const euro = (n: number) => (n > 0 ? `${fmt(n)} €` : '—');
const size = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);

function Section({ title, precision, children }: { title: string; precision?: string; children: ReactNode }) {
  return (
    <section className="zone-section">
      <h3 className="kicker zone-section__title">
        {title}
        {precision && <span className="zone-section__precision"> · {precision}</span>}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="zone-row">
      <dt>{label}</dt>
      <dd className={`mono${strong ? ' is-strong' : ''}`}>{value}</dd>
    </div>
  );
}

const Unavailable = ({ message }: { message: string }) => <p className="info__empty">{message}</p>;

export function ZonePanel({ phone }: { phone: boolean }) {
  const { shape, analysis, scrutin } = useZone();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!shape) return null;

  const data = analysis.data;
  const area = data?.zone.surfaceKm2 ?? shapeAreaKm2(shape);
  const title = shape.kind === 'circle' ? `Cercle de ${(shape.radius >= 1000 ? `${(shape.radius / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km` : `${Math.round(shape.radius)} m`)} de rayon` : `Zone à ${shape.points.length} sommets`;

  const share = async () => {
    let done = false;
    try {
      await navigator.clipboard.writeText(window.location.href);
      done = true;
    } catch {
      window.prompt('Copiez l’adresse de cette zone :', window.location.href);
    }
    setCopied(done);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <aside className={`zone-panel panel${phone ? ' zone-panel--phone' : ''}`} aria-label="Analyse de la zone">
      <header className="info__head">
        <div className="info__titles">
          <span className="kicker">Analyse de zone</span>
          <h2 className="info__title">{title}</h2>
          <p className="info__subtitle mono">{area.toLocaleString('fr-FR', { maximumFractionDigits: area < 10 ? 1 : 0 })} km²</p>
        </div>
        <button type="button" className="icon-button" onClick={() => zoneStore.setPanelOpen(false)} aria-label="Masquer le panneau">
          <Icon name="x" size={16} />
        </button>
      </header>

      {analysis.status === 'error' && <p className="zone-error">{analysis.error}</p>}
      {analysis.status === 'loading' && <p className={`zone-loading mono${data ? ' is-stale' : ''}`}>Analyse en cours…</p>}

      {data && <Results data={data} scrutin={scrutin} />}

      <div className="actions zone-actions">
        <button type="button" className="btn" onClick={share} title="Copier l’adresse : la zone et la vue sont dedans">
          <Icon name={copied ? 'check' : 'share'} size={16} />
          <span aria-live="polite">{copied ? 'Adresse copiée' : 'Partager'}</span>
        </button>
        <button type="button" className="btn" onClick={() => zoneStore.startDrawing(shape.kind)}>
          Redessiner
        </button>
        <button type="button" className="btn" onClick={() => zoneStore.clear()}>
          Effacer
        </button>
      </div>
    </aside>
  );
}

function Results({ data, scrutin }: { data: ZoneAnalysis; scrutin: string }) {
  return (
    <>
      <PopulationBlock section={data.population} />
      <HousingBlock section={data.immobilier} />
      <MobileBlock section={data.mobile} />
      <ElectionBlock data={data} scrutin={scrutin} />
      <RoadBlock section={data.accidents} />
      <HeritageBlock data={data} />
      <p className="zone-foot mono">calculé en {data.dureeMs} ms</p>
    </>
  );
}

function PopulationBlock({ section }: { section: ZoneAnalysis['population'] }) {
  if (!ok<PopulationSection>(section)) return <Section title="Population"><Unavailable message={section.erreur} /></Section>;
  return (
    <Section title="Population" precision={`carreaux de ${size(section.tailleCarreau)}`}>
      <dl className="figures">
        <div className="figures__cell">
          <dt className="figures__label">habitants</dt>
          <dd className="figures__value">{compact(section.habitants)}</dd>
        </div>
        <div className="figures__cell">
          <dt className="figures__label">ménages</dt>
          <dd className="figures__value">{compact(section.menages)}</dd>
        </div>
        <div className="figures__cell">
          <dt className="figures__label">hab./km²</dt>
          <dd className="figures__value">{fmt(section.densite)}</dd>
        </div>
      </dl>
      <dl className="zone-rows">
        <Row label="Niveau de vie moyen" value={`${fmt(section.niveauDeVie)} €/an`} />
        <Row label="Ménages pauvres" value={pct(section.partPauvres)} />
        <Row label="65 ans et plus" value={pct(section.part65)} />
      </dl>
      <p className="info__note">INSEE, Filosofi {section.millesime}.{section.partImputes >= 10 ? ` ${fmt(section.partImputes)} % des habitants sont dans des carreaux dont les valeurs sont imputées (secret statistique).` : ''}</p>
    </Section>
  );
}

function Sales({ group }: { group: SalesGroup }) {
  return group.ventes > 0 ? <>{euro(group.mediane)}</> : <>—</>;
}

function HousingBlock({ section }: { section: ZoneAnalysis['immobilier'] }) {
  if (!ok<HousingSection>(section)) return <Section title="Immobilier"><Unavailable message={section.erreur} /></Section>;
  const precision = section.methode === 'ventes' ? 'ventes relues une à une' : `médianes de carreaux de ${size(section.tailleCarreau)}`;
  return (
    <Section title="Immobilier" precision={precision}>
      <table className="zone-table">
        <thead>
          <tr>
            <th />
            <th>Appartements</th>
            <th>Maisons</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Prix médian au m²</td>
            <td className="mono is-strong"><Sales group={section.appartements} /></td>
            <td className="mono is-strong"><Sales group={section.maisons} /></td>
          </tr>
          <tr>
            <td>Ventes sur 5 ans</td>
            <td className="mono">{fmt(section.appartements.ventes)}</td>
            <td className="mono">{fmt(section.maisons.ventes)}</td>
          </tr>
          <tr>
            <td>Médiane, 12 mois</td>
            <td className="mono"><Sales group={section.appartements12mois} /></td>
            <td className="mono"><Sales group={section.maisons12mois} /></td>
          </tr>
          <tr>
            <td>Entre quartiles</td>
            <td className="mono">{section.appartements.ventes > 0 ? `${fmt(section.appartements.q1)} – ${fmt(section.appartements.q3)}` : '—'}</td>
            <td className="mono">{section.maisons.ventes > 0 ? `${fmt(section.maisons.q1)} – ${fmt(section.maisons.q3)}` : '—'}</td>
          </tr>
        </tbody>
      </table>
      <p className="info__note">
        DGFiP, DVF, jusqu’à {section.moisReference}.{' '}
        {section.methode === 'carreaux' ? 'Zone étendue : les histogrammes de chaque carreau sont reconstitués d’après ses quartiles, puis fusionnés (approché).' : 'Médianes lues dans un histogramme à classes de 3,7 %.'}
      </p>
    </Section>
  );
}

function MobileBlock({ section }: { section: ZoneAnalysis['mobile'] }) {
  if (!ok<MobileSection>(section)) return <Section title="Couverture mobile 4G"><Unavailable message={section.erreur} /></Section>;
  const h = section.habitants;
  const parts = [
    { label: 'Aucun opérateur', value: h.partSans, area: section.surface.sans, className: 'is-none' },
    { label: 'Un seul', value: h.partUn, area: section.surface.un, className: 'is-one' },
    { label: 'Deux ou plus', value: h.partDeuxEtPlus, area: section.surface.deuxEtPlus, className: 'is-many' },
  ];
  return (
    <Section title="Couverture mobile 4G" precision={`carreaux de ${size(section.tailleCarreau)}`}>
      <div className="zone-stack" role="img" aria-label={`Habitants : ${pct(h.partSans)} sans 4G, ${pct(h.partUn)} avec un opérateur, ${pct(h.partDeuxEtPlus)} avec deux ou plus`}>
        {parts.map((p) => (
          <span key={p.label} className={`zone-stack__part ${p.className}`} style={{ flexGrow: Math.max(p.value, 0.0001) }} />
        ))}
      </div>
      <table className="zone-table">
        <thead>
          <tr>
            <th>Opérateurs en 4G</th>
            <th>Habitants</th>
            <th>Surface</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p.label}>
              <td>
                <span className={`zone-swatch ${p.className}`} aria-hidden="true" />
                {p.label}
              </td>
              <td className="mono">
                {pct(p.value)} <span className="zone-faint">({fmt(p.label === 'Aucun opérateur' ? h.sans : p.label === 'Un seul' ? h.un : h.deuxEtPlus)})</span>
              </td>
              <td className="mono">{p.area === null ? '—' : pct(p.area)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="info__note">
        Cartes théoriques ARCEP, {section.trimestre}. Habitants INSEE rattachés au carreau de couverture de leur centre.
        {section.exact ? '' : ' Zone étendue : la surface à un ou deux opérateurs n’est pas lisible à cette échelle.'}
      </p>
    </Section>
  );
}

function ElectionBlock({ data, scrutin }: { data: ZoneAnalysis; scrutin: string }) {
  const def = SCRUTINS.find((s) => s.id === scrutin) ?? SCRUTINS[0]!;
  const section = data.elections;
  const select = (
    <label className="zone-select">
      <span className="sr-only">Scrutin</span>
      <select value={def.id} onChange={(event) => zoneStore.setScrutin(event.target.value)}>
        {SCRUTINS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
  if (!section || !ok(section)) {
    return (
      <Section title="Élections">
        {select}
        <Unavailable message={section && 'erreur' in section ? String(section.erreur) : 'Pas de résultats pour ce scrutin.'} />
      </Section>
    );
  }
  const rows = section.voix
    .map((votes, i) => ({ votes, column: def.columns[i] }))
    .filter((r) => r.votes > 0)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 6);
  const max = rows[0]?.votes ?? 1;
  return (
    <Section title="Élections" precision={`${fmt(section.objets)} ${section.niveau === 'bureau de vote' ? 'bureaux' : section.niveau === 'commune' ? 'communes' : 'départements'}`}>
      {select}
      <dl className="zone-rows">
        <Row label="Participation" value={section.inscrits > 0 ? pct((100 * section.votants) / section.inscrits) : '—'} strong />
        <Row label="Inscrits · votants" value={`${fmt(section.inscrits)} · ${fmt(section.votants)}`} />
      </dl>
      <ol className="zone-results">
        {rows.map(({ votes, column }, i) => {
          const bloc = column ? BLOCS[column.bloc] : BLOCS.autres;
          return (
            <li key={column?.key ?? i} className="zone-result">
              <span className="zone-result__name">
                <span className="zone-swatch" style={{ background: bloc.day }} aria-hidden="true" />
                {column?.name ?? `Colonne ${i + 1}`}
              </span>
              <span className="mono zone-result__pct">{pct((100 * votes) / Math.max(section.exprimes, 1))}</span>
              <span className="zone-result__bar" style={{ width: `${(100 * votes) / max}%`, background: bloc.day }} aria-hidden="true" />
            </li>
          );
        })}
      </ol>
      <p className="info__note">Part des suffrages exprimés ; bureaux de vote dont le centre est dans la zone.</p>
    </Section>
  );
}

function RoadBlock({ section }: { section: ZoneAnalysis['accidents'] }) {
  if (!ok<AccidentSection>(section)) return <Section title="Accidents de la route"><Unavailable message={section.erreur} /></Section>;
  const years = section.annees.length ? `${section.annees[0]}–${section.annees[section.annees.length - 1]}` : '';
  const maxYear = Math.max(1, ...section.parAnnee.map((y) => y.accidents));
  return (
    <Section title="Accidents de la route" precision={years}>
      <dl className="figures">
        <div className="figures__cell">
          <dt className="figures__label">accidents</dt>
          <dd className="figures__value">{fmt(section.accidents)}</dd>
        </div>
        <div className="figures__cell">
          <dt className="figures__label">tués</dt>
          <dd className="figures__value">{fmt(section.tues)}</dd>
        </div>
        <div className="figures__cell">
          <dt className="figures__label">hospitalisés</dt>
          <dd className="figures__value">{fmt(section.hospitalises)}</dd>
        </div>
      </dl>
      <dl className="zone-rows">
        <Row label="Blessés légers" value={fmt(section.blessesLegers)} />
        <Row label="Accidents mortels" value={fmt(section.accidentsMortels)} />
      </dl>
      {section.parAnnee.length > 0 && (
        <div className="zone-years" role="img" aria-label={`Accidents par année : ${section.parAnnee.map((y) => `${y.annee} ${y.accidents}`).join(', ')}`}>
          {section.parAnnee.map((y) => (
            <div key={y.annee} className="zone-years__col" title={`${y.annee} : ${y.accidents} accidents, ${y.tues} tués`}>
              <span className="zone-years__bar" style={{ height: `${(100 * y.accidents) / maxYear}%` }} />
              <span className="zone-years__label mono">{String(y.annee).slice(2)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="info__note">ONISR, accidents corporels. Positions à une dizaine de mètres près.</p>
    </Section>
  );
}

function HeritageBlock({ data }: { data: ZoneAnalysis }) {
  const monuments = data.monuments;
  const stations = data.gares;
  return (
    <Section title="Patrimoine et gares">
      <dl className="zone-rows">
        <Row label="Monuments historiques" value={ok(monuments) ? `${fmt(monuments.total)} (${fmt(monuments.classes)} classés)` : '—'} strong />
        <Row label="Gares dans la zone" value={fmt(stations.dans)} strong />
        {stations.plusProche && (
          <Row label="Gare la plus proche" value={`${stations.plusProche.nom} · ${stations.plusProche.distanceKm.toLocaleString('fr-FR')} km`} />
        )}
      </dl>
      {stations.liste.length > 0 && <p className="info__note">{stations.liste.slice(0, 6).map((s) => s.nom).join(' · ')}{stations.dans > 6 ? ' …' : ''}</p>}
    </Section>
  );
}
