import { useCallback, useState } from 'react';
import { ModuleManager } from './core/moduleManager';
import { MapView, type Pick } from './map/MapView';
import { MODULES } from './modules';
import { InfoPanel } from './ui/InfoPanel';
import { LayerPanel } from './ui/LayerPanel';
import { TimeBar } from './ui/TimeBar';

/** Un seul gestionnaire pour toute l'application : il survit aux remontages de React. */
const manager = new ModuleManager(MODULES);

export function App() {
  const [pick, setPick] = useState<Pick | null>(null);
  const closeInfo = useCallback(() => setPick(null), []);

  return (
    <div className="app">
      <MapView manager={manager} onPick={setPick} />
      <LayerPanel manager={manager} />
      {pick && <InfoPanel pick={pick} onClose={closeInfo} />}
      <TimeBar />
    </div>
  );
}
