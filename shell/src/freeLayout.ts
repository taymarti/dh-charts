/**
 * Free layout: every group is a floating window over an empty desktop, so a window can be moved anywhere and
 * resized from any edge without its neighbours filling the space (dockview's grid is a splitview: sizes in a row
 * always add up to the row, so shrinking one pane grows the next). Edges snap to the desktop's edges and to the
 * other windows' edges while moving and after resizing, so windows tile flush; "fill" grows a window into the blank
 * space around it.
 *
 * dockview's own snapping (Smart Guides) is a paid module; this uses the free transformFloatingGroupDrag hook for
 * moves and each window's overlay (dockview internals, 8.9) for resizes.
 */
import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';

export const SNAP = 10;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlayLike {
  element: HTMLElement;
  setBounds(b: Partial<Box>): void;
  onDidChangeEnd(cb: () => void): { dispose(): void };
}
interface FloatingWindow {
  group: IDockviewGroupPanel;
  overlay: OverlayLike;
}
interface ComponentLike {
  floatingGroups: readonly FloatingWindow[];
  getFloatingWindowForGroup?(g: IDockviewGroupPanel): FloatingWindow | undefined;
}

const component = (api: DockviewApi) => (api as unknown as { component: ComponentLike }).component;

function windows(api: DockviewApi): FloatingWindow[] {
  return [...(component(api).floatingGroups ?? [])];
}

function windowOf(api: DockviewApi, group: IDockviewGroupPanel): FloatingWindow | undefined {
  const c = component(api);
  return c.getFloatingWindowForGroup?.(group) ?? c.floatingGroups.find(f => f.group === group);
}

/** a window's box, in its container's pixels */
function boxOf(w: FloatingWindow): Box {
  const r = w.overlay.element.getBoundingClientRect();
  const c = (w.overlay.element.parentElement ?? w.overlay.element).getBoundingClientRect();
  return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height };
}

function containerOf(w: FloatingWindow): { width: number; height: number } {
  const c = (w.overlay.element.parentElement ?? w.overlay.element).getBoundingClientRect();
  return { width: c.width, height: c.height };
}

/** set a window's outer box (its element is content-box: the border is outside the width setBounds sets) */
function setBox(w: FloatingWindow, b: Box) {
  const el = w.overlay.element;
  const bx = el.offsetWidth - (parseFloat(el.style.width) || el.offsetWidth);
  const by = el.offsetHeight - (parseFloat(el.style.height) || el.offsetHeight);
  w.overlay.setBounds({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width - bx), height: Math.round(b.height - by) });
}

/** the candidate within SNAP of v closest to it, else v */
function nearest(v: number, candidates: number[]): number {
  let best = v;
  let d = SNAP + 1;
  for (const c of candidates) {
    const dc = Math.abs(c - v);
    if (dc < d) {
      d = dc;
      best = c;
    }
  }
  return best;
}

const xEdges = (others: readonly Box[], width: number) => [0, width, ...others.flatMap(o => [o.left, o.left + o.width])];
const yEdges = (others: readonly Box[], height: number) => [0, height, ...others.flatMap(o => [o.top, o.top + o.height])];

/** dockview's transformFloatingGroupDrag: snap a moving window's edges to the desktop's and the others' */
export function snapDrag(ctx: { proposed: Box; container: { width: number; height: number }; others: readonly Box[] }) {
  const { proposed: p, container, others } = ctx;
  const xs = xEdges(others, container.width);
  const ys = yEdges(others, container.height);
  const l = nearest(p.left, xs);
  const r = nearest(p.left + p.width, xs);
  const t = nearest(p.top, ys);
  const b = nearest(p.top + p.height, ys);
  // whichever edge snapped (the nearer, if both)
  const left = l !== p.left && (r === p.left + p.width || Math.abs(l - p.left) <= Math.abs(r - p.left - p.width)) ? l : r !== p.left + p.width ? r - p.width : p.left;
  const top = t !== p.top && (b === p.top + p.height || Math.abs(t - p.top) <= Math.abs(b - p.top - p.height)) ? t : b !== p.top + p.height ? b - p.height : p.top;
  return { left, top };
}

/** after a resize (or a move) ends: pull each edge onto a nearby edge */
function snapEdges(api: DockviewApi, w: FloatingWindow) {
  const b = boxOf(w);
  const c = containerOf(w);
  const others = windows(api).filter(o => o !== w).map(boxOf);
  const xs = xEdges(others, c.width);
  const ys = yEdges(others, c.height);
  const left = nearest(b.left, xs);
  const right = nearest(b.left + b.width, xs);
  const top = nearest(b.top, ys);
  const bottom = nearest(b.top + b.height, ys);
  const next = { left, top, width: right - left, height: bottom - top };
  if (Math.abs(next.left - b.left) + Math.abs(next.top - b.top) + Math.abs(next.width - b.width) + Math.abs(next.height - b.height) > 0.5) setBox(w, next);
}

const watched = new WeakSet<object>();
const hosts = new WeakSet<object>();
/** a resize in progress: the window's box when its handle was pressed, and which edges the handle moves */
const pressed = new WeakMap<HTMLElement, { box: Box; dir: string }>();

/**
 * dockview (8.9) works out a resize from the pointer's position at the first move, not at the press, so the edges
 * that shouldn't move (the left one, dragging the right) shift by however far the pointer went before that first
 * move. Record the box at the press and put those edges back when the resize ends.
 */
