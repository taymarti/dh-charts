/**
 * The page's chart stores from published tables, for every chart on the page (@acme/chart-ext's page-level
 * providers): saved price lines and drawings, alerts (with a toast when one of `user`'s fires), and the
 * session calendar. A table the server doesn't publish is skipped: the feature just stays off.
 */
import { useEffect } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { providePageAlertStore, providePageAnnotationStore, setPageSessions, showAlertToasts, type SessionSpec } from '@acme/chart-ext';
import { safeClose, subscribeRows, tableAlertStore, tableAnnotationStore } from '@acme/dh-bindings';
import { useDeephaven } from '../deephaven';

export interface PageStoreTables {
  /** the annotations input table (dh_chart_ext.store.annotation_table); null: none */
  annotations?: string | null;
  /** the alerts input table (dh_chart_ext.alerts.alert_table); null: none */
  alerts?: string | null;
  /** the sessions table (Sym, Spec as JSON); null: none */
  sessions?: string | null;
}

export function usePageStores(user: string, tables: PageStoreTables = {}) {
  const { dh, connection } = useDeephaven();
  const { annotations = 'chart_annotations', alerts = 'chart_alerts', sessions = 'sessions' } = tables;
  useEffect(() => {
    let closed = false;
    const releases: Array<() => void> = [];
    const open = (name: string | null, use: (t: Dh.Table) => () => void) => {
      if (!name) return;
      connection
        .getObject({ type: dh.VariableType.TABLE, name } as never)
        .then(obj => {
          const t = obj as Dh.Table;
          if (closed) return safeClose(t);
          const stop = use(t);
          releases.push(() => {
            stop();
            safeClose(t);
          });
        })
        .catch(() => {}); // not published on this server
    };
    open(annotations, t => {
      const store = tableAnnotationStore(dh, t, user);
      const unprovide = providePageAnnotationStore(store);
      return () => {
        unprovide();
        store.close();
      };
    });
    open(alerts, t => {
      const store = tableAlertStore(dh, t, user);
      const unprovide = providePageAlertStore(store);
      const stopToasts = showAlertToasts(store);
      return () => {
        stopToasts();
        unprovide();
        store.close();
      };
    });
    open(sessions, t =>
      subscribeRows(dh, t, ['Sym', 'Spec'], rows => {
        const map: Record<string, SessionSpec> = {};
        for (const r of rows) map[String(r.Sym)] = JSON.parse(String(r.Spec));
        setPageSessions(map);
      }),
    );
    return () => {
      closed = true;
      releases.forEach(r => r());
    };
  }, [dh, connection, user, annotations, alerts, sessions]);
}
