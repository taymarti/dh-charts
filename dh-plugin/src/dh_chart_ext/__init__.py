"""
dh_chart_ext: our chart features for Deephaven, server side.

Installing this package registers one JS plugin with the Deephaven server. It applies @acme/chart-ext
(ext/: our Lightweight Charts plugins) to every TradingView chart in any Deephaven web UI,
deephaven.ui dashboards included.

Python layers (see README.md for which front ends each one serves):
  dh_chart_ext.data       L0  tables: bars, studies, the published standard set
  dh_chart_ext.charts     L1  TvlCharts composed from L0 tables
  dh_chart_ext.workspace  L2  a deephaven.ui toolbar + chart component

They import deephaven, so they load only inside a Deephaven worker; import them explicitly.
"""
