// Expériences d'attribution : coupe un élément à la fois et mesure la rotation de 5 s.
// Usage : node perf/exp.mjs paris-z14-p55 [profil]
import { ouvrir, attendre } from '/private/tmp/claude-502/-Users-Louis-Marie-PERRET-DU-CRAY-openstreetmap/a2979c63-80d6-4916-9792-e3ad9f1d9403/scratchpad/browser/qa-lib.mjs';
import fs from 'node:fs';
const VUES = {
  'paris-z14-p55': '#vue=14/48.8566/2.3522/0/55&couches=trains,transports,avions&t=direct',
  'lyon-z15-p60': '#vue=15/45.764/4.8357/0/60&couches=trains,transports,avions&t=direct',
};
const nom = process.argv[2] ?? 'paris-z14-p55';
const profil = process.argv[3] === 'profil';
const { browser, page } = await ouvrir(VUES[nom]);
const cdp = await page.context().newCDPSession(page);
await attendre(10000);
const mesure = () => page.evaluate(() => new Promise((res) => {
  const map = window.__carte.map; const b0 = map.getBearing(); const t0 = performance.now(); const dts = []; let last = t0;
  const f = (t) => { dts.push(t - last); last = t; const e = t - t0; map.setBearing(b0 + (e / 3000) * 45);
    if (e < 3000) requestAnimationFrame(f); else { const d = dts.slice(2).sort((a, b) => a - b); res({ n: d.length, moy: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1), med: +d[d.length >> 1].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1) }); } };
  requestAnimationFrame(f);
}));
const variantes = {
  base: async () => {},
  'sans-batiments3d': async () => { await page.evaluate(() => { window.__carte.map.setLayoutProperty('building-3d', 'visibility', 'none'); }); },
  'sans-relief': async () => { await page.evaluate(() => { window.__carte.map.setTerrain(null); }); },
  'sans-ombrage': async () => { await page.evaluate(() => { window.__carte.map.setLayoutProperty('ombrage-relief', 'visibility', 'none'); }); },
  'sans-deck': async () => { await page.evaluate(() => { window.__carte.overlay.setProps({ layers: [] }); }); },
  'sans-ciel': async () => { await page.evaluate(() => { window.__carte.map.setSky({}); }); },
};
if (profil) {
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
  console.log('base', JSON.stringify(await mesure()));
  const { profile } = await cdp.send('Profiler.stop');
  const parent = new Map(); profile.nodes.forEach((n) => (n.children ?? []).forEach((c) => parent.set(c, n.id)));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const chaines = new Map(); profile.samples.forEach((id, i) => { const n = nodes.get(id); if (!new RegExp(process.env.CH ?? "readPixels|toDataURL").test(n.callFrame.functionName)) return; const ch = []; let c = id; while (c && ch.length < 12) { const f = nodes.get(c).callFrame; ch.push(`${f.functionName || 'anon'}:${f.lineNumber}`); c = parent.get(c); } const k = ch.join(' < '); chaines.set(k, (chaines.get(k) ?? 0) + profile.timeDeltas[i]); });
  [...chaines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([k, v]) => console.log('CHAINE', (v / 1000).toFixed(0), 'ms', k));
  const incl = new Map(); profile.samples.forEach((id, i) => { const seen = new Set(); let c = id; while (c) { const f = nodes.get(c).callFrame; const k = `${f.functionName || 'anon'}:${f.url.split('/').pop().split('?')[0]}:${f.lineNumber}`; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + profile.timeDeltas[i]); } c = parent.get(c); } });
  [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.INCL ?? 0)).forEach(([k, v]) => console.log('INCL', (v / 1000).toFixed(0).padStart(6), k));
  const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas; profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i]); });
  const tot = [...self.values()].reduce((a, b) => a + b, 0);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => console.log((v / 1000).toFixed(0).padStart(6), 'ms', ((v / tot) * 100).toFixed(1).padStart(5), '%', k));
} else {
  for (const [k, f] of Object.entries(variantes)) { await f(); await attendre(2500); console.log(k, JSON.stringify(await mesure())); }
}
await browser.close();
