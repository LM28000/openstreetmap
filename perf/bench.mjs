// Banc de mesure : vues fixes, rotation de 5 s, temps d'image (rAF) et temps CPU par image (CDP).
// Usage : TAG=avant [NUIT=1] node perf/bench.mjs [vue1,vue2]
import { ouvrir, attendre } from '/private/tmp/claude-502/-Users-Louis-Marie-PERRET-DU-CRAY-openstreetmap/a2979c63-80d6-4916-9792-e3ad9f1d9403/scratchpad/browser/qa-lib.mjs';
import fs from 'node:fs';
const VUES = {
  'paris-z14-p55': { vue: '14/48.8566/2.3522/0/55', couches: 'trains,transports,avions' },
  'lyon-z15-p60': { vue: '15/45.764/4.8357/0/60', couches: 'trains,transports,avions' },
  'france-z6': { vue: '6/46.6/2.5/0/30', couches: 'trains,voies,avions' },
  'alpes-z11': { vue: '11/45.35/6.5/0/60', couches: 'trains,avions' },
};
const only = process.argv[2]?.split(',');
const tag = process.env.TAG ?? 'avant';
const nuit = process.env.NUIT === '1';
const out = {};
for (const [nom, v] of Object.entries(VUES)) {
  if (only && !only.includes(nom)) continue;
  const hash = `#vue=${v.vue}&couches=${v.couches}&t=direct`;
  const { browser, page, logs } = await ouvrir(hash);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await attendre(9000);
  if (nuit) await page.waitForFunction(() => window.__carte?.map?.loaded?.(), null, { timeout: 60000 }).catch(() => {});
  if (nuit) await page.evaluate(() => { window.__carte.map.setGlobalStateProperty('nuit', 1); });
  await attendre(2000);
  await page.screenshot({ path: `perf/${tag}-${nom}${nuit ? '-nuit' : ''}.png` });
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const m0 = await m();
  const r = await page.evaluate(() => new Promise((res) => {
    const map = window.__carte.map; const b0 = map.getBearing(); const t0 = performance.now(); const dts = []; let last = t0;
    const f = (t) => { dts.push(t - last); last = t; const e = t - t0; map.setBearing(b0 + (e / 5000) * 90);
      if (e < 5000) requestAnimationFrame(f); else res({ dts, layers: map.getStyle().layers.length, dpr: devicePixelRatio, w: map.getCanvas().width }); };
    requestAnimationFrame(f);
  }));
  const m1 = await m();
  const d = r.dts.slice(2).sort((a, b) => a - b);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const frames = d.length;
  const res = { frames, moyen_ms: +mean.toFixed(1), p95_ms: +d[Math.floor(d.length * 0.95)].toFixed(1),
    cpu_ms_img: +(((m1.TaskDuration - m0.TaskDuration) / frames) * 1000).toFixed(1),
    script_ms_img: +(((m1.ScriptDuration - m0.ScriptDuration) / frames) * 1000).toFixed(1),
    couchesStyle: r.layers, canvas: r.w };
  out[nom] = res; console.log(nom, JSON.stringify(res));
  if (logs.length) console.log('  logs:', logs.slice(0, 3));
  await browser.close();
}
fs.writeFileSync(`perf/resultats-${tag}${nuit ? '-nuit' : ''}.json`, JSON.stringify(out, null, 1));
