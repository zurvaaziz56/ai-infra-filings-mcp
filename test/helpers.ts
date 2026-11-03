import { readFileSync } from 'node:fs';
import { type Db, migrate, openDb } from '../src/db.js';
import { loadCompanies } from '../src/load.js';
import type { Clock } from '../src/resilience.js';
import { SecClient } from '../src/sec-client.js';

export const FIXTURE_TICKERS = ['NVDA', 'ORCL', 'MSFT', 'SMCI', 'DELL', 'CRWV'] as const;
export const TEST_USER_AGENT = 'Test Runner test@example.com';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// Serves the recorded SEC responses by URL, so no test touches the network.
export function fixtureFetch(): typeof fetch {
  const tickers = fixture<Record<string, { cik_str: number; ticker: string }>>('company-tickers.json');
  const byCik = new Map(Object.values(tickers).map((row) => [String(row.cik_str).padStart(10, '0'), row.ticker.toLowerCase()]));
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/files/company_tickers.json')) return json(tickers);
    if (url.startsWith('https://efts.sec.gov/')) return json(fixture('search-anthropic.json'));
    const ticker = byCik.get(/CIK(\d{10})\.json$/.exec(url)?.[1] ?? '');
    if (!ticker) return json({}, 404);
    return json(fixture(`${ticker}-${url.includes('/companyfacts/') ? 'companyfacts' : 'submissions'}.json`));
  };
}

// An in-memory warehouse loaded from the fixtures, as npm run load would build it.
export async function fixtureWarehouse(): Promise<Db> {
  const db = await openDb({});
  await migrate(db);
  const sec = new SecClient({ userAgent: TEST_USER_AGENT, fetch: fixtureFetch(), clock: fakeClock() });
  const results = await loadCompanies(db, sec, FIXTURE_TICKERS);
  if (results.some((result) => result.status !== 'loaded')) throw new Error(`Fixture load failed: ${JSON.stringify(results)}`);
  return db;
}

// Stores issues in memory and serves the two GitHub endpoints the server uses.
export function fakeGitHub() {
  const issues: Array<{ number: number; html_url: string; state: string; title: string; body: string }> = [];
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const state = { failNextCreateAfterSaving: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    if (method === 'POST') {
      const number = issues.length + 1;
      const issue = { number, html_url: `https://github.com/owner/data-issues/issues/${number}`, state: 'open', ...JSON.parse(String(init?.body)) };
      issues.push(issue);
      if (state.failNextCreateAfterSaving) {
        state.failNextCreateAfterSaving = false;
        return json({ message: 'Server Error' }, 502);
      }
      return json(issue, 201);
    }
    const page = Number(url.searchParams.get('page') ?? '1');
    return json(issues.slice((page - 1) * 100, page * 100));
  };
  return { issues, requests, state, fetch };
}

export function fakeClock(): Clock & { slept: number[]; advance(ms: number): void } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}
