/**
 * The app's update graph: sources on the left, each operation one column right of its deepest input, named
 * variables in bold. Colour by kind, the recent cost per update cycle on each node; inactive nodes are dimmed.
 * A click on a named table opens it in a table panel next to this one.
 *
 * Data: a request API's `graph` method (dh_chart_ext.introspection, over deephaven-compare's introspect).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { definePanel, type PanelProps } from '../registry';
import { message, useApiClient } from '../deephaven';

export interface GraphNode {
  id: number;
  kind: 'source' | 'op' | 'callback' | 'sink' | 'internal' | string;
  label: string;
  description: string;
  variables: string[];
  parents: number[];
  ms_per_interval?: number | null;
  rows_changed_per_interval?: number | null;
  active?: boolean;
  update_graph?: string | null;
}

export interface GraphReply {
  nodes: GraphNode[];
  edges: [number, number][];
  ancestry_complete: boolean;
  update_graphs: string[];
  exports: { name: string; kind: string | null }[];
  took_ms: number;
  cached: boolean;
}

const KIND_COLORS: Record<string, string> = {
  source: '#26a69a',
  op: '#2962ff',
  callback: '#ff9800',
  sink: '#ab47bc',
  internal: '#5d606b',
};
const W = 180;
const H = 38;
const COL = W + 70;
const ROW = H + 12;
const PAD = 16;

export interface Placed {
  node: GraphNode;
  x: number;
  y: number;
}

/** Columns by longest path from a source; within a column, ordered by the parents' rows (one barycentre pass). */
export function layoutGraph(nodes: GraphNode[]): { placed: Map<number, Placed>; width: number; height: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const depth = new Map<number, number>();
  const visiting = new Set<number>();
  const depthOf = (id: number): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle (shouldn't happen in an update graph): cut it
    visiting.add(id);
    const ps = (byId.get(id)?.parents ?? []).filter(p => byId.has(p));
    const d = ps.length ? 1 + Math.max(...ps.map(depthOf)) : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  nodes.forEach(n => depthOf(n.id));
  const columns: GraphNode[][] = [];
  for (const n of nodes) (columns[depth.get(n.id)!] ??= []).push(n);
  const row = new Map<number, number>();
  columns.forEach((col, c) => {
    if (c > 0) {
      const key = (n: GraphNode) => {
        const rs = n.parents.map(p => row.get(p)).filter((r): r is number => r !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => key(a) - key(b) || a.id - b.id);
    } else col.sort((a, b) => Number(b.variables.length > 0) - Number(a.variables.length > 0) || a.id - b.id);
    col.forEach((n, i) => row.set(n.id, i));
  });
  const placed = new Map<number, Placed>();
  columns.forEach((col, c) => col.forEach((n, i) => placed.set(n.id, { node: n, x: PAD + c * COL, y: PAD + i * ROW })));
  const tallest = Math.max(0, ...columns.map(c => c.length));
  return { placed, width: PAD * 2 + Math.max(1, columns.length) * COL - (COL - W), height: PAD * 2 + tallest * ROW };
}

export function graphPanel(o: { api?: string; user?: string } = {}) {
  const apiName = o.api ?? 'chart_api';
  return definePanel<{ all: boolean }>({
    kind: 'graph',
    label: 'Update graph',
    title: 'Update graph',
    description: "The app's update graph: nodes, edges, cost per cycle",
    defaultParams: { all: false },
    linkable: false,
    component: function GraphPanel({ params, setParams, openPanel }: PanelProps<{ all: boolean }>) {
      const { value: client, error } = useApiClient(apiName, o.user ? `user:${o.user}` : undefined);
      const [reply, setReply] = useState<GraphReply | null>(null);
      const [problem, setProblem] = useState<string | null>(null);
      const [busy, setBusy] = useState(false);
      const [hover, setHover] = useState<number | null>(null);
      const load = useCallback(() => {
        if (!client) return;
        setBusy(true);
        client.request<GraphReply>('graph', { all: params.all }).then(
          r => {
            setReply(r.result);
            setProblem(null);
            setBusy(false);
          },
          e => {
            setProblem((e as { code?: string }).code === 'unknown_method' ? `${apiName} has no graph method (introspect not loaded on the server)` : message(e));
            setBusy(false);
          },
        );
      }, [client, params.all]);
      useEffect(load, [load]);
      const layout = useMemo(() => layoutGraph(reply?.nodes ?? []), [reply]);
      const near = useMemo(() => {
        if (hover == null || !reply) return null;
        const s = new Set<number>([hover]);
        for (const [p, c] of reply.edges) if (p === hover || c === hover) s.add(p === hover ? c : p);
        return s;
      }, [hover, reply]);
      if (error) return <div className="acme-error">{apiName}: {error}</div>;
      const maxMs = Math.max(0.001, ...(reply?.nodes ?? []).map(n => n.ms_per_interval ?? 0));
      return (
        <div className="acme-graph">
          <div className="acme-graph-bar">
            <button onClick={load} disabled={busy}>
              {busy ? 'Loading…' : 'Refresh'}
            </button>
            <label>
              <input type="checkbox" checked={params.all} onChange={e => setParams({ all: e.target.checked })} /> engine internals and
              unnamed branches
            </label>
            {reply && (
              <span>
                {reply.nodes.length} nodes, {reply.edges.length} edges · {reply.cached ? 'cached' : `${reply.took_ms} ms`}
                {!reply.ancestry_complete && <b className="acme-graph-warn"> · ancestry incomplete (open the ancestors log at start)</b>}
              </span>
            )}
            {Object.entries(KIND_COLORS).map(([k, c]) => (
              <span key={k} className="acme-graph-key">
                <i style={{ background: c }} />
                {k}
              </span>
            ))}
          </div>
          {problem && <div className="acme-error">{problem}</div>}
          <div className="acme-graph-canvas">
            <svg width={layout.width} height={layout.height}>
              {reply?.edges.map(([p, c]) => {
                const a = layout.placed.get(p);
                const b = layout.placed.get(c);
                if (!a || !b) return null;
                const x1 = a.x + W;
                const y1 = a.y + H / 2;
                const x2 = b.x;
                const y2 = b.y + H / 2;
                const mx = (x1 + x2) / 2;
                const lit = near?.has(p) && near?.has(c) && (p === hover || c === hover);
                return (
                  <path
                    key={`${p}-${c}`}
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={lit ? '#d1d4dc' : '#3a3e4a'}
                    strokeWidth={lit ? 1.6 : 1}
                  />
                );
              })}
              {[...layout.placed.values()].map(({ node: n, x, y }) => {
                const named = n.variables.length > 0;
                const ms = n.ms_per_interval ?? 0;
                const heat = Math.min(1, ms / maxMs);
                const dim = n.active === false || (near != null && !near.has(n.id));
                return (
                  <g
                    key={n.id}
                    transform={`translate(${x},${y})`}
                    opacity={dim ? 0.35 : 1}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(h => (h === n.id ? null : h))}
                    onClick={named ? () => openPanel('table', { table: n.variables[0] }, n.variables[0]) : undefined}
                    style={{ cursor: named ? 'pointer' : 'default' }}
                  >
                    <title>{`${n.description}\n${n.kind}${n.update_graph ? ` · ${n.update_graph}` : ''}\n${ms} ms per cycle · ${n.rows_changed_per_interval ?? 0} rows changed${named ? `\nclick: open ${n.variables.join(', ')}` : ''}`}</title>
                    <rect width={W} height={H} rx={4} fill="#1e222d" stroke={KIND_COLORS[n.kind] ?? '#5d606b'} strokeWidth={named ? 2 : 1} />
                    <rect x={0} y={H - 3} width={Math.max(2, W * heat)} height={3} rx={1} fill={heat > 0.5 ? '#ef5350' : '#f7a600'} opacity={ms > 0 ? 1 : 0} />
                    <text x={8} y={15} fill="#d1d4dc" fontSize={12} fontWeight={named ? 700 : 400}>
                      {clip(named ? n.variables.join(', ') : n.label, 24)}
                    </text>
                    <text x={8} y={29} fill="#787b86" fontSize={10}>
                      {clip(named ? n.label : n.kind, 20)}
                      {ms > 0 ? ` · ${ms < 1 ? ms.toFixed(2) : ms.toFixed(1)} ms` : ''}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      );
    },
  });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
