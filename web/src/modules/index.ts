/**
 * Registre des modules. Pour ajouter une couche : écrire son module dans ce
 * dossier, puis l'ajouter à cette liste. L'ordre est celui d'affichage dans
 * le panneau (à l'intérieur de chaque catégorie).
 */
import type { LayerModule } from '../core/module';
import { dayNight } from './dayNight';
import { earthquakes } from './earthquakes';
import { trains } from './trains';

export const MODULES: LayerModule[] = [trains, earthquakes, dayNight];
