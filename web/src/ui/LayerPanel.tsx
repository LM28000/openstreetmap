import { useState } from 'react';
import { CATEGORY_LABELS, CATEGORY_ORDER, type LayerModule, type LegendItem } from '../core/module';
import type { ModuleManager, ModuleRuntimeState } from '../core/moduleManager';
import { formatDateTime, formatRelative } from './format';
import { useModuleStates, useNow } from './hooks';

export function LayerPanel({ manager }: { manager: ModuleManager }) {
  const states = useModuleStates(manager);
  const now = useNow(30_000);
  const [open, setOpen] = useState(true);

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    modules: manager.modules.filter((module) => module.category === category),
  })).filter((group) => group.modules.length > 0);

  return (
    <aside className="panel layers" aria-label="Couches">
      <header className="layers__header">
        <div>
          <h1 className="layers__title">Carte vivante</h1>
          <p className="layers__subtitle">La France en temps réel</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? 'Replier le panneau des couches' : 'Déplier le panneau des couches'}
        >
          <Chevron up={open} />
        </button>
      </header>

      {open && (
        <div className="layers__body">
          {groups.map(({ category, modules }) => (
            <section key={category} className="layers__group">
              <h2 className="layers__category">{CATEGORY_LABELS[category]}</h2>
              {modules.map((module) => {
                const state = states[module.id];
                return state ? <LayerRow key={module.id} module={module} state={state} now={now} manager={manager} /> : null;
              })}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

interface LayerRowProps {
  module: LayerModule;
  state: ModuleRuntimeState;
  now: number;
  manager: ModuleManager;
}

function LayerRow({ module, state, now, manager }: LayerRowProps) {
  const legend = state.visible ? manager.legendOf(module.id) : [];
  return (
    <div className="layer">
      <label className="layer__main">
        <input
          type="checkbox"
          className="switch"
          checked={state.visible}
          onChange={(event) => manager.setVisible(module.id, event.target.checked)}
        />
        <span className="layer__text">
          <span className="layer__name">
            {module.name}
            {state.visible && <Status state={state} />}
          </span>
          <span className="layer__description">{module.description}</span>
          {state.visible && state.summary && <span className="layer__summary">{state.summary}</span>}
          <span className="layer__meta">
            Source : {module.attribution}
            {state.lastUpdated !== undefined && (
              <span title={formatDateTime(state.lastUpdated)}> · mis à jour {formatRelative(state.lastUpdated, now)}</span>
            )}
          </span>
        </span>
      </label>

      {state.visible && (module.settings?.length || legend.length > 0) ? (
        <div className="layer__details">
          {module.settings?.map((setting) => (
            <div key={setting.id} className="segmented" role="radiogroup" aria-label={`${module.name} : ${setting.label}`}>
              {setting.options.map((option) => (
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
          ))}
          {legend.length > 0 && <Legend items={legend} />}
        </div>
      ) : null}
    </div>
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

function Status({ state }: { state: ModuleRuntimeState }) {
  if (state.status === 'loading') return <span className="status status--loading">chargement…</span>;
  if (state.status === 'error') {
    return (
      <span className="status status--error" title={state.error}>
        {state.lastUpdated ? 'erreur, anciennes données' : 'erreur'}
      </span>
    );
  }
  return null;
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
