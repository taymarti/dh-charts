import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api-client';

const dh = { Widget: { EVENT_MESSAGE: 'message' } };

function fakeWidget(first = { event: 'ready', version: 2, lease_s: 90, methods: ['chart'] }) {
  const sent: { id: number; method: string; params: unknown }[] = [];
  const widget = {
    getDataAsString: () => JSON.stringify(first),
    addEventListener: () => () => {},
    sendMessage: (m: string) => sent.push(JSON.parse(m)),
    close: vi.fn(),
  };
  return { widget, sent };
}
const ref = () => ({ fetch: vi.fn(async () => ({ table: true })), close: vi.fn() });

describe('ApiClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the ready message', () => {
    const { widget } = fakeWidget();
    expect(new ApiClient(widget as never, dh as never).ready.lease_s).toBe(90);
  });

  it('matches replies to requests by id, with their references', async () => {
    const { widget, sent } = fakeWidget();
    const api = new ApiClient(widget as never, dh as never);
    const p = api.request('chart', { sym: 'ES' });
    expect(sent[0]).toEqual({ id: 1, method: 'chart', params: { sym: 'ES' } });
    const r = ref();
    api.onMessage(JSON.stringify({ id: 1, result: { key: ['bars'] } }), [r as never]);
    await expect(p).resolves.toEqual({ result: { key: ['bars'] }, refs: [r] });
  });

  it('rejects with the error and its code, and closes stray references', async () => {
    const { widget } = fakeWidget();
    const api = new ApiClient(widget as never, dh as never);
    const p = api.request('chart', {});
    const r = ref();
    api.onMessage(JSON.stringify({ id: 1, error: 'missing parameter', code: 'bad_params' }), [r as never]);
    await expect(p).rejects.toMatchObject({ name: 'ApiError', code: 'bad_params' });
    expect(r.close).toHaveBeenCalled();
  });

  it('closes references nobody waits for', () => {
    const { widget } = fakeWidget();
    const api = new ApiClient(widget as never, dh as never);
    const r = ref();
    api.onMessage(JSON.stringify({ id: 99, result: 1 }), [r as never]);
    expect(r.close).toHaveBeenCalled();
  });

  it('pings every third of the lease', () => {
    const { widget, sent } = fakeWidget({ event: 'ready', version: 2, lease_s: 30, methods: [] });
    new ApiClient(widget as never, dh as never);
    vi.advanceTimersByTime(10_000);
    expect(sent.map(s => s.method)).toEqual(['ping']);
  });

  it('fails pending requests and stops pinging when closed', async () => {
    const { widget, sent } = fakeWidget();
    const api = new ApiClient(widget as never, dh as never);
    const p = api.request('chart');
    api.close();
    await expect(p).rejects.toBeInstanceOf(ApiError);
    vi.advanceTimersByTime(120_000);
    expect(sent.filter(s => s.method === 'ping')).toEqual([]);
    expect(widget.close).toHaveBeenCalled();
    await expect(api.request('chart')).rejects.toMatchObject({ code: 'closed' });
  });
});
