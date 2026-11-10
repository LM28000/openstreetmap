/**
 * Réglages communs des couches de maquettes 3D (avions, trains, bateaux, transports).
 *
 * Contrairement aux icônes (map/parameters.ts, dessinées par-dessus tout), une maquette a
 * besoin du test de profondeur : sans lui, l'aile du fond se dessinerait devant le fuselage.
 * Le tampon de profondeur est celui de MapLibre (mode « interleaved ») : les maquettes passent
 * donc derrière le relief et les bâtiments, comme dans la réalité.
 */
import type { Layer } from '@deck.gl/core';
import { SimpleMeshLayer, type SimpleMeshLayerProps } from '@deck.gl/mesh-layers';
import type { MeshData } from './mesh';

export const MESH_PARAMETERS = {
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  cullMode: 'none',
} as const;

/**
 * Matière : beaucoup d'ambiance, pour que la couleur de la donnée reste reconnaissable sur toutes
 * les faces (à l'ombre, environ 70 % de la couleur le jour et 60 % la nuit ; au soleil, la couleur
 * pleine), et un peu de brillance.
 */
export const MESH_MATERIAL = { ambient: 0.62, diffuse: 0.5, shininess: 24, specularColor: [34, 34, 34] as [number, number, number] };

/** Réglage « Rendu » commun aux couches de véhicules. */
export const RENDER_SETTING = {
  id: 'rendu',
  label: 'Rendu',
  options: [
    { value: '3d', label: 'Maquettes 3D' },
    { value: 'plat', label: 'Symboles à plat' },
  ],
  defaultValue: '3d',
} as const;

/** Vrai si le module doit dessiner ses maquettes (réglage « Rendu » sur 3D). */
export function wants3d(settings: Readonly<Record<string, string>>): boolean {
  return (settings[RENDER_SETTING.id] ?? RENDER_SETTING.defaultValue) === '3d';
}

/** Une couche de maquettes : une instance par objet, avec les réglages communs. */
export function meshLayer<T>(props: SimpleMeshLayerProps<T> & { id: string; mesh: MeshData }): Layer {
  return new SimpleMeshLayer<T>({
    parameters: MESH_PARAMETERS,
    material: MESH_MATERIAL,
    ...props,
  } as SimpleMeshLayerProps<T>);
}
