/**
 * Panel kinds: what the shell can open. A kind is a React component plus its default params; the shell
 * keeps each panel's params in the layout (so a saved workspace restores them) and gives the component a
 * setter. Params must be JSON: they are saved as they are.
 *
 *   export const quotesPanel = definePanel({
 *     kind: 'quotes', title: 'Quotes', defaultParams: { table: 'quotes' },
 *     component: ({ params, setParams, linkGroup }) => ...,
 *   });
 *   <Shell kinds={[chartPanel, tablePanel, quotesPanel]} />
 */
import type { ComponentType } from 'react';

export interface PanelProps<P extends object = Record<string, unknown>> {
  /** the panel's id in the layout */
  id: string;
  params: P;
  /** merge into the params (saved with the workspace) */
  setParams(patch: Partial<P>): void;
  setTitle(title: string): void;
  /** the link group this panel is in (null: not linked); the user picks it in the panel's header */
  linkGroup: string | null;
  /** open another panel, to the right of this one */
  openPanel(kind: string, params?: Record<string, unknown>, title?: string): void;
}

export interface PanelKind<P extends object = any> {
  kind: string;
  /** the tab's title for a new panel */
  title: string | ((params: P) => string);
  component: ComponentType<PanelProps<P>>;
  defaultParams?: P;
  /** the name in the "add panel" menu (default: the title) */
  label?: string;
  /** a line for the "add panel" menu */
  description?: string;
  /** whether the header shows a link-group picker (default true) */
  linkable?: boolean;
  /** the link group a new panel starts in (default 'red'; null: unlinked) */
  defaultLink?: string | null;
}

export function definePanel<P extends object>(kind: PanelKind<P>): PanelKind<P> {
  return kind;
}

/** The params the shell stores: the kind's own, plus the panel's link group. */
export type StoredParams = Record<string, unknown> & { __link?: string | null };

export function titleOf(kind: PanelKind, params: object): string {
  return typeof kind.title === 'function' ? kind.title(params) : kind.title;
}
