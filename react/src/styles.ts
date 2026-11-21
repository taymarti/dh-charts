/**
 * The toolbar's styles, injected once per document, so the component looks the same in any host
 * (our React apps, deephaven.ui via the server plugin) with no CSS build step. TradingView-like dark
 * theme; every class is prefixed `acme-tb-`. Colors are CSS variables, so a host can re-theme them.
 */
const CSS = `
.acme-tb {
  --acme-tb-bg: #131722; --acme-tb-fg: #d1d4dc; --acme-tb-muted: #787b86; --acme-tb-hover: #2a2e39;
  --acme-tb-border: #2a2e39; --acme-tb-accent: #2962ff; --acme-tb-panel: #1e222d;
  display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 6px; box-sizing: border-box;
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
.acme-tb-modal-bg { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; }
.acme-tb-modal {
  margin-top: 10vh; width: 440px; max-width: calc(100vw - 32px); max-height: 70vh; display: flex; flex-direction: column;
  background: var(--acme-tb-panel); color: var(--acme-tb-fg); border: 1px solid var(--acme-tb-border); border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,.6); font: 13px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
}
.acme-tb-modal-head { display: flex; align-items: center; padding: 14px 16px 6px; font-size: 16px; font-weight: 600; }
.acme-tb-modal-head .acme-tb-btn { margin-left: auto; height: 26px; padding: 0 6px; }
.acme-tb-modal-list { overflow: auto; padding-bottom: 8px; }
.acme-tb-empty { padding: 16px; color: var(--acme-tb-muted); }
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
