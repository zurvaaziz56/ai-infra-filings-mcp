import { readFileSync } from 'node:fs';
import type { Clock } from '../src/resilience.js';

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
