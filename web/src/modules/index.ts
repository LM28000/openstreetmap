/**
 * Registre des modules. Pour ajouter une couche : écrire son module dans ce
 * dossier, puis l'ajouter à cette liste. L'ordre est celui d'affichage dans
 * le panneau (à l'intérieur de chaque catégorie).
 */
import type { LayerModule } from '../core/module';
import { air } from './air';
import { bikes } from './bikes';
import { buildingShadows } from './buildingShadows';
import { chargers } from './chargers';
import { dayNight } from './dayNight';
import { earthquakes } from './earthquakes';
import { fires } from './fires';
import { floods } from './floods';
import { fuel } from './fuel';
import { planes } from './planes';
import { power } from './power';
import { railways } from './railways';
import { rain } from './rain';
import { satellites } from './satellites';
import { ships } from './ships';
import { traffic } from './traffic';
import { trains } from './trains';
import { transit } from './transit';
import { weatherAlerts } from './weatherAlerts';
import { wind } from './wind';

export const MODULES: LayerModule[] = [
  trains, railways, traffic, planes, ships, transit, bikes,
  floods, weatherAlerts, air, fires, earthquakes,
  power, chargers, fuel,
  dayNight, buildingShadows, satellites, rain, wind,
];
