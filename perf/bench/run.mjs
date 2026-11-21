/**
 * Chart throughput benchmark runner. Opens each variant in a real Chrome (Playwright), waits for
 * all charts to draw, then measures a passive window (data ticking, nobody touching) and an
 * interactive window (crosshair sweeps and wheel zooms over one chart).
 *
 *   node run.mjs [--variants a,b,...] [--passive 30] [--interactive 10] [--tag name] [--headed]
 *
 * Variants (servers: Deephaven on :10040, perf/web preview on :4040):
 *   ui-plotly, ui-tvl, ui-plotly-candle, ui-tvl-candle      deephaven.ui dashboards (/iframe/widget)
 *   react-plotly, react-lwc, react-plotly-candle, react-lwc-candle   standalone React + JS API
 *
 * Per window it records: frame rate and frame-time percentiles (rAF), long tasks (>50 ms) and
 * total blocking time, main-thread time by kind (CDP Performance), CPU by Chrome process (renderer,
 * GPU, browser) and by the Deephaven server process, bytes received, JS heap, data freshness
 * (newest tick time to on-screen; React and plotly variants), and input latency (Event Timing).
 */
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const DH = arg('dh', 'http://localhost:10040');
const WEB = arg('web', 'http://localhost:4040');
const CHARTS = arg('charts', 'http://localhost:4050'); // web/: the plugin's component in standalone React
const PASSIVE = Number(arg('passive', 30));
const INTERACTIVE = Number(arg('interactive', 10));
const WARMUP = Number(arg('warmup', 5));
const TAG = arg('tag', 'run');
const HEADED = process.argv.includes('--headed');
const EXTRA = arg('query', ''); // appended to React URLs, e.g. "interval=100"

const VARIANTS = {
  'ui-plotly': { url: `${DH}/iframe/widget/?name=dash_plotly`, ready: 'plotly' },
  'ui-tvl': { url: `${DH}/iframe/widget/?name=dash_tvl`, ready: 'tvl' },
  'ui-plotly-candle': { url: `${DH}/iframe/widget/?name=dash_plotly_candle`, ready: 'plotly' },
  'ui-tvl-candle': { url: `${DH}/iframe/widget/?name=dash_tvl_candle`, ready: 'tvl' },
  'react-plotly': { url: `${WEB}/?lib=plotly&kind=line`, ready: 'probe' },
  'react-lwc': { url: `${WEB}/?lib=lwc&kind=line`, ready: 'probe' },
  'react-plotly-candle': { url: `${WEB}/?lib=plotly&kind=candle`, ready: 'probe' },
  'react-lwc-candle': { url: `${WEB}/?lib=lwc&kind=candle`, ready: 'probe' },
  'ui-plotly-svg': { url: `${DH}/iframe/widget/?name=dash_plotly_svg`, ready: 'plotly' },
  'ui-plotly-1s': { url: `${DH}/iframe/widget/?name=dash_plotly_1s`, ready: 'plotly' },
  'ui-tvl-1s': { url: `${DH}/iframe/widget/?name=dash_tvl_1s`, ready: 'tvl' },
  'react-plotly-1s': { url: `${WEB}/?lib=plotly&kind=candle&bars=bars1s`, ready: 'probe' },
  'react-lwc-1s': { url: `${WEB}/?lib=lwc&kind=candle&bars=bars1s`, ready: 'probe' },
  'react-tvl-1s': { url: `${CHARTS}/?prefix=tvl1s_`, ready: 'tvl' },
  'react-tvl': { url: `${CHARTS}/?prefix=tvlt_`, ready: 'tvl' },
};
const chosen = arg('variants', 'ui-plotly,ui-tvl,react-plotly,react-lwc').split(',');

// ------------------------------------------------------------------ in-page instrumentation
const INIT = () => {
  const P = (window.__bench = { frames: [], longtasks: [], events: [], fresh: [] });
  const tick = t => {
    P.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => P.longtasks.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => P.events.push([e.startTime, e.duration, e.name]))).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
  // Freshness for plotly dashboards: watch each graph's newest x value. deephaven plotly-express
  // sends x as wall-clock strings in the server's time zone (America/New_York by default).
  const tzOffsetMs = tz => {
    const d = new Date();
    const s = d.toLocaleString('en-US', { timeZone: tz, hour12: false });
    return new Date(s + ' UTC').getTime() - Math.floor(d.getTime() / 1000) * 1000;
  };
  let nyOff = null;
  const last = new WeakMap();
  setInterval(() => {
    const gds = document.querySelectorAll('.js-plotly-plot');
    if (!gds.length || location.port === '4040') return;
    nyOff ??= tzOffsetMs('America/New_York');
    for (const gd of gds) {
      const tr = gd.data && gd.data[0];
      const xs = tr && tr.x;
      if (!xs || !xs.length) continue;
      const x = xs[xs.length - 1];
      if (last.get(gd) === x) continue;
      last.set(gd, x);
      const ms = typeof x === 'string' ? Date.parse(x.replace(' ', 'T') + 'Z') - nyOff : +x;
      if (Number.isFinite(ms)) P.fresh.push([performance.now(), Date.now() - ms]);
    }
  }, 100);
};

