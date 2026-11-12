// Vérifie que la barre d'échelle reste juste (repos, pendant un saut, puis à l'arrêt).
import { ouvrir, attendre } from '/private/tmp/claude-502/-Users-Louis-Marie-PERRET-DU-CRAY-openstreetmap/a2979c63-80d6-4916-9792-e3ad9f1d9403/scratchpad/browser/qa-lib.mjs';
const { browser, page } = await ouvrir('#vue=14/48.8566/2.3522/0/55&couches=trains&t=direct');
await attendre(6000);
const lire = () => page.evaluate(() => document.querySelector('.maplibregl-ctrl-scale')?.textContent + ' w=' + document.querySelector('.maplibregl-ctrl-scale')?.style.width);
console.log('repos', await lire());
await page.evaluate(() => { window.__carte.map.jumpTo({ zoom: 11 }); });
console.log('juste après', await lire());
await attendre(600);
console.log('après 600ms', await lire());
await browser.close();
