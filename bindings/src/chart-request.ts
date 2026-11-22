/**
 * Charts from the server's chart API: one request returns a shared node (one instrument's bars with
 * the studies' columns) and how to draw it, ready for bindFeed.
 *
 *   const c = await requestChart(api, { sym: 'NQ', res: '2m', studies: ['EMA_20', 'RSI_14'] });
 *   bindFeed(chart, c.feed, { price: { title: 'NQ', tick: c.tick }, studies: c.studies });
 *   ...
 *   c.release();      // closes the table; the server drops this stream's hold on the node
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import type { SeriesFeed, StudyLayout } from '@acme/chart-ext';
import type { ApiClient } from './api-client';
import { tableFeed } from './table-feed';

export type StudySpec = string | { type: string; params?: Record<string, number> };

/** One study column and where the server says it belongs. */
export interface ChartColumn {
  column: string;
  /** "overlay", or the name of its own pane ("rsi", "volume") */
  pane: string;
  /** the study it belongs to ("EMA_20", "BB_20_2") */
  study: string;
  /** fixed reference levels (RSI 30, 70) */
  levels?: number[];
}

export interface ChartReply {
  key: unknown[];
  sym: string;
  res: string;
  columns: ChartColumn[];
  /** the instrument's tick size, when known */
  tick: number | null;
}

export interface ChartHandle extends ChartReply {
  table: Dh.Table;
  /** a feed of Open, High, Low, Close, Volume and the study columns */
  feed: SeriesFeed;
  /** study layouts for bindFeed (colors left to the caller) */
  studies: StudyLayout[];
  release(): void;
}

export async function requestChart(
  dh: typeof Dh,
  api: ApiClient,
  req: { sym: string; res: string; studies?: StudySpec[]; volume?: boolean },
): Promise<ChartHandle> {
  const { result, tables } = await api.requestTables<ChartReply>('chart', { sym: req.sym, res: req.res, studies: req.studies ?? [] });
  const table = tables[0];
  const cols = ['Open', 'High', 'Low', 'Close', 'Volume', ...result.columns.map(c => c.column)];
  let released = false;
  return {
    ...result,
    table,
    feed: tableFeed(dh, table, cols),
    studies: [
      ...result.columns.map(c => ({ column: c.column, pane: c.pane, levels: c.levels, dashed: c.column.endsWith('_Mid') })),
      ...(req.volume ? [{ column: 'Volume', pane: 'volume', histogram: true }] : []),
    ],
    release: () => {
      if (released) return;
      released = true;
      table.close();
      void api.request('release', { key: result.key }).catch(() => {});
    },
  };
}