const READY = {
  plotly: () => {
    const g = [...document.querySelectorAll('.js-plotly-plot')];
    return g.length >= 16 && g.every(d => d.data && d.data[0] && ((d.data[0].x && d.data[0].x.length) || 0) > 0);
  },
  tvl: () => document.querySelectorAll('.tv-lightweight-charts').length >= 16,
  probe: () => window.__perf && window.__perf.ready.size >= 16,
};

// ------------------------------------------------------------------ helpers
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);

function serverPid() {
  const port = new URL(DH).port;
  const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess"`).toString().trim();
  return Number(out);
}
function cpuMs(pid) {
  return Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds"`).toString().trim());
}

async function procCpu(browserCdp) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] ?? 0) + p.cpuTime; // seconds
  return by;
}
async function perfMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

async function measureWindow(page, cdp, browserCdp, net, pid, seconds, during) {
  const t0 = await page.evaluate(() => performance.now());
  const m0 = await perfMetrics(cdp);
  const c0 = await procCpu(browserCdp);
  const s0 = cpuMs(pid);
  const b0 = net.bytes;
  const w0 = Date.now();
  await (during ? during(seconds) : page.waitForTimeout(seconds * 1000));
  const wall = (Date.now() - w0) / 1000;
  const t1 = await page.evaluate(() => performance.now());
  const m1 = await perfMetrics(cdp);
  const c1 = await procCpu(browserCdp);
  const s1 = cpuMs(pid);
  const inPage = await page.evaluate(
    ([a, b]) => {
      const B = window.__bench;
      const frames = B.frames.filter(t => t >= a && t <= b);
      const lt = B.longtasks.filter(([s]) => s >= a && s <= b);
      const ev = B.events.filter(([s]) => s >= a && s <= b);
      const fr = B.fresh.filter(([s]) => s >= a && s <= b).map(([, f]) => f);
      const probe = window.__perf ? window.__perf.freshness.splice(0) : [];
      return { frames, lt, ev, fresh: fr.concat(probe), heap: performance.memory ? performance.memory.usedJSHeapSize : null };
    },
    [t0, t1],
  );
  const dts = inPage.frames.slice(1).map((t, i) => t - inPage.frames[i]);
  const d = k => (m1[k] ?? 0) - (m0[k] ?? 0);
  const mainBusy = d('TaskDuration');
  return {
    seconds: r1(wall),
    fps: r1(inPage.frames.length / wall),
    frameMs: { p50: r1(pct(dts, 50)), p95: r1(pct(dts, 95)), p99: r1(pct(dts, 99)), max: r1(Math.max(0, ...dts)) },
    framesOver50ms: dts.filter(x => x > 50).length,
    longTasks: {
      count: inPage.lt.length,
      totalBlockingMsPerSec: r1(inPage.lt.reduce((s, [, du]) => s + Math.max(0, du - 50), 0) / wall),
      max: r1(Math.max(0, ...inPage.lt.map(([, du]) => du))),
    },
    mainThreadPct: r1((100 * mainBusy) / wall),
    mainThreadMsPerSec: {
      script: r1((1000 * d('ScriptDuration')) / wall),
      layout: r1((1000 * d('LayoutDuration')) / wall),
      style: r1((1000 * d('RecalcStyleDuration')) / wall),
      task: r1((1000 * mainBusy) / wall),
    },
    cpuPctOfOneCore: Object.fromEntries(
      Object.keys(c1).map(k => [k, r1((100 * (c1[k] - (c0[k] ?? 0))) / wall)]).concat([['dhServer', r1((s1 - s0) / 10 / wall)]]),
    ),
    kbReceivedPerSec: r1((net.bytes - b0) / 1024 / wall),
    heapMB: inPage.heap ? r1(inPage.heap / 1048576) : null,
    freshnessMs: inPage.fresh.length
      ? { n: inPage.fresh.length, p50: Math.round(pct(inPage.fresh, 50)), p95: Math.round(pct(inPage.fresh, 95)), max: Math.round(Math.max(...inPage.fresh)) }
      : null,
    inputLatencyMs: inPage.ev.length
      ? { n: inPage.ev.length, p50: Math.round(pct(inPage.ev.map(e => e[1]), 50)), p95: Math.round(pct(inPage.ev.map(e => e[1]), 95)), max: Math.round(Math.max(...inPage.ev.map(e => e[1]))) }
      : { n: 0 },
  };
}

