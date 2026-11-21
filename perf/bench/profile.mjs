/**
 * CPU-profile one benchmark variant: where does the page's main-thread time go?
 *   node profile.mjs <url> [--seconds 10] [--ready probe|plotly|tvl] [--top 25]
 * Prints the top functions by self time (and by script URL), from a CDP sampling profile taken
 * after the page has drawn and settled.
 */
import { chromium } from 'playwright-core';

const url = process.argv[2];
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const SECONDS = Number(arg('seconds', 10));
const TOP = Number(arg('top', 25));
const READY = {
  plotly: () => document.querySelectorAll('.js-plotly-plot').length >= 16,
  tvl: () => document.querySelectorAll('.tv-lightweight-charts').length >= 16,
  probe: () => window.__perf && window.__perf.ready.size >= 16,
}[arg('ready', 'probe')];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--window-size=1920,1080'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await page.goto(url);
await page.waitForFunction(READY, null, { timeout: 120000, polling: 200 });
await page.waitForTimeout(5000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.waitForTimeout(SECONDS * 1000);
const { profile } = await cdp.send('Profiler.stop');
await browser.close();

const dt = {};
const { samples, timeDeltas, nodes } = profile;
const byId = new Map(nodes.map(n => [n.id, n]));
const self = new Map();
for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0) / 1000);
const fn = new Map();
const file = new Map();
let total = 0;
for (const [id, ms] of self) {
  const cf = byId.get(id).callFrame;
  const key = `${cf.functionName || '(anon)'}  ${cf.url.split('/').pop()}:${cf.lineNumber}`;
  fn.set(key, (fn.get(key) ?? 0) + ms);
  const f = cf.url ? cf.url.split('?')[0].split('/').slice(-2).join('/') : `(${cf.functionName})`;
  file.set(f, (file.get(f) ?? 0) + ms);
  total += ms;
}
const show = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k, ms]) => console.log(`${(ms / SECONDS).toFixed(1).padStart(7)} ms/s  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${k}`));
console.log(`\n== by script (self time, ms per second of wall time; total ${(total / SECONDS).toFixed(0)} ms/s incl. idle)`);
show(file, 12);
console.log(`\n== top ${TOP} functions by self time`);
show(fn, TOP);
void dt;
