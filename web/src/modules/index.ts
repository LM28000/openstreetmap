/**
 * Registre des modules. Pour ajouter une couche : écrire son module dans ce
 * dossier, puis l'ajouter à cette liste. L'ordre est celui d'affichage dans
 * le panneau (à l'intérieur de chaque catégorie).
 */
import type { LayerModule } from '../core/module';
import { bikes } from './bikes';
import { chargers } from './chargers';
import { dayNight } from './dayNight';
import { earthquakes } from './earthquakes';
import { fires } from './fires';
import { floods } from './floods';
import { fuel } from './fuel';
import { planes } from './planes';
import { power } from './power';
import { railways } from './railways';
import { satellites } from './satellites';
import { ships } from './ships';
import { traffic } from './traffic';
import { trains } from './trains';
import { weatherAlerts } from './weatherAlerts';

export const MODULES: LayerModule[] = [trains, railways, planes, ships, bikes, floods, fires, earthquakes, power, fuel, dayNight, satellites, traffic, weatherAlerts, chargers];