/** Crosshair sweeps and wheel zooms over the first chart, like a trader inspecting a move. */
async function interact(page, seconds) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('.tv-lightweight-charts, .js-plotly-plot, .chart');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const end = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < end) {
    const f = (i % 60) / 60;
    await page.mouse.move(box.x + box.w * (0.1 + 0.8 * f), box.y + box.h * (0.3 + 0.4 * Math.sin(i / 7)));
    if (i % 30 === 15) await page.mouse.wheel(0, i % 60 < 30 ? -200 : 200);
    i++;
    await page.waitForTimeout(16);
  }
}

// ------------------------------------------------------------------ main
const pid = serverPid();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !HEADED,
  args: ['--window-size=1920,1080', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
});
const browserCdp = await browser.newBrowserCDPSession();
const results = { tag: TAG, when: new Date().toISOString(), headed: HEADED, passiveS: PASSIVE, interactiveS: INTERACTIVE, query: EXTRA, variants: {} };

for (const name of chosen) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant ${name}`);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  const net = { bytes: 0 };
  cdp.on('Network.dataReceived', e => (net.bytes += e.encodedDataLength || e.dataLength || 0));
  cdp.on('Network.webSocketFrameReceived', e => (net.bytes += e.response.opcode === 2 ? (e.response.payloadData.length * 3) / 4 : e.response.payloadData.length));
  const url = v.url + (v.ready === 'probe' && EXTRA ? `&${EXTRA}` : '');

  process.stdout.write(`${name}: loading ... `);
  const tLoad = Date.now();
  await page.goto(url);
  try {
    await page.waitForFunction(READY[v.ready], null, { timeout: 120000, polling: 100 });
  } catch {
    // a variant that cannot draw all its charts in 2 minutes is a result too
    console.log('FAILED: not all charts drawn within 120 s');
    results.variants[name] = { url, failed: 'not all charts drawn within 120 s' };
    await ctx.close();
    continue;
  }
  const timeToReadyMs = Date.now() - tLoad;
  const loadKB = Math.round(net.bytes / 1024); // everything downloaded up to the first full draw
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'none';
  });
  process.stdout.write(`ready in ${timeToReadyMs} ms; warmup ${WARMUP}s; passive ${PASSIVE}s ... `);
  await page.waitForTimeout(WARMUP * 1000);
  const passive = await measureWindow(page, cdp, browserCdp, net, pid, PASSIVE);
  process.stdout.write(`interactive ${INTERACTIVE}s ... `);
  const interactive = await measureWindow(page, cdp, browserCdp, net, pid, INTERACTIVE, s => interact(page, s));
  console.log('done');
  results.variants[name] = { url, timeToReadyMs, loadKB, gpu, passive, interactive };
  await ctx.close();
}
await browser.close();

const out = join(HERE, '..', 'results', `${TAG}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 2));

// summary
const rows = Object.entries(results.variants).filter(([, r]) => !r.failed).map(([n, r]) => ({
  variant: n,
  readyS: r1(r.timeToReadyMs / 1000),
  fps: r.passive.fps,
  'p95 frame': r.passive.frameMs.p95,
  'main %': r.passive.mainThreadPct,
  'TBT ms/s': r.passive.longTasks.totalBlockingMsPerSec,
  'renderer %': r.passive.cpuPctOfOneCore.renderer,
  'gpu %': r.passive.cpuPctOfOneCore.GPU,
  'server %': r.passive.cpuPctOfOneCore.dhServer,
  'KB/s': r.passive.kbReceivedPerSec,
  'fresh p50': r.passive.freshnessMs?.p50 ?? '-',
  'fresh p95': r.passive.freshnessMs?.p95 ?? '-',
  'int fps': r.interactive.fps,
  'int p95 frame': r.interactive.frameMs.p95,
  'input p95': r.interactive.inputLatencyMs.p95 ?? '-',
}));
console.table(rows);
console.log(`wrote ${out}`);
