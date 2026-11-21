"""
P, persistence: chart annotations (price lines now; drawings and settings next) in one Deephaven table,
so every front end reads and writes the same rows:

  A  deephaven.ui         the workspace passes the table to the `acme.chart.Annotations` element
  B  React + Deephaven UI the app fetches the published table and builds a store (@acme/chart-ext)
  C  React, table data    the same, around its own charts

    chart_annotations = annotation_table(path=".../annotations.parquet")   # in the app script

Schema (one row per annotation, keyed by ChartKey + Id):
  ChartKey   what the annotation belongs to, usually the symbol (drawings by time and price carry
             across resolutions and chart types)
  Id         client-generated unique id
  Kind       "price_line", later "trend_line", "rect", ...
  Owner      who made it
  Shared     visible to everyone (else only to Owner)
  Deleted    soft delete: clients delete with an ordinary upsert, and the row stays as history
  Spec       JSON: the kind's parameters, e.g. {"price": 101.25}
  UpdatedMs  epoch milliseconds of the last change (client clock)

Who "Owner" is: Community has no user identity, so the client supplies it (the workspace's `user`
argument, a URL parameter, or a per-browser id). That is attribution, not access control. On
Enterprise, take it from the authenticated user and enforce visibility with row-level ACLs on Owner.

Durability: a Community input table lives in memory. With `path`, the table is loaded from a parquet
snapshot at startup and written back after every change (fine for hundreds of annotations; a busy
desk wants Enterprise's persistent input tables instead).
"""
from __future__ import annotations

import pathlib
from typing import Optional

from deephaven import dtypes
from deephaven.table import Table
from deephaven.table_factory import InputTable, input_table

COLUMNS = {
    "ChartKey": dtypes.string,
    "Id": dtypes.string,
    "Kind": dtypes.string,
    "Owner": dtypes.string,
    "Shared": dtypes.bool_,
    "Deleted": dtypes.bool_,
    "Spec": dtypes.string,
    "UpdatedMs": dtypes.int64,
}
KEYS = ["ChartKey", "Id"]

# the listeners keeping snapshots on disk; held so they are not garbage-collected
_autosaves: list = []


def annotation_table(path: Optional[str | pathlib.Path] = None) -> InputTable:
    """A keyed input table of chart annotations; with `path`, loaded from and saved to a parquet file."""
    t = input_table(col_defs=COLUMNS, key_cols=KEYS)
    if path is None:
        return t
    from deephaven import parquet
    from deephaven.table_listener import listen

    p = pathlib.Path(path).resolve()
    uri = p.as_uri()  # parquet on Windows needs file:/// URIs
    if p.exists():
        t.add(parquet.read(uri).view(list(COLUMNS)))

    def save(update, is_replay):  # runs in the update cycle, holding the lock: snapshot is consistent
        p.parent.mkdir(parents=True, exist_ok=True)
        parquet.write(t.snapshot(), uri)

    _autosaves.append(listen(t, save, do_replay=False))
    return t


def visible(t: Table, owner: str) -> Table:
    """The annotations `owner` sees: not deleted, and theirs or shared."""
    return t.where(["!Deleted", f"Shared || Owner == `{owner}`"])


def annotations_element(table: Table, owner: Optional[str] = None):
    """The deephaven.ui element that hands `table` to the page's chart extensions (rendered by the
    dh-chart-ext JS plugin as `acme.chart.Annotations`; it draws nothing). `owner` names the user;
    None lets the browser use a per-browser id."""
    from deephaven.ui.elements import BaseElement

    props = {"table": table}
    if owner is not None:
        props["owner"] = owner
    return BaseElement("acme.chart.Annotations", **props)
