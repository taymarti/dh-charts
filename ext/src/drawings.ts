/**
 * Drawing tools: horizontal ray and trend line (more kinds plug in the same way), as a plain
 * Lightweight Charts plugin with no Deephaven dependency, saved through an AnnotationStore
 * (kind "drawing", spec { type, points: [{ time, price }] }).
 *
 *   bindDrawings(chart, series, store, chartKey, host)   any LWC chart (front-end group C)
 *   drawingTools()                                       extension for Deephaven charts (groups A and B)
 *
 * Interaction, on the price pane:
 *   palette (left edge)  pick a tool; the next click(s) place it (ray: 1 click; trend: 2 clicks)
 *   click a drawing      select it (handles show); drag the line or a handle to move it
 *   Delete / Backspace   delete the selected drawing        Ctrl+click: share / unshare it
 *   Esc                  cancel the tool or the selection
 * Points snap to the bar's open/high/low/close within a few pixels (a "weak magnet").
 *
 * Coordinates: points are stored as (UTC seconds, price) and turned into pixels on every frame.
 * Times off the data (to the right of the last bar, or between scaffold slots) are placed on a linear
 * time axis fitted to the visible range, which holds for evenly spaced bars and for Deephaven's
 * 1-second scaffold; across gaps in the data (weekends) such points drift.
 */
import {
  MismatchDirection,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { newAnnotationId, onPageAnnotationStore, type Annotation, type AnnotationStore } from './annotations';
import { titleChartKey } from './persistent-price-lines';
import type { TvlChartContext, TvlExtension } from './hook';

export type DrawingType = 'hray' | 'trend';
export interface DrawingPoint {
  time: number; // UTC seconds
  price: number;
}
interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  owner: string;
  shared: boolean;
}

const KIND = 'drawing';
const POINTS: Record<DrawingType, number> = { hray: 1, trend: 2 };
const OWN = '#f7a600';
const SHARED_OWN = '#ffd54f';
const OTHERS = '#2962ff';
const HIT_PX = 6;
const MAGNET_PX = 8;
const HANDLE_R = 4;

// ----------------------------------------------------------------------------- coordinates

/** Time <-> x on the chart's time scale, exact on the data and linear off it. */
function axis(chart: IChartApi) {
  const ts = chart.timeScale();
  const fit = () => {
    const r = ts.getVisibleRange();
    if (!r) return null;
    const t0 = r.from as number;
    const t1 = r.to as number;
    const x0 = ts.timeToCoordinate(r.from);
    const x1 = ts.timeToCoordinate(r.to);
    if (x0 == null || x1 == null || t1 === t0) return null;
    return { t0, x0, k: (x1 - x0) / (t1 - t0) };
  };
  return {
    x(time: number): number | null {
      const x = ts.timeToCoordinate(time as UTCTimestamp);
      if (x != null) return x;
      const f = fit();
      return f ? f.x0 + (time - f.t0) * f.k : null;
    },
    time(x: number): number | null {
      const f = fit();
      return f ? f.t0 + (x - f.x0) / f.k : null;
    },
  };
}

// ----------------------------------------------------------------------------- rendering

