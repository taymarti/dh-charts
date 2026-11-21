/** Print one comparison table across result files: node summarize.mjs base flat short ... */
import { readFileSync } from 'node:fs';
const rows = [];
for (const tag of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(new URL(`../results/${tag}.json`, import.meta.url)));
  for (const [n, v] of Object.entries(r.variants)) {
    if (v.failed) { rows.push({ cfg: tag, variant: n, readyS: "FAILED" }); continue; }
    const p = v.passive, i = v.interactive;
    rows.push({
      cfg: tag, variant: n, readyS: +(v.timeToReadyMs / 1000).toFixed(1), loadKB: v.loadKB ?? '-',
      fps: p.fps, p95fr: p.frameMs.p95, main: p.mainThreadPct, script: p.mainThreadMsPerSec.script, tbt: p.longTasks.totalBlockingMsPerSec,
      rend: p.cpuPctOfOneCore.renderer, gpu: p.cpuPctOfOneCore.GPU, brws: p.cpuPctOfOneCore.browser, srv: p.cpuPctOfOneCore.dhServer,
      kbs: p.kbReceivedPerSec, heap: p.heapMB, f50: p.freshnessMs?.p50 ?? '-', f95: p.freshnessMs?.p95 ?? '-',
      ifps: i.fps, ip95fr: i.frameMs.p95, in95: i.inputLatencyMs.p95 ?? '-',
    });
  }
}
console.table(rows);
