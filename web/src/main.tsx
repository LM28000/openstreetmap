import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Polices hébergées avec le site (le site tourne sur un réseau local : pas de Google Fonts).
// Sous-ensemble « latin » seulement : il couvre le français (accents, œ, guillemets).
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Élément #root introuvable');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
