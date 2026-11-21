/** Small line icons for the toolbar (stroke = currentColor, 18x18 viewBox). */
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
  caret: (
    <svg viewBox="0 0 8 8" className="acme-tb-caret" aria-hidden="true">
      <path d="M1 2.5l3 3 3-3" />
    </svg>
  ),
};
