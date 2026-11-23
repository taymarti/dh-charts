/**
 * The request API framework, mock side: the same protocol as dh_chart_ext.rpc (type acme.Api). A client opens a
 * stream (a widget), sends JSON {id, method, params}, and gets {id, result} or {id, error, code}; a reply can
 * carry tables, which the client fetches like any table. Handlers tie resources to the stream with
 * ctx.hold(key, release); closing the stream releases them (the real server also expires silent streams).
 */
import type { Source } from './engine';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code = 'error',
  ) {
    super(message);
  }
}

/** A handler's answer with tables attached. */
export class Reply {
  constructor(
    readonly result: unknown,
    readonly tables: Source[] = [],
  ) {}
}

export interface ParamSpec {
  name: string;
  /** 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'any', or a union 'string | array' */
  type: string;
  required: boolean;
  default?: unknown;
  doc?: string;
}

export interface MethodDef {
  name: string;
  doc: string;
  params: ParamSpec[];
  tables: boolean;
  fn: (ctx: Ctx, params: Record<string, any>) => unknown;
}

/** One parameter: `p('sym', 'string')` is required; give a default to make it optional. */
export function p(name: string, type: string, def?: unknown, doc?: string): ParamSpec {
  return { name, type, required: def === undefined, default: def, doc };
}

export class Ctx {
  user = 'anonymous';
  verified = false;
  readonly holds = new Map<string, () => void>();
  constructor(readonly api: Api) {}

  /** keep `release` until the stream releases `key` or closes; false: over the stream's limit */
  hold(key: unknown, release: () => void): boolean {
    const k = typeof key === 'string' ? key : JSON.stringify(key);
    if (this.holds.has(k)) {
      release(); // already held once: the second acquire is given back at once
      return true;
    }
    if (this.holds.size >= this.api.maxHolds) {
      release();
      return false;
    }
    this.holds.set(k, release);
    return true;
  }

  release(key: unknown): boolean {
    const k = typeof key === 'string' ? key : JSON.stringify(key);
    const r = this.holds.get(k);
    if (!r) return false;
    this.holds.delete(k);
    r();
    return true;
  }

  holding(): string[] {
    return [...this.holds.keys()];
  }
}

export interface Stream {
  ctx: Ctx;
  receive(text: string): void;
  close(): void;
}

export class Api {
  readonly methods = new Map<string, MethodDef>();
  streams = 0;
  readonly maxHolds = 200;
  /** every open stream's context (for stats and the graph) */
  readonly open = new Set<Ctx>();

  constructor(readonly name: string) {
    this.method('hello', 'Say who the user is: a token "user:<name>" (unverified, as on Community).', [p('token', 'string', '')], (ctx, { token }) => {
      const t = String(token ?? '');
      ctx.user = t.startsWith('user:') && t.length > 5 ? t.slice(5) : 'anonymous';
      ctx.verified = false;
      return { user: ctx.user, verified: false };
    });
    this.method('describe', "This API's methods and their parameters.", [], () =>
      [...this.methods.values()].map(m => ({ name: m.name, doc: m.doc, params: m.params, returns_tables: m.tables })),
    );
    this.method('ping', 'Keep the stream (and what it holds) alive.', [], () => ({ pong: Date.now() }));
    this.method('release', 'Give back something a request holds (a chart node).', [p('key', 'any')], (ctx, { key }) => ({ released: ctx.release(key) }));
    this.method('whoami', 'The caller, as the server sees it.', [], ctx => ({
      user: ctx.user,
      verified: ctx.verified,
      auth_context: 'AuthContext$Anonymous (mock server: no identity)',
      holds: ctx.holds.size,
    }));
  }

  method(name: string, doc: string, params: ParamSpec[], fn: MethodDef['fn'], opts: { tables?: boolean } = {}) {
    this.methods.set(name, { name, doc, params, tables: !!opts.tables, fn });
  }

  /** a new stream (a client's widget); `send` delivers a message to that client */
  openStream(send: (json: string, tables: Source[]) => void): Stream {
    const ctx = new Ctx(this);
    this.streams++;
    this.open.add(ctx);
    let closed = false;
    let queue = Promise.resolve();
    return {
      ctx,
      receive: (text: string) => {
        // one request at a time per stream, like the real server
        queue = queue.then(() => this.handle(ctx, text, send, () => closed));
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.streams--;
        this.open.delete(ctx);
        for (const r of ctx.holds.values()) {
          try {
            r();
          } catch {
            /* already released */
          }
        }
        ctx.holds.clear();
      },
    };
  }

  private async handle(ctx: Ctx, text: string, send: (json: string, tables: Source[]) => void, isClosed: () => boolean) {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return send(JSON.stringify({ error: 'not JSON', code: 'bad_request' }), []);
    }
    const id = msg.id;
    const m = this.methods.get(String(msg.method));
    if (!m) return send(JSON.stringify({ id, error: `no method ${msg.method}`, code: 'not_found' }), []);
    try {
      const params = validate(m, msg.params ?? {});
      const out = await m.fn(ctx, params);
      if (isClosed()) return;
      if (out instanceof Reply) send(JSON.stringify({ id, result: out.result ?? null }), out.tables);
      else send(JSON.stringify({ id, result: out ?? null }), []);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 'error');
      if (!(e instanceof ApiError)) console.warn(`${this.name}.${m.name} failed`, e);
      if (!isClosed()) send(JSON.stringify({ id, error: err.message, code: err.code }), []);
    }
  }
}

function typeOk(type: string, v: unknown): boolean {
  return type.split(' | ').some(t => {
    switch (t) {
      case 'string':
        return typeof v === 'string';
      case 'integer':
        return typeof v === 'number' && Number.isInteger(v);
      case 'number':
        return typeof v === 'number' && Number.isFinite(v);
      case 'boolean':
        return typeof v === 'boolean';
      case 'array':
        return Array.isArray(v);
      case 'object':
        return v != null && typeof v === 'object' && !Array.isArray(v);
      default:
        return true;
    }
  });
}

function validate(m: MethodDef, given: Record<string, unknown>): Record<string, any> {
  const out: Record<string, unknown> = {};
  for (const ps of m.params) {
    const v = given[ps.name];
    if (v === undefined || v === null) {
      if (ps.required) throw new ApiError(`${m.name}: missing parameter ${ps.name}`, 'bad_params');
      out[ps.name] = ps.default;
      continue;
    }
    if (!typeOk(ps.type, v)) throw new ApiError(`${m.name}: ${ps.name} must be ${ps.type}`, 'bad_params');
    out[ps.name] = v;
  }
  const unknown = Object.keys(given).filter(k => !m.params.some(ps => ps.name === k));
  if (unknown.length) throw new ApiError(`${m.name}: unknown parameter ${unknown.join(', ')}`, 'bad_params');
  return out;
}
