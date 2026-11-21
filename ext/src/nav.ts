/**
 * Chart navigation, as in TradingView:
 *   - the initial view: the last `viewWindow` seconds of the data (or all of it), applied once the
 *     chart has data and again whenever the host changes the window;
 *   - history on demand: scrolling into the oldest loaded bar calls `onHistory()`, and the host loads
 *     more (a deephaven.ui workspace widens its server-side lookback; the chart's table grows in
 *     place, so the view stays where the user left it);
 *   - "jump to now" (») when the view is off the latest bar, and "go to date" (Alt+G), which loads
 *     history first if the date is older than what the chart holds.
 * A DOM overlay on any LWC chart, no Deephaven dependency.
 *
 *   const nav = bindNavigation(chart, series, host, { viewWindow: 1800, onHistory })
 *   nav.update({ viewWindow: 3600 }); nav.dispose()
 */
import type { IChartApi, ISeriesApi, LogicalRange, SeriesType, Time } from 'lightweight-charts';
import { NEED_HISTORY } from './sync';

export interface NavOptions {
  /** seconds to show at the end of the data; null: all of it; undefined: leave the view alone */
  viewWindow?: number | null;
  /** load older data; `before` (UTC seconds) asks to reach a date, none asks for "more" */
  onHistory?: (before?: number) => void;
  /** nothing older to load */
  historyComplete?: boolean;
  /** delay before the first view is applied, so the host's own initial fit settles first (ms) */
  settleMs?: number;
}

type Bar = { time?: unknown };

const BTN = {
  height: '24px', minWidth: '24px', padding: '0 6px', border: '1px solid #2a2e39', borderRadius: '4px', cursor: 'pointer',
  background: 'rgba(30, 34, 45, 0.92)', color: '#d1d4dc', font: '12px -apple-system, "Trebuchet MS", Roboto, sans-serif',
};

/** The shortcut target: the chart the pointer was last over. */
let active: object | null = null;

