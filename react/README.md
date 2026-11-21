# @acme/chart-react

React components for trading charts, styled like TradingView desktop. From
[dh-charts](https://github.com/taymarti/dh-charts).

- **`ChartToolbar`**: symbol search, a grouped interval menu, a chart-type menu with icons, an
  "ƒx Indicators" search dialog, range, and % / log scale. Controlled: pass `value` and `options`,
  get changes from `onChange(patch)`. Parts whose options are missing are left out. Styles are
  injected by the component; colors are CSS variables (`--acme-tb-*`) on `.acme-tb`.

```tsx
import { ChartToolbar } from '@acme/chart-react';

<ChartToolbar
  value={{ symbol: 'ES', resolution: '1m', studies: ['EMA_20'], scale: 'normal' }}
  options={{
    symbols: [{ key: 'ES', label: 'ES' }, { key: 'NQ', label: 'NQ' }],
    resolutions: [{ key: '1m', label: '1m', group: 'Minutes' }, { key: '5m', label: '5m', group: 'Minutes' }],
    studies: [{ key: 'EMA_20', label: 'EMA 20', group: 'Moving averages' }],
    scales: true,
  }}
  onChange={patch => setValue(v => ({ ...v, ...patch }))}
/>
```

An ES module for bundlers, with types. Peer dependency: `react` 18 or 19. In deephaven.ui, the
dh-chart-ext server plugin renders it as the `acme.chart.Toolbar` element.
