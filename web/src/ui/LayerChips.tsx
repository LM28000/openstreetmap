import type { ModuleManager } from '../core/moduleManager';
import { useModuleStates } from './hooks';
import { Icon } from './icons';
import { leadingCount, swatchBackground } from './layerInfo';

interface LayerChipsProps {
  manager: ModuleManager;
  /** Ouvre le catalogue sur la couche touchée (ses réglages). */
  onOpenLayer: (id: string) => void;
  /** Bouton « Couches ». */
  onOpenCatalog: () => void;
  catalogOpen: boolean;
}

/**
 * Pastilles des couches affichées : échantillon de couleur, nom, compteur court si le résumé
 * en donne un, et une croix pour masquer. Un clic sur la pastille ouvre ses réglages.
 */
export function LayerChips({ manager, onOpenLayer, onOpenCatalog, catalogOpen }: LayerChipsProps) {
  const states = useModuleStates(manager);
  const shown = manager.modules.filter((module) => states[module.id]?.visible);

  return (
    <div className="chips" role="group" aria-label="Couches affichées">
      {shown.map((module) => {
        const state = states[module.id];
        const count = leadingCount(state?.summary);
        return (
          <span key={module.id} className="chip">
            <button
              type="button"
              className="chip__main"
              onClick={() => onOpenLayer(module.id)}
              title={`Réglages de ${module.name}`}
              aria-label={`${module.name}${count ? `, ${count}` : ''} : ouvrir les réglages`}
            >
              <span className="chip__swatch" style={{ background: swatchBackground(manager.legendOf(module.id)) }} aria-hidden="true" />
              <span className="chip__name">{module.name}</span>
              {count && <span className="chip__count">{count}</span>}
            </button>
            <button
              type="button"
              className="chip__remove"
              onClick={() => manager.setVisible(module.id, false)}
              aria-label={`Retirer ${module.name}`}
              title="Retirer"
            >
              <Icon name="x" size={14} />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="chip chip--add"
        aria-expanded={catalogOpen}
        onClick={onOpenCatalog}
        title="Ouvrir le catalogue des couches (L)"
      >
        <Icon name="layers" size={16} />
        Couches
      </button>
    </div>
  );
}
