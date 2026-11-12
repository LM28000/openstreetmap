// Attribution par type de couche MapLibre : CPU par image avec chaque famille masquée tour à tour.
// Usage : node perf/types.mjs [paris-z14-p55|lyon-z15-p60]
import { ouvrir, attendre } from '/private/tmp/claude-502/-Users-Louis-Marie-PERRET-DU-CRAY-openstreetmap/a2979c63-80d6-4916-9792-e3ad9f1d9403/scratchpad/browser/qa-lib.mjs';
const VUES = {
  'paris-z14-p55': '#vue=14/48.8566/2.3522/0/55&couches=trains,transports,avions&t=direct',
  'lyon-z15-p60': '#vue=15/45.764/4.8357/0/60&couches=trains,transports,avions&t=direct',
};
const nom = process.argv[2] ?? 'paris-z14-p55';
const { browser, page } = await ouvrir(VUES[nom]);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await attendre(10000);
const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const mesure = async () => {
  const m0 = await m();
  const n = await page.evaluate(() => new Promise((res) => {
    const map = window.__carte.map; const b0 = map.getBearing(); const t0 = performance.now(); let n = 0;
    const f = (t) => { n++; const e = t - t0; map.setBearing(b0 + (e / 3000) * 45); if (e < 3000) requestAnimationFrame(f); else res(n); };
    requestAnimationFrame(f);
  }));
  const m1 = await m();
  return `cpu ${(((m1.TaskDuration - m0.TaskDuration) / n) * 1000).toFixed(1)} ms/img (${n} img)`;
};
await mesure();
console.log('base', await mesure(), await mesure());
const familles = {
  symbol: (l) => l.type === 'symbol',
  line: (l) => l.type === 'line',
  fill: (l) => l.type === 'fill',
  extrusion: (l) => l.type === 'fill-extrusion',
  'ombrage': (l) => l.type === 'hillshade',
  'deck': () => false,
};
for (const [k, pred] of Object.entries(familles)) {
  const ids = await page.evaluate((src) => { const f = eval(src); const map = window.__carte.map; const ids = map.getStyle().layers.filter(f).map((l) => l.id); ids.forEach((id) => map.setLayoutProperty(id, 'visibility', 'none')); return ids.length; }, pred.toString());
  if (k === 'deck') await page.evaluate(() => { window.__carte.overlay.setProps({ layers: [] }); });
  await attendre(1500);
  await mesure();
  console.log('sans', k, ids, await mesure(), await mesure());
  await page.evaluate((src) => { const f = eval(src); const map = window.__carte.map; map.getStyle().layers.filter(f).forEach((l) => map.setLayoutProperty(l.id, 'visibility', 'visible')); }, pred.toString());
}
await browser.close();
