import { describe, expect, it, vi } from 'vitest';
import { TokenBucket } from '../src/resilience.js';
import { SecClient } from '../src/sec-client.js';
import { fakeClock, json, TEST_USER_AGENT } from './helpers.js';

const URL = 'https://data.sec.gov/submissions/CIK0001045810.json';

describe('SEC client', () => {
  it('spaces requests so that no second carries more than 8', async () => {
    const clock = fakeClock();
    const fetch = vi.fn(async () => json({}));
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock });
    for (let i = 0; i < 9; i++) await sec.getJson(URL);
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(clock.now()).toBeGreaterThanOrEqual(1000);
  });

  it('sends both ends of a search date range, which EDGAR needs to apply it', async () => {
    const fetch = vi.fn(async () => json({ hits: { total: { value: 0 }, hits: [] } }));
    await new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock: fakeClock() }).searchFilings({ query: 'Anthropic', from: '2025-01-01' });
    const url = new globalThis.URL(String((fetch.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('startdt')).toBe('2025-01-01');
    expect(url.searchParams.get('enddt')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses to send a request without a contact email', async () => {
    const fetch = vi.fn(async () => json({}));
    for (const userAgent of [undefined, 'my-bot/1.0']) {
      await expect(new SecClient({ userAgent, fetch }).getJson(URL)).rejects.toMatchObject({ kind: 'config' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a 403 into advice about SEC_USER_AGENT', async () => {
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch: async () => json({}, 403), clock: fakeClock() });
    await expect(sec.getJson(URL)).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringContaining('SEC_USER_AGENT') });
  });

  it('waits for Retry-After on a 429, then retries', async () => {
    const clock = fakeClock();
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' })).mockResolvedValueOnce(json({ ok: true }));
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock });
    await expect(sec.getJson(URL)).resolves.toEqual({ ok: true });
    expect(clock.slept).toContain(2000);
  });

  it('gives up when Retry-After is longer than it will wait', async () => {
    const fetch = vi.fn(async () => json({}, 429, { 'retry-after': '120' }));
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock: fakeClock() });
    await expect(sec.getJson(URL)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit after three failures and tries again after the cooldown', async () => {
    const clock = fakeClock();
    const fetch = vi.fn(async () => json({}, 500));
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock });
    for (let i = 0; i < 3; i++) await expect(sec.getJson(URL)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(sec.getJson(URL)).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(fetch).toHaveBeenCalledTimes(3);

    clock.advance(30_000);
    fetch.mockResolvedValueOnce(json({ ok: true }));
    await expect(sec.getJson(URL)).resolves.toEqual({ ok: true });
    expect(sec.breaker.state()).toBe('closed');
  });

  it("stops at the role's request budget", async () => {
    const clock = fakeClock();
    const fetch = vi.fn(async () => json({}));
    const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch, clock, budget: new TokenBucket(2, 0, clock) });
    await sec.getJson(URL);
    await sec.getJson(URL);
    await expect(sec.getJson(URL)).rejects.toMatchObject({ kind: 'budget_exceeded' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
