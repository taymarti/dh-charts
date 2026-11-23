/**
 * Chart colours from the page's CSS, so a host re-themes every chart (ours and the shell's) by setting a few
 * custom properties on any ancestor of the chart, and switches them live:
 *
 *   --acme-chart-bg            background (default #131722)
 *   --acme-chart-bg-bottom     with it, a vertical gradient from --acme-chart-bg at the top to this at the bottom
 *   --acme-chart-grid          grid lines (default #1e222d)
 *   --acme-chart-grid-style    'solid' | 'dotted' | 'dashed' (default solid)
 *   --acme-chart-text          axis text (default #d1d4dc)
 *   --acme-chart-border        price and time axis borders (default #2a2e39)
 *   --acme-chart-crosshair     crosshair lines and labels (default: Lightweight Charts')
 *
 *   const off = followTheme(chart, el);     // apply now, and again on every notifyThemeChange()
 *   notifyThemeChange();                    // the host changed the properties
 */
import { ColorType, LineStyle, type DeepPartial, type ChartOptionsBase } from 'lightweight-charts';

const EVENT = 'acme-themechange';

function prop(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Layout, grid and scale options for a chart inside `el`, from its CSS custom properties. */
export function chartThemeOptions(el: Element): DeepPartial<ChartOptionsBase> {
  const bg = prop(el, '--acme-chart-bg') || '#131722';
  const bottom = prop(el, '--acme-chart-bg-bottom');
  const grid = prop(el, '--acme-chart-grid') || '#1e222d';
  const style = { dotted: LineStyle.Dotted, dashed: LineStyle.Dashed, solid: LineStyle.Solid }[prop(el, '--acme-chart-grid-style')] ?? LineStyle.Solid;
  const text = prop(el, '--acme-chart-text') || '#d1d4dc';
  const border = prop(el, '--acme-chart-border') || '#2a2e39';
  const cross = prop(el, '--acme-chart-crosshair');
  return {
    layout: {
      background: bottom ? { type: ColorType.VerticalGradient, topColor: bg, bottomColor: bottom } : { type: ColorType.Solid, color: bg },
      textColor: text,
      panes: { separatorColor: border, separatorHoverColor: 'rgba(120, 123, 134, 0.25)' },
    },
    grid: { vertLines: { color: grid, style }, horzLines: { color: grid, style } },
    rightPriceScale: { borderColor: border },
    leftPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
    ...(cross ? { crosshair: { vertLine: { color: cross, labelBackgroundColor: cross }, horzLine: { color: cross, labelBackgroundColor: cross } } } : {}),
  };
}

/** Theme `chart` now and whenever the host announces a change (notifyThemeChange); returns the unsubscribe. */
export function followTheme(chart: { applyOptions(options: never): void }, el: Element): () => void {
  const apply = () => {
    try {
      chart.applyOptions(chartThemeOptions(el) as never);
    } catch {
      /* the chart was removed */
    }
  };
  apply();
  window.addEventListener(EVENT, apply);
  return () => window.removeEventListener(EVENT, apply);
}

/** Tell every followed chart that the theme's custom properties changed. */
export function notifyThemeChange(): void {
  window.dispatchEvent(new Event(EVENT));
}
