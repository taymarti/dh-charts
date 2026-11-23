/**
 * The toolbar's styles, injected once per document, so the component looks the same in any host
 * (our React apps, deephaven.ui via the server plugin) with no CSS build step. TradingView-like dark
 * theme; every class is prefixed `acme-tb-`. Colors are CSS variables, so a host can re-theme them.
 */
const CSS = `
.acme-tb, .acme-lg, .acme-wl {
  --acme-tb-bg: #131722; --acme-tb-fg: #d1d4dc; --acme-tb-muted: #787b86; --acme-tb-hover: #2a2e39;
  --acme-tb-border: #2a2e39; --acme-tb-accent: #2962ff; --acme-tb-panel: #1e222d;
  --acme-up: #26a69a; --acme-down: #ef5350;
}
.acme-tb {
  display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-height: 38px; padding: 0 6px; box-sizing: border-box;
  background: var(--acme-tb-bg); border-bottom: 1px solid var(--acme-tb-border); color: var(--acme-tb-fg);
  font: 13px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
  user-select: none; position: relative; flex: none;
}
.acme-tb-sep { width: 1px; height: 22px; background: var(--acme-tb-border); margin: 0 4px; }
.acme-tb-spacer { flex: 1; }
.acme-tb-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: none;
  border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap;
}
.acme-tb-btn:hover { background: var(--acme-tb-hover); }
.acme-tb-btn.active { color: var(--acme-tb-accent); }
.acme-tb-btn.on { background: var(--acme-tb-hover); color: #fff; }
.acme-tb-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.acme-tb-sym { font-weight: 600; letter-spacing: .2px; }
.acme-tb-caret { width: 8px !important; height: 8px !important; opacity: .7; }
.acme-tb-pop {
  position: absolute; top: 36px; z-index: 50; min-width: 180px; max-height: 420px; overflow: auto;
  background: var(--acme-tb-panel); border: 1px solid var(--acme-tb-border); border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.5); padding: 4px 0;
}
.acme-tb-group { padding: 8px 14px 4px; color: var(--acme-tb-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.acme-tb-item { display: flex; align-items: center; gap: 10px; padding: 7px 14px; cursor: pointer; }
.acme-tb-item:hover { background: var(--acme-tb-hover); }
.acme-tb-item.selected { color: var(--acme-tb-accent); }
.acme-tb-item svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.acme-tb-item .acme-tb-check { margin-left: auto; color: var(--acme-tb-accent); }
.acme-tb-search {
  margin: 6px 8px 4px; width: calc(100% - 16px); box-sizing: border-box; height: 32px; padding: 0 10px;
  background: var(--acme-tb-bg); color: var(--acme-tb-fg); border: 1px solid var(--acme-tb-border);
  border-radius: 4px; font: inherit; outline: none;
}
.acme-tb-search:focus { border-color: var(--acme-tb-accent); }
.acme-tb-modal-bg { pointer-events: auto; position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; }
.acme-tb-modal {
  margin-top: 10vh; width: 440px; max-width: calc(100vw - 32px); max-height: 70vh; display: flex; flex-direction: column;
  background: var(--acme-tb-panel); color: var(--acme-tb-fg); border: 1px solid var(--acme-tb-border); border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,.6); font: 13px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
}
.acme-tb-modal-head { display: flex; align-items: center; padding: 14px 16px 6px; font-size: 16px; font-weight: 600; }
.acme-tb-modal-head .acme-tb-btn { margin-left: auto; height: 26px; padding: 0 6px; }
.acme-tb-modal-list { overflow: auto; padding-bottom: 8px; }
.acme-tb-empty { padding: 16px; color: var(--acme-tb-muted); }
.acme-tb-pop .acme-tb-item.toggle { padding-left: 14px; }
.acme-tb-box { width: 14px; height: 14px; border: 1px solid var(--acme-tb-muted); border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.acme-tb-box.on { background: var(--acme-tb-accent); border-color: var(--acme-tb-accent); color: #fff; }
.acme-tb-count { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; background: var(--acme-tb-accent); color: #fff; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }

/* legend (ChartLegend) */
.acme-lg {
  position: absolute; top: 6px; z-index: 6; pointer-events: none; color: var(--acme-tb-fg);
  font: 12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
}
.acme-lg-row { display: flex; align-items: center; gap: 8px; height: 22px; white-space: nowrap; }
.acme-lg-title { font-weight: 600; font-size: 13px; }
.acme-lg-k { color: var(--acme-tb-muted); margin-right: 2px; }
.acme-lg-study { pointer-events: auto; padding: 0 4px; margin-left: -4px; border-radius: 4px; border: 1px solid transparent; width: fit-content; }
.acme-lg-study:hover { border-color: var(--acme-tb-border); background: rgba(19, 23, 34, .75); }
.acme-lg-study.hidden .acme-lg-label { color: var(--acme-tb-muted); }
.acme-lg-tools { display: none; gap: 1px; }
.acme-lg-study:hover .acme-lg-tools, .acme-lg-study.hidden .acme-lg-tools { display: inline-flex; }
.acme-lg-tools button { width: 20px; height: 20px; padding: 0; border: none; border-radius: 3px; background: transparent; color: var(--acme-tb-fg); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.acme-lg-tools button:hover { background: var(--acme-tb-hover); }
.acme-lg-tools svg, .acme-wl svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.acme-lg-form { padding: 8px 16px; display: flex; flex-direction: column; gap: 10px; }
.acme-lg-form label { display: flex; align-items: center; gap: 12px; }
.acme-lg-form label > span:first-child { width: 120px; color: var(--acme-tb-muted); }
.acme-lg-form .acme-tb-search { margin: 0; flex: 1; width: auto; }
.acme-lg-swatches { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.acme-lg-swatches button { width: 20px; height: 20px; border-radius: 3px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.acme-lg-swatches button.on { border-color: #fff; }
.acme-lg-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 16px 14px; }
.acme-lg-actions .acme-tb-btn { border: 1px solid var(--acme-tb-border); padding: 0 16px; }
.acme-lg-actions .acme-lg-ok { background: var(--acme-tb-accent); border-color: var(--acme-tb-accent); color: #fff; }
.acme-lg-actions .acme-lg-ok:disabled { opacity: .5; cursor: default; }

/* watchlist (Watchlist) */
.acme-wl {
  display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box;
  background: var(--acme-tb-bg); color: var(--acme-tb-fg); border-left: 1px solid var(--acme-tb-border);
  font: 13px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif; user-select: none;
}
.acme-wl-head { height: 38px; flex: none; display: flex; align-items: center; padding: 0 12px; font-weight: 600; border-bottom: 1px solid var(--acme-tb-border); }
.acme-wl-cols, .acme-wl-row { display: grid; grid-template-columns: 1.1fr 1.2fr 1fr 1fr; gap: 6px; padding: 0 12px; align-items: center; }
.acme-wl-cols { height: 26px; flex: none; color: var(--acme-tb-muted); font-size: 11px; }
.acme-wl-cols span:not(:first-child), .acme-wl-row span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.acme-wl-body { overflow: auto; flex: 1; min-height: 0; }
.acme-wl-row { height: 30px; cursor: pointer; border-left: 2px solid transparent; padding-left: 10px; }
.acme-wl-row:hover { background: var(--acme-tb-hover); }
.acme-wl-row.selected { background: rgba(41, 98, 255, .16); border-left-color: var(--acme-tb-accent); }
.acme-wl-sym { font-weight: 600; }
.acme-wl-row .up { color: var(--acme-up); }
.acme-wl-row .down { color: var(--acme-down); }
@keyframes acme-wl-up { from { background: rgba(38, 166, 154, .45); } to { background: transparent; } }
@keyframes acme-wl-down { from { background: rgba(239, 83, 80, .45); } to { background: transparent; } }
.acme-wl-flash-up { animation: acme-wl-up .6s ease-out; border-radius: 2px; }
.acme-wl-flash-down { animation: acme-wl-down .6s ease-out; border-radius: 2px; }

/* legend: market status */
.acme-lg-status { pointer-events: auto; display: inline-flex; align-items: center; padding: 4px; cursor: default; }
.acme-lg-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

/* alerts (AlertsPanel) */
.acme-al-form { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--acme-tb-border); flex: none; }
.acme-al-form .acme-tb-search { margin: 0; width: 100%; height: 30px; }
.acme-al-form select.acme-tb-search { padding: 0 6px; }
.acme-al-row { display: flex; gap: 6px; }
.acme-al-sym { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.acme-al-sym svg { width: 16px; height: 16px; fill: none; stroke: #ff9800; stroke-width: 1.5; }
.acme-al-form .acme-lg-ok { justify-content: center; background: var(--acme-tb-accent); color: #fff; }
.acme-al-form .acme-lg-ok:disabled { opacity: .5; cursor: default; }
.acme-al-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 12px; border-left: 2px solid #ff9800; margin: 2px 0; }
.acme-al-item.fired { border-left-color: var(--acme-tb-muted); }
.acme-al-item > div { flex: 1; min-width: 0; }
.acme-al-sub { color: var(--acme-tb-muted); font-size: 12px; margin-top: 2px; }
.acme-al-item button { width: 20px; height: 20px; padding: 0; border: none; border-radius: 3px; background: transparent; color: var(--acme-tb-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.acme-al-item button:hover { background: var(--acme-tb-hover); color: var(--acme-tb-fg); }

/* a chart pane in a multi-chart layout (ChartFrame) */
.acme-frame { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box; border: 1px solid transparent; }
.acme-frame.multi { border-color: #2a2e39; }
.acme-frame.multi.active { border-color: #2962ff; }
`;

let injected = false;

export function injectToolbarStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'acme-chart-toolbar-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
