/**
 * Run the benchmark across server configurations. For each config: start a fresh Deephaven server
 * on :10040 with that config's environment and JVM flags, run run.mjs over its variants, stop it.
 *
 *   node matrix.mjs [--only name1,name2] [--passive 30] [--interactive 10]
 *
 * Needs JAVA_HOME, the server venv (.venv, or DH_PYTHON = its python), and the perf/web preview on :4040.
 */
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const PASSIVE = arg('passive', '30');
const INTERACTIVE = arg('interactive', '10');

const LINE = 'ui-plotly,ui-tvl,react-plotly,react-lwc';
const CANDLE = 'ui-plotly-candle,ui-tvl-candle,react-plotly-candle,react-lwc-candle';
const BARS1S = 'ui-plotly-1s,ui-tvl-1s,react-plotly-1s,react-lwc-1s';
const TVL3 = 'ui-tvl-1s,react-tvl-1s,react-lwc-1s'; // the same plugin in deephaven.ui and in React, plus the hand-written client
const FAST = ['-DPeriodicUpdateGraph.targetCycleDurationMillis=100', '-Dbarrage.minUpdateInterval=100'];

const CONFIGS = [
  { name: 'base', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '0' }, variants: LINE },
  { name: 'flat', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, variants: LINE },
  { name: 'short', env: { PERF_RATE: '10', PERF_HISTORY_S: '120', PERF_FLATTEN: '1' }, variants: LINE },
  { name: 'fast', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, jvm: FAST, query: 'interval=100', variants: LINE },
  { name: 'heavy', env: { PERF_RATE: '50', PERF_HISTORY_S: '1200', PERF_FLATTEN: '1' }, variants: LINE },
  { name: 'candle', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, variants: CANDLE },
  // follow-ups: plotly without WebGL; 1-second bars at default and 100 ms cadence
  { name: 'svg', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, variants: 'ui-plotly-svg' },
  { name: 'bars1s', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, variants: BARS1S },
  { name: 'bars1s-fast', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, jvm: FAST, query: 'interval=100', variants: BARS1S },
  // pattern A: does hosting the plugin in standalone React differ from deephaven.ui?
  { name: 'host', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, variants: TVL3 },
  { name: 'host-fast', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, jvm: FAST, query: 'interval=100', variants: TVL3 },
  // the same, measured with the time-zone cache (first as a bundle patch; now part of the fork build)
  { name: 'host-fast-tz', env: { PERF_RATE: '10', PERF_HISTORY_S: '1800', PERF_FLATTEN: '1' }, jvm: FAST, query: 'interval=100', variants: 'ui-tvl-1s,react-tvl-1s' },
];
const only = arg('only', null)?.split(',');

function killPort(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /T /F /PID $_.OwningProcess }"`,
      { stdio: 'ignore' },
    );
  } catch {}
}

function startServer(cfg) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...cfg.env, PYTHONUNBUFFERED: '1' };
    env.JAVA_HOME ??= 'C:/Program Files/JetBrains/PyCharm 2023.3.3/jbr';
    const args = ['run_server.py', '--port', '10040', '--heap', '4g', '--app-dir', 'perf/app.d', ...(cfg.jvm ?? []).map(j => `--jvm-arg=${j}`)];
    const python = process.env.DH_PYTHON ?? join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const p = spawn(python, args, { cwd: ROOT, env });
    let log = '';
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log.slice(-2000)}`)), 180000);
    const on = d => {
      log += d;
      if (log.includes('Deephaven is up')) {
        clearTimeout(t);
        resolve(p);
      }
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('exit', c => reject(new Error(`server exited ${c}:\n${log.slice(-2000)}`)));
  });
}

for (const cfg of CONFIGS) {
  if (only && !only.includes(cfg.name)) continue;
  console.log(`\n=== config ${cfg.name}: ${JSON.stringify(cfg.env)} ${cfg.jvm?.join(' ') ?? ''}`);
  killPort(10040);
  const server = await startServer(cfg);
  await new Promise(r => setTimeout(r, 10000)); // let the backfill settle
  const runArgs = ['run.mjs', '--variants', cfg.variants, '--tag', cfg.name, '--passive', PASSIVE, '--interactive', INTERACTIVE];
  if (cfg.query) runArgs.push('--query', cfg.query);
  execSync(`node ${runArgs.join(' ')}`, { cwd: HERE, stdio: 'inherit' });
  server.removeAllListeners('exit');
  killPort(10040);
}
console.log('\nmatrix done');