export function bindNavigation(chart: IChartApi, series: ISeriesApi<SeriesType>, host: HTMLElement, initial: NavOptions = {}) {
  let opts: NavOptions = { settleMs: 1200, ...initial };
  const me = {};
  const ts = chart.timeScale();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  // ---- overlay: [go to date] [»]  bottom right, above the time axis; "Loading history" bottom left
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'absolute', zIndex: '6', display: 'flex', gap: '4px', alignItems: 'center' });
  const dateBtn = document.createElement('button');
  dateBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg>';
  dateBtn.style.display = 'inline-flex';
  dateBtn.style.alignItems = 'center';
  dateBtn.style.justifyContent = 'center';
  dateBtn.title = 'Go to date (Alt+G)';
  const nowBtn = document.createElement('button');
  nowBtn.textContent = '»';
  nowBtn.title = 'Scroll to the latest bar';
  for (const b of [dateBtn, nowBtn]) {
    Object.assign(b.style, BTN);
    b.addEventListener('mousedown', ev => ev.stopPropagation());
  }
  box.append(dateBtn, nowBtn);
  const loading = document.createElement('div');
  Object.assign(loading.style, {
    position: 'absolute', zIndex: '6', display: 'none', padding: '2px 8px', borderRadius: '10px', background: 'rgba(41, 98, 255, 0.85)',
    color: '#fff', font: '11px -apple-system, "Trebuchet MS", Roboto, sans-serif', pointerEvents: 'none',
  });
  loading.textContent = 'Loading history…';
  host.append(box, loading);

  const place = () => {
    let cr: DOMRect;
    let axisH: number;
    let scaleW: number;
    try {
      cr = chart.chartElement().getBoundingClientRect();
      axisH = ts.height() || 26;
      scaleW = chart.priceScale('right').width() || 0;
    } catch {
      return; // the chart is between series (being rebuilt) or gone
    }
    const hr = host.getBoundingClientRect();
    box.style.left = '';
    box.style.right = `${hr.right - cr.right + scaleW + 8}px`;
    box.style.top = `${cr.bottom - hr.top - axisH - 32}px`;
    loading.style.left = `${cr.left - hr.left + 44}px`;
    loading.style.top = `${cr.bottom - hr.top - axisH - 28}px`;
  };

  // ---- data extent
  const data = () => series.data() as Bar[];
  const lastTime = () => {
    const d = data();
    return d.length ? Number(d[d.length - 1].time) : undefined;
  };
  const firstTime = () => {
    const d = data();
    return d.length ? Number(d[0].time) : undefined;
  };

  const showRange = (from: number, to: number) => {
    try {
      ts.setVisibleRange({ from: Math.floor(from) as Time, to: Math.ceil(to) as Time });
    } catch {
      /* no data yet */
    }
  };
  const toNow = () => {
    const r = ts.getVisibleRange();
    const last = lastTime();
    if (!r || last == null) return;
    const span = Number(r.to) - Number(r.from);
    showRange(last - span, last);
  };

  // ---- the view window
  let applied: number | null | undefined = undefined; // the window last applied
  let appliedAt = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const applyWindow = () => {
    const last = lastTime();
    const first = firstTime();
    if (last == null || first == null || opts.viewWindow === undefined) return false;
    if (opts.viewWindow === null) ts.fitContent();
    else showRange(Math.max(first, last - opts.viewWindow), last);
    applied = opts.viewWindow;
    appliedAt = Date.now();
    // for tests and debugging, like the plugin's data-tvl-state
    host.dataset.acmeView = JSON.stringify({ window: opts.viewWindow, attempts: attempts + 1, at: Math.round(last) });
    return true;
  };
  // A host may still fit the view to its data for a while after the first data (Deephaven's plugin does
  // until it has settled), so wait for data, then the settle time, then check the view took and re-apply
  // if it did not.
  let attempts = 0; // applications of the current window (reported in data-acme-view)
  const spanOk = () => {
    if (opts.viewWindow == null) return true;
    const r = ts.getVisibleRange();
    const first = firstTime();
    const last = lastTime();
    if (!r || first == null || last == null) return false;
    const want = Math.min(opts.viewWindow, last - first);
    const tol = Math.max(want * 0.15, 2);
    // the right span, ending at the latest bar (a reused chart can still be showing an old range)
    return Math.abs(Number(r.to) - Number(r.from) - want) <= tol && Math.abs(Number(r.to) - last) <= Math.max(tol, 60);
  };
  let settled = !opts.settleMs; // the host has had its settle time since the first data
  const scheduleWindow = (delay: number, fresh = true) => {
    clearTimeout(settleTimer);
    if (fresh) attempts = 0;
    settleTimer = setTimeout(() => {
      if (lastTime() == null) return scheduleWindow(500, false); // no data yet
      if (!settled) {
        settled = true;
        return scheduleWindow(opts.settleMs ?? 0, false); // data just came: let the host settle first
      }
      applyWindow();
      attempts++;
      // Keep the window for a while: the host may still reshape the data (a new lookback, a resample)
      // and move the view. Stop as soon as the user takes over (pointer or wheel on the chart).
      const until = Date.now() + 10000;
      userTouched = false;
      const enforce = () => {
        if (userTouched || Date.now() > until) return;
        if (!spanOk()) {
          applyWindow();
          attempts++;
        }
        settleTimer = setTimeout(enforce, 1000);
      };
      settleTimer = setTimeout(enforce, 1000);
    }, delay);
  };
  let userTouched = false;
  const touch = () => (userTouched = true);
  host.addEventListener('pointerdown', touch, true);
  host.addEventListener('wheel', touch, true);
  scheduleWindow(0);

  // ---- history on demand
  let pendingFor: number | undefined; // the oldest time when we last asked
  let pendingTarget: number | undefined; // a date to go to once loaded
  let pendingRange: { from: number; to: number } | undefined; // a synced range to show once loaded
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const askHistory = (before?: number) => {
    if (!opts.onHistory || opts.historyComplete) return;
    pendingFor = firstTime();
    loading.style.display = 'block';
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => (loading.style.display = 'none'), 8000);
    opts.onHistory(before);
  };
  const onRange = (r: LogicalRange | null) => {
    nowBtn.style.visibility = isAtNow() ? 'hidden' : 'visible';
    // only the user's own scrolling asks for more: not a chart being (re)built under the pointer
    if (!r || !host.matches(':hover') || applied === undefined || Date.now() - appliedAt < 2000) return;
    if (r.from <= 2 && data().length > 0 && pendingFor !== firstTime()) askHistory();
  };
  const isAtNow = () => {
    const r = ts.getVisibleRange();
    const last = lastTime();
    if (!r || last == null) return true;
    const span = Number(r.to) - Number(r.from);
    return Number(r.to) >= last - Math.max(1, span * 0.01);
  };
  const onData = () => {
    const first = firstTime();
    if (pendingFor !== undefined && first !== undefined && first < pendingFor) {
      // older bars arrived
      pendingFor = undefined;
      loading.style.display = 'none';
    }
    if (pendingRange && first !== undefined && (first <= pendingRange.from || opts.historyComplete)) {
      const r = pendingRange;
      pendingRange = undefined;
      showRange(r.from, r.to);
    }
    if (pendingTarget !== undefined && first !== undefined && (first <= pendingTarget || opts.historyComplete)) {
      const t = pendingTarget;
      pendingTarget = undefined;
      center(t);
    }
    nowBtn.style.visibility = isAtNow() ? 'hidden' : 'visible';
    place();
  };
  const center = (t: number) => {
    const r = ts.getVisibleRange();
    const span = r ? Number(r.to) - Number(r.from) : 3600;
    showRange(t - span / 2, t + span / 2);
  };

  // ---- go to date
  let pop: HTMLElement | null = null;
  const closePop = () => {
    pop?.remove();
    pop = null;
  };
  const goTo = (t: number) => {
    const first = firstTime();
    if (first !== undefined && t < first && opts.onHistory && !opts.historyComplete) {
      pendingTarget = t;
      askHistory(t);
    } else center(t);
  };
  const openPop = () => {
    if (pop) return closePop();
    pop = document.createElement('div');
    Object.assign(pop.style, {
      position: 'absolute', zIndex: '7', display: 'flex', gap: '6px', padding: '8px', background: '#1e222d',
      border: '1px solid #2a2e39', borderRadius: '6px', boxShadow: '0 6px 24px rgba(0,0,0,.5)',
    });
    const input = document.createElement('input');
    input.type = 'datetime-local';
    const last = lastTime();
    if (last != null) {
      const d = new Date((last - 86400) * 1000);
      input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    Object.assign(input.style, {
      background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: '4px', padding: '4px 6px',
      colorScheme: 'dark', font: '12px -apple-system, "Trebuchet MS", Roboto, sans-serif',
    });
    const go = document.createElement('button');
    go.textContent = 'Go to';
    Object.assign(go.style, BTN, { background: '#2962ff', borderColor: '#2962ff', color: '#fff' });
    const submit = () => {
      const t = new Date(input.value).getTime() / 1000; // the browser's local time
      closePop();
      if (Number.isFinite(t)) goTo(t);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') submit();
      if (ev.key === 'Escape') closePop();
      ev.stopPropagation();
    });
    pop.addEventListener('mousedown', ev => ev.stopPropagation());
    pop.append(input, go);
    host.appendChild(pop);
    pop.style.right = box.style.right;
    pop.style.top = `${parseFloat(box.style.top) - 50}px`;
    input.focus();
  };
  dateBtn.addEventListener('click', openPop);
  nowBtn.addEventListener('click', toNow);

  const onKey = (ev: KeyboardEvent) => {
    if (active !== me || !ev.altKey || ev.code !== 'KeyG') return;
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    ev.preventDefault();
    openPop();
  };
  const onNeedHistory = (ev: Event) => {
    const d = (ev as CustomEvent<{ before: number; from: number; to: number }>).detail;
    if (!opts.onHistory || opts.historyComplete) return;
    pendingRange = { from: d.from, to: d.to };
    if (pendingFor !== firstTime()) askHistory(d.before);
  };
  host.addEventListener(NEED_HISTORY, onNeedHistory);
  const onEnter = () => (active = me);
  host.addEventListener('mousemove', onEnter);
  window.addEventListener('keydown', onKey);
  ts.subscribeVisibleLogicalRangeChange(onRange);
  series.subscribeDataChanged(onData);
  const ro = new ResizeObserver(place);
  ro.observe(host);
  place();
  nowBtn.style.visibility = 'hidden';

  return {
    update(next: NavOptions) {
      const windowChanged = next.viewWindow !== undefined && next.viewWindow !== applied;
      opts = { ...opts, ...next };
      if (windowChanged) scheduleWindow(0);
      if (opts.historyComplete) loading.style.display = 'none';
    },
    dispose() {
      clearTimeout(settleTimer);
      clearTimeout(pendingTimer);
      ro.disconnect();
      host.removeEventListener('mousemove', onEnter);
      host.removeEventListener('pointerdown', touch, true);
      host.removeEventListener('wheel', touch, true);
      host.removeEventListener(NEED_HISTORY, onNeedHistory);
      window.removeEventListener('keydown', onKey);
      try {
        ts.unsubscribeVisibleLogicalRangeChange(onRange);
        series.unsubscribeDataChanged(onData);
      } catch {
        /* the chart is gone */
      }
      closePop();
      box.remove();
      loading.remove();
      if (active === me) active = null;
    },
  };
}

export type Navigation = ReturnType<typeof bindNavigation>;
