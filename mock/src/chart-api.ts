/**
 * chart_api on the mock server: the methods dh_chart_ext.api.ChartApi, dh_chart_ext.workspaces and
 * dh_chart_ext.introspection have, over the app's BarMarket and the shared chart nodes. An app adds its own
 * methods to the Api this returns, exactly as a Python app adds them to its ChartApi.
 *
 *   chart, bars        one instrument's bars (+ the studies' columns) as a shared node, held by the stream
 *   symbols, resolutions, studies, stats
 *   workspaces, workspace_load, workspace_save, workspace_delete      per user, in this browser
 *   graph              the engine's update graph, with the clients' filtered and sorted handles
 */
import { STUDY_TYPES, studiesFor } from '@acme/chart-ext';
import type { Engine } from './engine';
import type { MockServer, MockTable } from './dh';
import type { BarMarket } from './market';
import { RESOLUTIONS, resolutionName, type NodeCache } from './nodes';
import { Api, ApiError, Reply, p } from './rpc';
import { UserDocs } from './stores';

export interface MockChartApiOptions {
  /** the published name (default chart_api) */
  name?: string;
  /** what a chart reply says about its instrument (name, tick, unit, ...), as dh_chart_ext's meta function */
  meta?: (sym: string) => Record<string, unknown>;
  /** a symbol the market doesn't have yet: make it (a typed spread, say) and return its name, or null */
  resolve?: (sym: string) => string | null;
}

