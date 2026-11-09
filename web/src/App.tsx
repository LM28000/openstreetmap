import { ModuleManager } from './core/moduleManager';
import { MapView } from './map/MapView';
import { MODULES } from './modules';
import { InfoPanel } from './ui/InfoPanel';
import { LayerPanel } from './ui/LayerPanel';
import { TimeBar } from './ui/TimeBar';

/** Un seul gestionnaire pour toute l'application : il survit aux remontages de React. */
const manager = new ModuleManager(MODULES);

export function App() {
  return (
    <div className="app">
      <MapView manager={manager} />
      <LayerPanel manager={manager} />
      <InfoPanel manager={manager} />
      <TimeBar />
    </div>
  );
}
