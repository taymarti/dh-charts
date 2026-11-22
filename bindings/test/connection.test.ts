import { describe, expect, it, vi } from 'vitest';
import { adoptConnection, connect, toPlain } from '../src/connection';
import { TableViewport, parseQuickFilter } from '../src/viewport';

// A stand-in event target, as the JS API's HasEventHandling
function target<T extends object>(extra: T) {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  return Object.assign(extra, {
    addEventListener(name: string, cb: (e: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(cb);
      return () => handlers.get(name)!.delete(cb);
    },
    fire(name: string, detail?: unknown) {
      handlers.get(name)?.forEach(cb => cb({ detail }));
    },
  });
}

function fakeDh() {
  const tables: Array<ReturnType<typeof fakeTable>> = [];
  const connection = target({
    getObject: vi.fn(async ({ name }: { name: string }) => {
      if (name === 'missing') throw new Error('no such table');
      const t = fakeTable(name);
      tables.push(t);
      return t;
    }),
    close: vi.fn(),
  });
  const client = target({
    login: vi.fn(async () => {}),
    getAsIdeConnection: vi.fn(async () => connection),
    disconnect: vi.fn(),
  });
  const dh = {
    CoreClient: Object.assign(
      vi.fn(() => client),
      { LOGIN_TYPE_ANONYMOUS: 'anonymous', EVENT_DISCONNECT: 'c-disconnect', EVENT_RECONNECT: 'c-reconnect',
        EVENT_RECONNECT_AUTH_FAILED: 'c-auth-failed', EVENT_REQUEST_FAILED: 'c-request-failed' },
    ),
    IdeConnection: { EVENT_DISCONNECT: 'i-disconnect', EVENT_RECONNECT: 'i-reconnect', EVENT_SHUTDOWN: 'i-shutdown' },
    VariableType: { TABLE: 'Table' },
    Table: { EVENT_UPDATED: 'updated', EVENT_SIZECHANGED: 'sizechanged' },
  };
  return { dh, client, connection, tables };
}

function fakeTable(name = 't') {
  const columns = [
    { name: 'Sym', type: 'java.lang.String', description: null },
    { name: 'Qty', type: 'long', description: 'shares' },
  ].map(c => ({ ...c, sort: () => ({ asc: () => `${c.name} asc`, desc: () => `${c.name} desc`, abs: () => ({ asc: () => `abs ${c.name} asc`, desc: () => `abs ${c.name} desc` }) }), filter: () => filterFor(c.name) }));
  const sub = target({ setViewport: vi.fn(), close: vi.fn() });
  return target({
    name,
    columns,
    size: 3,
    close: vi.fn(),
    findColumn: (n: string) => columns.find(c => c.name === n)!,
    applySort: vi.fn(),
    applyFilter: vi.fn(),
    createViewportSubscription: vi.fn(() => sub),
    sub,
  });
}

const filterFor = (col: string) => {
  const cond = (s: string) => ({ s, not: () => `not ${s}` });
  return {
    eq: (v: { v: unknown }) => cond(`${col} = ${v.v}`),
    greaterThan: (v: { v: unknown }) => cond(`${col} > ${v.v}`),
    containsIgnoreCase: (v: { v: unknown }) => cond(`${col} ~ ${v.v}`),
    isNull: () => cond(`${col} null`),
  };
};

describe('connect', () => {
  it('logs in anonymously, attaches, and reports state changes', async () => {
    const { dh, client } = fakeDh();
    const s = await connect({ dh: dh as never, serverUrl: 'http://x/' });
    expect(dh.CoreClient).toHaveBeenCalledWith('http://x');
    expect(client.login).toHaveBeenCalledWith({ type: 'anonymous' });
    const seen: string[] = [];
    s.onState(st => seen.push(st));
    client.fire('c-disconnect');
    client.fire('c-request-failed');
    client.fire('c-reconnect');
    expect(seen).toEqual(['connected', 'disconnected', 'reconnecting', 'connected']);
    expect(s.history.map(h => h.state)).toEqual(['connecting', 'connected', 'disconnected', 'reconnecting', 'connected']);
  });

  it('sees a restarted server as a lost session (UNAUTHENTICATED on the connection)', async () => {
    const { dh, client, connection } = fakeDh();
    const s = await connect({ dh: dh as never });
    client.fire('c-disconnect');
    connection.fire('c-request-failed', new Error('Response closed without trailers'));
    expect(s.state).toBe('reconnecting');
    connection.fire('c-request-failed', new Error('Authentication details invalid'));
    expect(s.state).toBe('auth_failed');
    client.fire('c-reconnect');
    expect(s.state).toBe('auth_failed');
  });

  it('stays down after the server ends the session', async () => {
    const { dh, client, connection } = fakeDh();
    const s = await connect({ dh: dh as never });
    connection.fire('i-shutdown');
    client.fire('c-reconnect');
    expect(s.state).toBe('shutdown');
  });
});

describe('table leases', () => {
  it('shares one handle per name and closes it after the last release', async () => {
    const { dh, connection, tables } = fakeDh();
    const s = adoptConnection(dh as never, connection as never);
    const [a, b] = await Promise.all([s.acquireTable('quotes'), s.acquireTable('quotes')]);
    expect(a.table).toBe(b.table);
    expect(connection.getObject).toHaveBeenCalledTimes(1);
    a.release();
    a.release(); // twice is harmless
    expect(tables[0].close).not.toHaveBeenCalled();
    b.release();
    expect(tables[0].close).toHaveBeenCalledTimes(1);
    await s.acquireTable('quotes');
    expect(connection.getObject).toHaveBeenCalledTimes(2); // fetched again
  });

  it('does not cache a failed fetch', async () => {
    const { dh, connection } = fakeDh();
    const s = adoptConnection(dh as never, connection as never);
    await expect(s.acquireTable('missing')).rejects.toThrow('no such table');
    await expect(s.acquireTable('missing')).rejects.toThrow();
    expect(connection.getObject).toHaveBeenCalledTimes(2);
  });

  it('gives openTable a handle of its own', async () => {
    const { dh, connection } = fakeDh();
    const s = adoptConnection(dh as never, connection as never);
    const [x, y] = await Promise.all([s.openTable('book'), s.openTable('book')]);
    expect(x).not.toBe(y);
  });
});

describe('toPlain', () => {
  it('unwraps dates, longs and big decimals', () => {
    const d = new Date(0);
    expect(toPlain({ asDate: () => d, asNumber: () => 0 })).toBe(d);
    expect(toPlain({ asNumber: () => 5 })).toBe(5);
    expect(toPlain({ doubleValue: () => 1.5 })).toBe(1.5);
    expect(toPlain('x')).toBe('x');
  });
});

describe('TableViewport', () => {
  const dhWithFilters = () => {
    const { dh } = fakeDh();
    return { ...dh, FilterValue: { ofString: (v: string) => ({ v }), ofNumber: (v: number) => ({ v }), ofBoolean: (v: boolean) => ({ v }) } };
  };

  it('subscribes to the range and emits plain rows with the size', () => {
    const dh = dhWithFilters();
    const t = fakeTable();
    const onData = vi.fn();
    const v = new TableViewport(dh as never, t as never, onData);
    v.setRange(0, 9);
    expect(t.createViewportSubscription).toHaveBeenCalledWith(expect.objectContaining({ rows: { first: 0, last: 9 } }));
    v.setRange(0, 9); // unchanged: no new request
    expect(t.sub.setViewport).not.toHaveBeenCalled();
    v.setRange(10, 19);
    expect(t.sub.setViewport).toHaveBeenCalledWith(10, 19, t.columns, 250);
    const row = (sym: string, qty: number) => ({ get: (c: { name: string }) => (c.name === 'Sym' ? sym : { asNumber: () => qty }) });
    t.sub.fire('updated', { offset: 10, columns: t.columns, rows: [row('ES', 1), row('NQ', 2)] });
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10, size: 3, rows: [{ Sym: 'ES', Qty: 1 }, { Sym: 'NQ', Qty: 2 }] }));
    expect(onData.mock.lastCall![0].columns[1]).toEqual({ name: 'Qty', type: 'long', description: 'shares', numeric: true });
    t.size = 4;
    t.fire('sizechanged');
    expect(onData.mock.lastCall![0].size).toBe(4);
    v.close();
    expect(t.sub.close).toHaveBeenCalled();
  });

  it('sorts and filters on the server', () => {
    const dh = dhWithFilters();
    const t = fakeTable();
    const v = new TableViewport(dh as never, t as never, () => {});
    v.sort([{ column: 'Qty', direction: 'desc' }, { column: 'Sym', direction: 'asc', abs: true }]);
    expect(t.applySort).toHaveBeenCalledWith(['Qty desc', 'abs Sym asc']);
    v.filter({ Sym: 'es', Qty: '>100', Other: 'x' });
    expect(t.applyFilter.mock.lastCall![0].map((c: { s: string }) => c.s)).toEqual(['Sym ~ es', 'Qty > 100']);
    expect(() => v.filter({ Qty: '>abc' })).toThrow('not a number');
  });
});

describe('parseQuickFilter', () => {
  it('reads operators, nulls and plain text', () => {
    expect(parseQuickFilter('>= 5', true)).toEqual({ op: 'greaterThanOrEqualTo', value: '5' });
    expect(parseQuickFilter('!=ES', false)).toEqual({ op: 'notEq', value: 'ES' });
    expect(parseQuickFilter('null', false)).toEqual({ op: 'isNull' });
    expect(parseQuickFilter('!null', true)).toEqual({ op: 'notNull' });
    expect(parseQuickFilter('tech', false)).toEqual({ op: 'contains', value: 'tech' });
    expect(parseQuickFilter('42', true)).toEqual({ op: 'eq', value: '42' });
  });
});