export function mockChartApi(engine: Engine, server: MockServer, market: BarMarket, nodes: NodeCache, opts: MockChartApiOptions = {}) {
  const api = new Api(opts.name ?? 'chart_api');
  const meta = opts.meta ?? ((sym: string) => ({ tick: market.instrument(sym)?.tick ?? null }));

  const resolve = (sym: string): string => {
    const s = sym.trim();
    if (market.has(s)) return s;
    if (market.has(s.toUpperCase())) return s.toUpperCase();
    let made: string | null = null;
    try {
      made = opts.resolve?.(s) ?? null;
    } catch (e) {
      throw new ApiError((e as Error).message, 'bad_params');
    }
    if (made) return made;
    throw new ApiError(`unknown symbol ${sym}`, 'not_found');
  };

  // ---------------------------------------------------------------- charts (as dh_chart_ext.api)
  api.method(
    'chart',
    "One instrument's bars with the studies' columns, as a shared node. sym may be an expression the app resolves (a spread, a ratio).",
    [p('sym', 'string'), p('res', 'string'), p('studies', 'array', [])],
    (ctx, a) => {
      const sym = resolve(a.sym);
      let h: ReturnType<NodeCache['acquire']>;
      try {
        h = nodes.acquire(sym, a.res, a.studies);
      } catch (e) {
        throw new ApiError((e as Error).message, 'bad_params');
      }
      if (!ctx.hold(h.keyText, h.release)) throw new ApiError('this stream holds too many charts', 'limit');
      const columns = h.node.studies.flatMap(st =>
        st.columns.map(c => ({ column: c, pane: st.pane, study: st.key, ...(st.levels ? { levels: st.levels } : {}), ...(st.histogram.has(c) ? { histogram: true } : {}) })),
      );
      return new Reply({ key: h.key, sym, res: resolutionName(h.node.res), columns, ...meta(sym) }, [h.node]);
    },
    { tables: true },
  );
  api.method(
    'bars',
    "One instrument's bars, as a shared node.",
    [p('sym', 'string'), p('res', 'string')],
    (ctx, a) => {
      const sym = resolve(a.sym);
      const h = nodes.acquire(sym, a.res, []);
      if (!ctx.hold(h.keyText, h.release)) throw new ApiError('this stream holds too many charts', 'limit');
      return new Reply({ key: h.key, sym, res: resolutionName(h.node.res), tick: market.instrument(sym)!.tick }, [h.node]);
    },
    { tables: true },
  );
  api.method('symbols', 'Every chartable symbol.', [], () => market.inst.map(i => i.sym));
  api.method('resolutions', 'Resolutions a toolbar can offer (any other from 1s to 1W also works).', [], () => RESOLUTIONS);
  api.method('studies', 'The study types, their parameters and panes (for sym: only the ones that apply to it).', [p('sym', 'string', '')], (_c, a) => {
    const allowed = a.sym && market.has(a.sym) ? new Set(studiesFor(market.instrument(a.sym)!.hasVolume)) : null;
    return Object.entries(STUDY_TYPES)
      .filter(([k]) => !allowed || allowed.has(k))
      .map(([k, t]) => ({ type: k, label: t.label, group: t.group, params: t.params, pane: t.pane, levels: t.levels ?? null, needs_volume: !!t.needsVolume, description: t.description }));
  });
  api.method('stats', "Streams, this stream's holds, and every cached node.", [], ctx => ({ streams: api.streams, held: ctx.holding(), nodes: nodes.stats() }));

  // ---------------------------------------------------------------- workspaces (as dh_chart_ext.workspaces)
  const ws = new UserDocs<unknown>('workspaces');
  api.method('workspaces', "This user's saved workspaces, newest first.", [], ctx => ws.list(ctx.user));
  api.method('workspace_load', 'A saved workspace layout.', [p('name', 'string')], (ctx, a) => {
    const hit = ws.get(ctx.user, a.name);
    if (!hit) throw new ApiError(`no workspace ${a.name}`, 'not_found');
    return { name: a.name, layout: hit.value, saved_at: hit.saved_at };
  });
  api.method('workspace_save', 'Save a workspace layout.', [p('name', 'string'), p('layout', 'object')], (ctx, a) => ({ name: a.name, saved_at: ws.put(ctx.user, a.name, a.layout) }));
  api.method('workspace_delete', 'Delete a saved workspace.', [p('name', 'string')], (ctx, a) => ({ deleted: ws.remove(ctx.user, a.name) }));

  // ---------------------------------------------------------------- the update graph (as dh_chart_ext.introspection)
  api.method('graph', "The server's update graph: every table, its parents, its cost per cycle.", [p('all', 'boolean', false)], (_c, a) => {
    const t0 = performance.now();
    const sources = [...engine.sources].filter(s => !s.closed);
    const ids = new Set(sources.map(s => s.id));
    const nodesOut: Array<Record<string, unknown>> = sources
      .filter(s => a.all || s.variables.length || s.kind !== 'op' || s.parents.length || s.listened)
      .map(s => ({
        id: s.id, kind: s.kind, label: s.label, description: s.description, variables: s.variables, parents: s.parents.filter(x => ids.has(x.id)).map(x => x.id),
        ms_per_interval: +s.cost.ms.toFixed(3), rows_changed_per_interval: +s.cost.rows.toFixed(1), active: Date.now() - s.cost.last < 5000, update_graph: 'DEFAULT',
      }));
    // the clients' own handles with filters or sorts: a where/sort op each
    let hid = 1_000_000;
    for (const h of server.handles as Set<MockTable>) {
      const f = h.filter.length;
      const so = h.sort.length;
      if (!f && !so) continue;
      if (!ids.has(h.source.id)) continue;
      nodesOut.push({
        id: hid++, kind: 'op', label: [f ? `where (${f})` : '', so ? `sort (${h.sort.map(s => s.column.name).join(', ')})` : ''].filter(Boolean).join(' + '),
        description: `a client's handle on ${h.source.variables[0] ?? h.source.label}: ${h.size} rows`, variables: [], parents: [h.source.id],
        ms_per_interval: 0, rows_changed_per_interval: 0, active: true, update_graph: 'DEFAULT',
      });
    }
    const edges: Array<[number, number]> = [];
    for (const n of nodesOut) for (const pId of n.parents as number[]) edges.push([pId, n.id as number]);
    const kept = new Set(nodesOut.map(n => n.id));
    return {
      nodes: nodesOut.map(n => ({ ...n, parents: (n.parents as number[]).filter(x => kept.has(x)) })),
      edges: edges.filter(([x, y]) => kept.has(x) && kept.has(y)),
      ancestry_complete: true,
      update_graphs: ['DEFAULT'],
      exports: [...server.objects.values()].map(o => ({ name: o.name, kind: o.type })),
      took_ms: +(performance.now() - t0).toFixed(2),
      cached: false,
      cycle_ms: +engine.cycleMs.toFixed(2),
    };
  });

  return api;
}