class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  selected: string | null = null;
  preview: Drawing | null = null; // being placed
  owner = '';
  private chart?: IChartApi;
  private series?: ISeriesApi<SeriesType>;
  private request?: () => void;
  private readonly view: IPrimitivePaneView = { zOrder: () => 'top', renderer: () => this.renderer() };

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this.series = series;
    this.request = requestUpdate;
  }
  detached() {
    this.chart = this.series = this.request = undefined;
  }
  paneViews() {
    return [this.view];
  }
  update() {
    this.request?.();
  }

  /** Pixel geometry of a drawing: its points and, for hit testing, its segment(s). */
  geometry(d: Drawing, width: number) {
    if (!this.chart || !this.series) return null;
    const ax = axis(this.chart);
    const pts = d.points.map(p => ({ x: ax.x(p.time), y: this.series!.priceToCoordinate(p.price) }));
    if (pts.some(p => p.x == null || p.y == null)) return null;
    const P = pts as { x: number; y: number }[];
    const segs: [number, number, number, number][] =
      d.type === 'hray' ? [[P[0].x, P[0].y, width, P[0].y]] : P.length > 1 ? [[P[0].x, P[0].y, P[1].x, P[1].y]] : [];
    return { points: P, segs };
  }

  private renderer(): IPrimitivePaneRenderer {
    return {
      draw: target =>
        target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
          const all = this.preview ? [...this.drawings, this.preview] : this.drawings;
          for (const d of all) {
            const g = this.geometry(d, mediaSize.width);
            if (!g) continue;
            const mine = d.owner === this.owner;
            const color = mine ? (d.shared ? SHARED_OWN : OWN) : OTHERS;
            const sel = d.id === this.selected || d === this.preview;
            c.strokeStyle = color;
            c.lineWidth = sel ? 2 : 1.5;
            c.beginPath();
            for (const [x0, y0, x1, y1] of g.segs) {
              c.moveTo(x0, y0);
              c.lineTo(x1, y1);
            }
            c.stroke();
            if (!mine) {
              c.fillStyle = color;
              c.font = '11px -apple-system, "Trebuchet MS", Roboto, sans-serif';
              c.fillText(d.owner, g.points[0].x + 4, g.points[0].y - 4);
            }
            if (sel) {
              c.fillStyle = '#131722';
              for (const p of g.points) {
                c.beginPath();
                c.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
                c.fill();
                c.stroke();
              }
            }
          }
        }),
    };
  }
}

// ----------------------------------------------------------------------------- interaction

