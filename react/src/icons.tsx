/** Small line icons for the toolbar and legend (stroke = currentColor, 18x18 viewBox). */
const svg = (d: string) => (
  <svg viewBox="0 0 18 18" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const icons = {
  candle: svg('M5 2v3M5 12v4M4 5h2v7H4zM12 3v4M12 13v2M11 7h2v6h-2z'),
  bar: svg('M5 2v14M3 6h2M5 12h2M12 3v12M10 5h2M12 11h2'),
  line: svg('M2 13l4-5 3 3 6-7'),
  area: svg('M2 13l4-5 3 3 6-7v11H2z'),
  search: svg('M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM11.5 11.5L15 15'),
  fx: svg('M7 15c1.5 0 2-1 2.3-3l1.2-7c.3-2 .9-3 2.5-3M6 8h6M12 9l4 5M16 9l-4 5'),
  close: svg('M4 4l10 10M14 4L4 14'),
  layout1: svg('M2.5 3.5h13v11h-13z'),
  layout2h: svg('M2.5 3.5h13v11h-13zM9 3.5v11'),
  layout2v: svg('M2.5 3.5h13v11h-13zM2.5 9h13'),
  layout3h: svg('M2.5 3.5h13v11h-13zM9 3.5v11M9 9h6.5'),
  layout4: svg('M2.5 3.5h13v11h-13zM9 3.5v11M2.5 9h13'),
  watchlist: svg('M3 4.5h12M3 9h12M3 13.5h12M3 4.5h0'),
  compare: svg('M9 3v12M3 9h12M2 14l3-3 2 2 4-4'),
  bell: svg('M9 2.5a4.5 4.5 0 0 0-4.5 4.5v3L3 12.5h12L13.5 10V7A4.5 4.5 0 0 0 9 2.5zM7.3 14.5a1.8 1.8 0 0 0 3.4 0'),
  eye: svg('M1.5 9s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5zM9 6.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z'),
  eyeOff: svg('M1.5 9s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5zM3 15L15 3'),
  gear: svg('M9 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4'),
  caret: (
    <svg viewBox="0 0 8 8" className="acme-tb-caret" aria-hidden="true">
      <path d="M1 2.5l3 3 3-3" />
    </svg>
  ),
};