function keepFixedEdges(w: FloatingWindow) {
  const p = pressed.get(w.overlay.element);
  if (!p) return;
  pressed.delete(w.overlay.element);
  const b = boxOf(w);
  const o = p.box;
  let { left, top } = b;
  let right = b.left + b.width;
  let bottom = b.top + b.height;
  if (!p.dir.includes('left')) left = o.left;
  if (!p.dir.includes('right')) right = p.dir.includes('left') ? o.left + o.width : right;
  if (!p.dir.includes('top')) top = o.top;
  if (!p.dir.includes('bottom')) bottom = p.dir.includes('top') ? o.top + o.height : bottom;
  if (p.dir === 'left' || p.dir === 'right') (top = o.top), (bottom = o.top + o.height);
  if (p.dir === 'top' || p.dir === 'bottom') (left = o.left), (right = o.left + o.width);
  setBox(w, { left, top, width: right - left, height: bottom - top });
}

/** snap every window's edges when its move or resize ends (call on each layout change: it skips windows it knows) */
export function watchWindows(api: DockviewApi, enabled: () => boolean) {
  for (const w of windows(api)) {
    const host = w.overlay.element.parentElement;
    if (host && !hosts.has(host)) {
      hosts.add(host);
      host.addEventListener(
        'pointerdown',
        e => {
          const t = e.target as HTMLElement;
          const m = /dv-resize-handle-(\w+)/.exec(t.className ?? '');
          const el = t.closest<HTMLElement>('.dv-resize-container');
          const win = m && el ? windows(api).find(x => x.overlay.element === el) : undefined;
          if (m && el && win) pressed.set(el, { box: boxOf(win), dir: m[1] });
        },
        true,
      );
    }
    if (watched.has(w.overlay)) continue;
    watched.add(w.overlay);
    w.overlay.onDidChangeEnd(() => {
      keepFixedEdges(w);
      if (enabled()) snapEdges(api, w);
    });
  }
}

/** Grow a window into the blank space around it: to the nearest window or desktop edge on each side. */
export function fill(api: DockviewApi, group: IDockviewGroupPanel) {
  const w = windowOf(api, group);
  if (!w) return;
  const b = boxOf(w);
  const c = containerOf(w);
  const others = windows(api).filter(o => o !== w).map(boxOf);
  const overlapsY = (o: Box, top: number, bottom: number) => o.top < bottom - 1 && o.top + o.height > top + 1;
  const overlapsX = (o: Box, left: number, right: number) => o.left < right - 1 && o.left + o.width > left + 1;
  const ys = others.filter(o => overlapsY(o, b.top, b.top + b.height));
  const left = Math.max(0, ...ys.filter(o => o.left + o.width <= b.left + 1).map(o => o.left + o.width));
  const right = Math.min(c.width, ...ys.filter(o => o.left >= b.left + b.width - 1).map(o => o.left));
  const xs = others.filter(o => overlapsX(o, left, right));
  const top = Math.max(0, ...xs.filter(o => o.top + o.height <= b.top + 1).map(o => o.top + o.height));
  const bottom = Math.min(c.height, ...xs.filter(o => o.top >= b.top + b.height - 1).map(o => o.top));
  setBox(w, { left, top, width: right - left, height: bottom - top });
}

/** Tiled to free: every docked group becomes a window where it is now. */
export function toFree(api: DockviewApi, host: HTMLElement) {
  const h = host.getBoundingClientRect();
  const docked = api.groups
    .filter(g => g.api.location.type === 'grid' && g.panels.length > 0)
    .map(g => {
      const r = g.element.getBoundingClientRect();
      return { g, box: { left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height } };
    });
  for (const { g, box } of docked) api.addFloatingGroup(g, { x: box.left, y: box.top, width: box.width, height: box.height });
  // the floats' boxes as they were (the grid reflowed under them as groups left it), in the floating windows' own
  // container, which is a little smaller than the dock: clipped to it, so no window hangs off the desktop
  const first = docked.length ? windowOf(api, docked[0].g) : undefined;
  const hostEl = first?.overlay.element.parentElement;
  const hr = hostEl?.getBoundingClientRect();
  const dx = hr ? hr.left - h.left : 0;
  const dy = hr ? hr.top - h.top : 0;
  const W = hr?.width ?? h.width;
  const H = hr?.height ?? h.height;
  for (const { g, box } of docked) {
    const left = Math.max(0, Math.round(box.left - dx));
    const top = Math.max(0, Math.round(box.top - dy));
    const right = Math.min(W, Math.round(box.left - dx + box.width));
    const bottom = Math.min(H, Math.round(box.top - dy + box.height));
    const w = windowOf(api, g);
    if (w) setBox(w, { left, top, width: right - left, height: bottom - top });
  }
  for (const g of [...api.groups]) if (g.api.location.type === 'grid' && g.panels.length === 0 && api.groups.filter(x => x.api.location.type === 'grid').length > 1) api.removeGroup(g);
}

/** Free to tiled: the windows go back into the grid, left to right. */
export function toTiled(api: DockviewApi) {
  const ws = windows(api).sort((a, b) => boxOf(a).left - boxOf(b).left || boxOf(a).top - boxOf(b).top);
  for (const w of ws) w.group.api.moveTo({ position: 'right' });
  for (const g of [...api.groups]) if (g.api.location.type === 'grid' && g.panels.length === 0) api.removeGroup(g);
}