function distToSegment(px: number, py: number, [x0, y0, x1, y1]: [number, number, number, number]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function toDrawing(a: Annotation): Drawing | null {
  const s = a.spec as { type?: DrawingType; points?: DrawingPoint[] };
  if (!s.type || !(s.type in POINTS) || !Array.isArray(s.points) || s.points.length !== POINTS[s.type]) return null;
  return { id: a.id, type: s.type, points: s.points, owner: a.owner, shared: a.shared };
}

/**
 * Drawing tools on `series` (the price series) of `chart`, saved in `store` under `chartKey`.
 * `host` is where the tool palette goes (an element that contains the chart). Returns a cleanup function.
 */
export function bindDrawings(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  store: AnnotationStore,
  chartKey: string,
  host: HTMLElement,
): () => void {
  const prim = new DrawingsPrimitive();
  prim.owner = store.owner;
  series.attachPrimitive(prim);
  // the price pane's element (pointer coordinates are pane-relative); the chart's own element if the
  // pane has not been laid out yet
  const pane: HTMLElement = chart.panes()[0].getHTMLElement() ?? chart.chartElement();
  const ax = axis(chart);
  let tool: DrawingType | null = null;
  let drag: { id: string; handle: number | null; start: { x: number; y: number }; orig: DrawingPoint[] } | null = null;

  const sync = () => {
    prim.drawings = store.list(chartKey).filter(a => a.kind === KIND).map(toDrawing).filter((d): d is Drawing => d != null);
    if (prim.selected && !prim.drawings.some(d => d.id === prim.selected)) prim.selected = null;
    prim.update();
  };
  const unsubscribe = store.subscribe(sync);
  sync();

  const save = (d: Drawing) =>
    void store.put({ chartKey, id: d.id, kind: KIND, spec: { type: d.type, points: d.points }, shared: d.shared });

  // pointer position in the pane, the point it means (with the magnet), and what is under it
  const local = (ev: MouseEvent) => {
    const r = pane.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, width: r.width };
  };
  const pointAt = (x: number, y: number): DrawingPoint | null => {
    const time = ax.time(x);
    const price = series.coordinateToPrice(y);
    if (time == null || price == null) return null;
    // weak magnet: the bar's open/high/low/close, if one is within a few pixels
    const logical = chart.timeScale().coordinateToLogical(x);
    const bar = logical == null ? null : (series.dataByIndex(Math.round(logical), MismatchDirection.NearestLeft) as Record<string, unknown> | null);
    let best = price as number;
    let bestPx = MAGNET_PX;
    for (const k of ['open', 'high', 'low', 'close', 'value']) {
      const v = bar?.[k];
      if (typeof v !== 'number') continue;
      const py = series.priceToCoordinate(v);
      if (py != null && Math.abs(py - y) < bestPx) {
        bestPx = Math.abs(py - y);
        best = v;
      }
    }
    return { time: Math.round(time), price: best };
  };
  // what is under the pointer: a handle of the selected drawing wins over any line (a handle sits on
  // its own line, so otherwise grabbing it would move the whole drawing), then the nearest line
  const hit = (x: number, y: number, width: number) => {
    const sel = prim.drawings.find(d => d.id === prim.selected);
    const gs = sel && prim.geometry(sel, width);
    if (sel && gs) {
      for (let i = 0; i < gs.points.length; i++) {
        if (Math.hypot(gs.points[i].x - x, gs.points[i].y - y) <= HIT_PX + 2) return { d: sel, handle: i };
      }
    }
    let found: { d: Drawing; handle: number | null; dist: number } | null = null;
    for (const d of prim.drawings) {
      const g = prim.geometry(d, width);
      if (!g) continue;
      for (const s of g.segs) {
        const dist = distToSegment(x, y, s);
        if (dist <= HIT_PX && (!found || dist < found.dist)) found = { d, handle: null, dist };
      }
    }
    return found;
  };
  const freeze = (on: boolean) => chart.applyOptions({ handleScroll: !on, handleScale: !on });
  const stop = (ev: Event) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  const onDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    const { x, y, width } = local(ev);
    if (tool) {
      const p = pointAt(x, y);
      if (!p) return;
      stop(ev);
      if (!prim.preview) {
        prim.preview = { id: newAnnotationId(), type: tool, points: [p], owner: store.owner, shared: false };
      } else {
        prim.preview.points = [prim.preview.points[0], p];
      }
      if (prim.preview.points.length === POINTS[tool]) {
        const d = prim.preview;
        prim.preview = null;
        prim.selected = d.id;
        setTool(null);
        prim.drawings = [...prim.drawings, d];
        save(d);
      }
      prim.update();
      return;
    }
    const h = hit(x, y, width);
    if (!h) {
      if (prim.selected) {
        prim.selected = null;
        prim.update();
      }
      return;
    }
    stop(ev);
    const mine = h.d.owner === store.owner;
    if (mine && (ev.ctrlKey || ev.metaKey)) {
      save({ ...h.d, shared: !h.d.shared });
      return;
    }
    prim.selected = h.d.id;
    if (mine) {
      drag = { id: h.d.id, handle: h.handle, start: { x, y }, orig: h.d.points.map(p => ({ ...p })) };
      freeze(true);
    }
    prim.update();
  };

  const onMove = (ev: MouseEvent) => {
    const { x, y, width } = local(ev);
    // a trend line being placed follows the pointer to its second point
    if (prim.preview && tool) {
      const p = pointAt(x, y);
      if (p) {
        prim.preview.points = [prim.preview.points[0], p];
        prim.update();
      }
    }
    if (drag) {
      const d = prim.drawings.find(z => z.id === drag!.id);
      if (!d) return;
      if (drag.handle != null) {
        const p = pointAt(x, y);
        if (p) d.points = d.points.map((q, i) => (i === drag!.handle ? p : q));
      } else {
        // move the whole drawing by the pointer's offset in time and price
        const t0 = ax.time(drag.start.x);
        const t1 = ax.time(x);
        const p0 = series.coordinateToPrice(drag.start.y);
        const p1 = series.coordinateToPrice(y);
        if (t0 != null && t1 != null && p0 != null && p1 != null) {
          d.points = drag.orig.map(q => ({ time: Math.round(q.time + (t1 - t0)), price: q.price + ((p1 as number) - (p0 as number)) }));
        }
      }
      prim.update();
      return;
    }
    pane.style.cursor = tool ? 'crosshair' : hit(x, y, width) ? 'pointer' : '';
  };

  const onUp = () => {
    if (!drag) return;
    const d = prim.drawings.find(z => z.id === drag!.id);
    drag = null;
    freeze(false);
    if (d) save(d);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      prim.preview = null;
      prim.selected = null;
      setTool(null);
      prim.update();
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && prim.selected) {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const d = prim.drawings.find(z => z.id === prim.selected);
      if (d && d.owner === store.owner) {
        prim.drawings = prim.drawings.filter(z => z !== d);
        prim.selected = null;
        prim.update();
        void store.remove(chartKey, d.id);
      }
    }
  };

  // the palette
  const palette = document.createElement('div');
  palette.className = 'acme-draw-palette';
  Object.assign(palette.style, {
    position: 'absolute', left: '6px', top: '30px', zIndex: '5', display: 'flex', flexDirection: 'column', gap: '2px',
    background: 'rgba(19, 23, 34, 0.85)', border: '1px solid #2a2e39', borderRadius: '4px', padding: '2px',
  });
  const buttons = new Map<DrawingType, HTMLButtonElement>();
  const icons: Record<DrawingType, [string, string]> = { hray: ['—', 'Horizontal ray'], trend: ['╱', 'Trend line'] };
  for (const t of Object.keys(POINTS) as DrawingType[]) {
    const b = document.createElement('button');
    b.textContent = icons[t][0];
    b.title = icons[t][1];
    Object.assign(b.style, {
      width: '26px', height: '26px', border: 'none', borderRadius: '3px', cursor: 'pointer',
      color: '#d1d4dc', background: 'transparent', font: '13px sans-serif', padding: '0',
    });
    b.addEventListener('mousedown', ev => ev.stopPropagation());
    b.addEventListener('click', () => setTool(tool === t ? null : t));
    buttons.set(t, b);
    palette.appendChild(b);
  }
  function setTool(t: DrawingType | null) {
    tool = t;
    prim.preview = null;
    buttons.forEach((b, k) => (b.style.background = k === t ? '#2962ff' : 'transparent'));
    pane.style.cursor = t ? 'crosshair' : '';
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(palette);

  pane.addEventListener('mousedown', onDown, true);
  pane.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('keydown', onKey);

  return () => {
    unsubscribe();
    pane.removeEventListener('mousedown', onDown, true);
    pane.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey);
    palette.remove();
    pane.style.cursor = '';
    if (drag) freeze(false);
    series.detachPrimitive(prim);
  };
}

/**
 * Extension: drawing tools on every Deephaven chart, saved in `store`, or the page's store once it
 * arrives. Charts with no chart key (no price series title), or before a store exists, get no tools:
 * drawings that could not be saved would vanish on the next rebuild.
 */
export function drawingTools(store?: AnnotationStore, keyOf: (ctx: TvlChartContext) => string | undefined = titleChartKey): TvlExtension {
  return ctx => {
    const key = keyOf(ctx);
    if (!key) return;
    let unbind = () => {};
    const bind = (s: AnnotationStore | undefined) => {
      unbind();
      unbind = s ? bindDrawings(ctx.chart, ctx.series[0], s, key, ctx.element) : () => {};
    };
    if (store) {
      bind(store);
      return () => unbind();
    }
    const unsubscribe = onPageAnnotationStore(bind);
    return () => {
      unsubscribe();
      unbind();
    };
  };
}
