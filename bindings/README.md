# @acme/dh-bindings

Layer 2: the chart component's interfaces (`@acme/chart-ext`) implemented over Deephaven, and the client for
a server's request API. `@acme/chart-ext` itself has no Deephaven dependency; this package is where
Deephaven's JS API comes in.

| Export | What |
|---|---|
| `tableAnnotationStore(dh, table, owner)` | an `AnnotationStore` over the annotations input table (`dh_chart_ext.store.annotation_table`) |
| `tableAlertStore(dh, table, owner)` | an `AlertStore` over the alerts input table (`dh_chart_ext.alerts.alert_table`) |
| `subscribeRows(dh, table, columns, onRows)` | every row of a small live table (watchlists), as plain objects |
| `tableFeed(dh, table, columns)` | a `SeriesFeed` over a table with a time column, for `bindFeed` |
| `openApi(dh, connection, name)`, `ApiClient` | the request API (`dh_chart_ext.rpc.Api`, type `acme.Api`): requests, table references, `hello`, `describe`, lease pings |
| `requestChart(dh, api, { sym, res, studies })` | a chart from the chart API: the shared node as a feed, its study layout, tick size, `release()` |

```ts
const api = await openApi(dh, connection, 'chart_api');
const c = await requestChart(dh, api, { sym: 'NQ', res: '2m', studies: ['EMA_20', 'RSI_14'] });
const drawn = bindFeed(chart, c.feed, { price: { title: 'NQ', tick: c.tick }, studies: c.studies });
// ...
drawn.dispose();
c.release();
```

Peer dependencies: `@acme/chart-ext` ^0.4.0, `@deephaven/jsapi-types` ~41.11 (types only), `lightweight-charts` 5.2.0.

`npm test` runs the unit tests (vitest, no server); `npm run build` builds `dist/` (after `@acme/chart-ext`'s build,
whose types it references).
