/**
 * TradingView Lightweight Charts' license (Apache-2.0 with an attribution requirement) asks every
 * application that uses it to show this notice and a link to https://www.tradingview.com/ on a page its
 * users can see. Deephaven's plugin turns off the chart's own logo (`attributionLogo`), so apps built on
 * it show this instead, once per page. Apps drawing their own charts can either show this or keep the
 * chart option `attributionLogo: true`, which satisfies the link requirement.
 */
export const TRADINGVIEW_ATTRIBUTION = {
  notice: 'TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc.',
  linkText: 'TradingView Lightweight Charts™',
  url: 'https://www.tradingview.com/',
} as const;
