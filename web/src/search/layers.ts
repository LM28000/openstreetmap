/**
 * Couches, réglages et scènes : « pluie » propose d'afficher le radar de pluie,
 * « carburants prix » ses réglages, « météo » la scène du même nom.
 */
import type { LayerModule } from '../core/module';
import type { ModuleManager } from '../core/moduleManager';
import { isShown } from './access';
import { matchScore, pad, rank, TopK, type Query } from './normalize';
import { SCENES } from './scenes';
import { SCENES as CORE_SCENES, applyScene } from '../core/scenes';
import type { Provider, SearchResult } from './types';

/** Mots que les gens tapent pour une couche, en plus de son nom. */
const SYNONYMS: Record<string, string> = {
  trains: 'train sncf tgv ter gare rail ferroviaire',
  voies: 'voies ferrees rails chemin de fer',
  trafic: 'trafic routier route bouchons embouteillages circulation',
  avions: 'avion vols vol aeroport ciel',
  bateaux: 'bateau navire navires ferry port mer ais',
  transports: 'bus tram tramway metro transports en commun',
  velos: 'velo velib bicyclette libre service',
  vigicrues: 'crues inondation rivieres eau',
  'vigilance-meteo': 'meteo orages alerte tempete canicule',
  air: 'air pollution qualite ozone particules pm10 no2 atmo indice episode smog',
  feux: 'feu incendie',
  seismes: 'seisme tremblement de terre',
  electricite: 'energie courant reseau electrique production',
  bornes: 'recharge voiture electrique irve',
  carburants: 'carburant essence diesel prix station service',
  'jour-nuit': 'soleil crepuscule',
  'ombres-batiments': 'soleil ombre',
  satellites: 'espace iss orbite',
  pluie: 'meteo radar precipitations averse',
  vent: 'rafales meteo',
};

interface LayerIndex {
  layers: Array<{ text: string; name: string; module: LayerModule }>;
  settings: Array<{ text: string; module: LayerModule; settingId: string; settingLabel: string; value: string; label: string }>;
  scenes: Array<{ text: string; scene: (typeof SCENES)[number] }>;
}

let index: LayerIndex | undefined;

/** Les modules ne changent pas pendant la session : l'index est construit une fois. */
function build(manager: ModuleManager): LayerIndex {
  if (index) return index;
  index = { layers: [], settings: [], scenes: [] };
  for (const module of manager.modules) {
    index.layers.push({ text: pad(`${module.name} ${SYNONYMS[module.id] ?? ''}`), name: pad(module.name), module });
    for (const setting of module.settings ?? []) {
      for (const option of setting.options) {
        index.settings.push({
          text: pad(`${module.name} ${setting.label} ${option.label}`),
          module,
          settingId: setting.id,
          settingLabel: setting.label,
          value: option.value,
          label: option.label,
        });
      }
    }
  }
  for (const scene of SCENES) index.scenes.push({ text: pad(`scene ${scene.name} ${scene.summary} ${scene.keywords}`), scene });
  return index;
}

function sceneBonus(name: string, query: Query): number {
  const padded = pad(name);
  if (padded === ` ${query.text} `) return 120;
  return matchScore(padded, query, true) > 0 ? 50 : 0;
}

export const layersProvider: Provider = {
  search(query: Query, { manager }) {
    const { layers, settings, scenes } = build(manager);
    const out: SearchResult[] = [];

    for (const { text, name, module } of layers) {
      const match = matchScore(text, query, true);
      if (match === 0) continue;
      const shown = isShown(manager, module.id);
      // Le nom de la couche compte plus que ses synonymes : « pluie » est d'abord le Radar de pluie.
      const byName = matchScore(name, query, true) > 0;
      out.push({
        key: `couche:${module.id}`,
        kind: 'action',
        title: `${shown ? 'Masquer' : 'Afficher'} la couche ${module.name}`,
        subtitle: shown ? 'Couche affichée' : 'Couche masquée',
        score: rank(text, query, match) + (byName ? 40 : 0),
        run: () => manager.setVisible(module.id, !shown),
      });
    }

    const topSettings = new TopK<LayerIndex['settings'][number]>(3);
    for (const entry of settings) {
      // Seuls les réglages qui changent quelque chose : pas l'option déjà choisie.
      if (manager.getSnapshot()[entry.module.id]?.settings[entry.settingId] === entry.value) continue;
      const match = matchScore(entry.text, query);
      if (match > 0) topSettings.push(rank(entry.text, query, match) - 15 + (isShown(manager, entry.module.id) ? 30 : 0), entry);
    }
    for (const { score, item } of topSettings.result()) {
      out.push({
        key: `reglage:${item.module.id}:${item.settingId}:${item.value}`,
        kind: 'action',
        title: `${item.module.name} : ${item.settingLabel.toLowerCase()} ${item.label.toLowerCase()}`,
        subtitle: 'Réglage de la couche',
        score,
        run: () => {
          manager.setVisible(item.module.id, true);
          manager.setSetting(item.module.id, item.settingId, item.value);
        },
      });
    }

    for (const { text, scene } of scenes) {
      const match = matchScore(text, query, true);
      if (match === 0) continue;
      out.push({
        key: `scene:${scene.id}`,
        kind: 'action',
        title: `Scène « ${scene.name} »`,
        subtitle: scene.summary,
        // Le nom de la scène : « météo » ouvre d'abord la scène, avant ses couches prises une à une.
        score: rank(text, query, match) + sceneBonus(scene.name, query),
        run: () => {
          const core = CORE_SCENES.find((candidate) => candidate.id === scene.id);
          if (core) applyScene(manager, core);
        },
      });
    }
    return out;
  },
};
