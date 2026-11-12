import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { CATEGORY_LABELS, CATEGORY_ORDER, settingOptions, type LayerModule, type LegendItem, type ModuleSetting } from '../core/module';
import type { ModuleManager, ModuleRuntimeState } from '../core/moduleManager';
import { SCENES, activeScene, applyScene } from '../core/scenes';
import { TourLauncher } from './Tour';
import { formatDateTime, formatRelative } from './format';
import { useModuleStates, useNow } from './hooks';
import { Icon } from './icons';
import { freshness } from './layerInfo';

interface LayerCatalogProps {
  manager: ModuleManager;
  /** Couche dépliée (réglages, légende, source) : une seule à la fois. */
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  /** Donne le focus au filtre à l'ouverture (ordinateur seulement : sur téléphone il ouvrirait le clavier). */
  autoFocus?: boolean;
}

/**
 * Catalogue des couches : filtre, scènes, couches affichées en tête, puis les autres par
 * catégorie. Une ligne par couche ; seule celle qu'on touche se déplie. Sert au tiroir
 * de l'ordinateur et à la feuille du téléphone.
 */
export function LayerCatalog({ manager, expandedId, onExpand, autoFocus }: LayerCatalogProps) {
  const states = useModuleStates(manager);
  const now = useNow(30_000);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const expandedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) filterRef.current?.focus();
  }, [autoFocus]);

  // Une couche dépliée depuis une pastille doit se voir, même au fond d'une longue liste.
  useEffect(() => {
    expandedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [expandedId]);

  const query = normalize(filter.trim());
  const matches = (module: LayerModule) =>
    !query || normalize(`${module.name} ${CATEGORY_LABELS[module.category]} ${module.description}`).includes(query);

  const visibleIds = useMemo(
    () => new Set(manager.modules.filter((module) => states[module.id]?.visible).map((module) => module.id)),
    [manager, states],
  );
  const current = activeScene(visibleIds);

  const shown = manager.modules.filter((module) => visibleIds.has(module.id) && matches(module));
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    modules: manager.modules.filter((module) => module.category === category && !visibleIds.has(module.id) && matches(module)),
  })).filter((group) => group.modules.length > 0);

  const renderRow = (module: LayerModule) => {
    const state = states[module.id];
    if (!state) return null;
    return (
      <LayerRow
        key={module.id}
        module={module}
        state={state}
        now={now}
        manager={manager}
        open={expandedId === module.id}
        onToggleOpen={() => onExpand(expandedId === module.id ? null : module.id)}
        rowRef={expandedId === module.id ? expandedRef : undefined}
      />
    );
  };

  return (
    <div className="catalog">
      <label className="catalog__filter">
        <Icon name="search" size={16} />
        <input
          ref={filterRef}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filtrer les ${manager.modules.length} couches`}
          aria-label="Filtrer les couches"
        />
      </label>

      <div className="catalog__scroll">
        {!query && (
          <section className="catalog__scenes" aria-label="Scènes">
            <TourLauncher manager={manager} />
            <h3 className="kicker">Scènes</h3>
            <div className="scenes">
              {SCENES.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  className={`scene${current?.id === scene.id ? ' scene--on' : ''}`}
                  aria-pressed={current?.id === scene.id}
                  title="Remplace les couches affichées par cet ensemble"
                  onClick={() => applyScene(manager, scene)}
                >
                  <b>{scene.label}</b>
                  <span>{scene.description}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {shown.length > 0 && (
          <section className="catalog__group">
            <h3 className="kicker">Affichées · {shown.length}</h3>
            {shown.map(renderRow)}
          </section>
        )}
        {groups.map(({ category, modules }) => (
          <section key={category} className="catalog__group">
            <h3 className="kicker">
              {CATEGORY_LABELS[category]} · {modules.length}
              {manager.modules.some((m) => m.category === category && visibleIds.has(m.id)) ? ' autres' : ''}
            </h3>
            {modules.map(renderRow)}
          </section>
        ))}
        {shown.length === 0 && groups.length === 0 && <p className="catalog__empty">Aucune couche ne correspond à « {filter} ».</p>}
      </div>
    </div>
  );
}

interface LayerRowProps {
  module: LayerModule;
  state: ModuleRuntimeState;
  now: number;
  manager: ModuleManager;
  open: boolean;
  onToggleOpen: () => void;
  rowRef: Ref<HTMLDivElement> | undefined;
}

function LayerRow({ module, state, now, manager, open, onToggleOpen, rowRef }: LayerRowProps) {
  const legend = state.visible ? manager.legendOf(module.id) : [];
  const fresh = freshness(state, now);
  const failing = state.status === 'error';
  const detailId = `couche-${module.id}`;

  return (
    <div ref={rowRef} className={`layer${state.visible ? ' layer--on' : ''}${open ? ' layer--open' : ''}`}>
      <div className="layer__line">
        <button type="button" className="layer__main" aria-expanded={open} aria-controls={detailId} onClick={onToggleOpen}>
          <Icon name={module.id} className="layer__icon" />
          <span className="layer__text">
            <span className="layer__name">{module.name}</span>
            {fresh && <span className={`layer__fresh${failing ? ' layer__fresh--warn' : ''}`}>{fresh}</span>}
          </span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={state.visible}
          aria-label={`Afficher ${module.name}`}
          className="switch"
          onClick={() => manager.setVisible(module.id, !state.visible)}
        >
          <span className="switch__knob" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div className="layer__detail" id={detailId}>
          <p className="layer__description">{module.description}</p>
          {module.settings?.filter((setting) => setting.visibleWhen?.(state.settings) ?? true).map((setting) =>
            setting.range ? (
              <RangeSetting
                key={setting.id}
                setting={setting}
                value={state.settings[setting.id] ?? setting.defaultValue}
                label={`${module.name} : ${setting.label}`}
                onCommit={(value) => manager.setSetting(module.id, setting.id, value)}
              />
            ) : (
            <div key={setting.id} className="setting">
            <span className="setting__label" aria-hidden="true">{setting.label}</span>
            <div className="segmented" role="radiogroup" aria-label={`${module.name} : ${setting.label}`}>
              {settingOptions(setting, state.settings).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={state.settings[setting.id] === option.value}
                  className="segmented__option"
                  onClick={() => manager.setSetting(module.id, setting.id, option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            </div>
            ),
          )}
          {legend.length > 0 && <Legend items={legend} />}
          <p className="layer__source">
            Source et licence : {module.attribution}
            {state.lastUpdated !== undefined && (
              <span title={formatDateTime(state.lastUpdated)}> · mis à jour {formatRelative(state.lastUpdated, now)}</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Réglage continu : un curseur. La valeur affichée suit le doigt ; elle n'est appliquée qu'après une
 * courte pause (ou au lâcher), pour ne pas relancer un calcul à chaque cran pendant qu'on glisse.
 */
function RangeSetting({ setting, value, label, onCommit }: { setting: ModuleSetting; value: string; label: string; onCommit(value: string): void }) {
  const range = setting.range!;
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next !== value) onCommit(next);
  };
  return (
    <label className="range">
      <span className="range__head">
        <span className="range__label">{setting.label}</span>
        <span className="range__value">{range.format(Number(draft))}</span>
      </span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={draft}
        aria-label={label}
        aria-valuetext={range.format(Number(draft))}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next), 250);
        }}
        onPointerUp={(event) => commit(event.currentTarget.value)}
        onKeyUp={(event) => commit(event.currentTarget.value)}
      />
    </label>
  );
}

function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.label} className="legend__item">
          {item.icon ? (
            <img className="legend__icon" src={item.icon} alt="" />
          ) : (
            <span
              className={`legend__swatch legend__swatch--${item.size ?? 'medium'}`}
              style={{ background: item.color }}
              aria-hidden="true"
            />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Minuscules sans accents : « Électricité » se trouve en tapant « electri ». */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** Tiroir du catalogue sur ordinateur, sous les pastilles. */
export function LayerDrawer({ manager, expandedId, onExpand, onClose }: Omit<LayerCatalogProps, 'autoFocus'> & { onClose: () => void }) {
  return (
    // Le filtre prend le focus à l'ouverture : Échap doit fermer le tiroir même depuis ce champ.
    <section
      className="drawer panel"
      aria-label="Couches"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="drawer__header">
        <h2>Couches</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer les couches (Échap)">
          <Icon name="x" size={16} />
        </button>
      </header>
      <LayerCatalog manager={manager} expandedId={expandedId} onExpand={onExpand} autoFocus />
    </section>
  );
}
