import { AsyncLocalStorage } from 'node:async_hooks';
import { SourceError } from './errors.js';
import { CircuitBreaker, type Clock, parseRetryAfter, systemClock, TokenBucket } from './resilience.js';

export interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
  frame?: string;
}

export interface CompanyFacts {
  // A number for most filers, but a zero-padded string for some, such as CoreWeave.
  cik: number | string;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, SecFact[]> }>>;
}

export interface Submissions {
  cik: string;
  name: string;
  tickers: string[];
  sicDescription?: string;
  fiscalYearEnd?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

export interface SearchHit {
  _id: string;
  _source: {
    ciks: string[];
    display_names: string[];
    form: string;
    file_date: string;
    period_ending?: string | null;
    adsh: string;
  };
}

export interface SearchResponse {
  hits: { total: { value: number }; hits: SearchHit[] };
}

export interface SearchParams {
  query: string;
  forms?: string[];
  from?: string;
  to?: string;
  offset?: number;
}

// Counts the SEC requests made while one tool call runs, for the audit log.
export const secRequestCounter = new AsyncLocalStorage<{ count: number }>();

export interface SecClientOptions {
  userAgent: string | undefined;
  fetch?: typeof fetch;
  clock?: Clock;
  limiter?: TokenBucket;
  breaker?: CircuitBreaker;
  budget?: TokenBucket;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
}

const USER_AGENT_HELP =
  'Set SEC_USER_AGENT to your name and email, for example "Jane Doe jane@example.com". The SEC rejects requests without a contact email.';

export class SecClient {
  readonly breaker: CircuitBreaker;
  readonly budget: TokenBucket | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: TokenBucket;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;

  constructor(private readonly options: SecClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    // Capacity 1 spaces requests evenly, so no one-second window can exceed the SEC's limit of 10.
    this.limiter = options.limiter ?? new TokenBucket(1, 8, this.clock);
    this.breaker = options.breaker ?? new CircuitBreaker(3, 30_000, this.clock);
    this.budget = options.budget;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
  }

  get userAgentConfigured(): boolean {
    return isValidUserAgent(this.options.userAgent);
  }

  tickers(): Promise<Record<string, TickerRow>> {
    return this.getJson('https://www.sec.gov/files/company_tickers.json');
  }

  submissions(cik: string): Promise<Submissions> {
    return this.getJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  }

  companyFacts(cik: string): Promise<CompanyFacts> {
    return this.getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  }

  searchFilings(params: SearchParams): Promise<SearchResponse> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    url.searchParams.set('q', params.query);
    if (params.forms?.length) url.searchParams.set('forms', params.forms.join(','));
    if (params.from || params.to) {
      url.searchParams.set('dateRange', 'custom');
      if (params.from) url.searchParams.set('startdt', params.from);
      if (params.to) url.searchParams.set('enddt', params.to);
    }
    if (params.offset) url.searchParams.set('from', String(params.offset));
    return this.getJson(url.toString());
  }

  async getJson<T>(url: string): Promise<T> {
    const userAgent = this.options.userAgent;
    if (!isValidUserAgent(userAgent)) {
      throw new SourceError('config', `SEC_USER_AGENT is missing or has no email. ${USER_AGENT_HELP}`);
    }

    for (let attempt = 0; ; attempt++) {
      if (!this.breaker.allows()) {
        throw new SourceError('circuit_open', 'SEC requests are paused after repeated failures. Try again in about 30 seconds.');
      }
      if (this.budget && !this.budget.tryTake()) {
        throw new SourceError('budget_exceeded', 'This role has used its SEC request budget for now.');
      }
      await this.limiter.take();
      const counter = secRequestCounter.getStore();
      if (counter) counter.count += 1;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        this.breaker.recordFailure();
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new SourceError(timedOut ? 'timeout' : 'unavailable', timedOut ? 'The SEC did not respond in time.' : 'Could not reach the SEC.');
      }

      if (response.ok) {
        this.breaker.recordSuccess();
        return (await response.json()) as T;
      }
      if (response.status === 404) {
        this.breaker.recordSuccess();
        throw new SourceError('not_found', 'The SEC has no data at this address.');
      }
      if (response.status === 403) {
        throw new SourceError('forbidden', `The SEC refused the request (403). ${USER_AGENT_HELP}`);
      }
      if (response.status === 429 || response.status === 503) {
        const waitMs = parseRetryAfter(response.headers.get('retry-after'), this.clock.now()) ?? 1000 * 2 ** attempt;
        if (attempt < this.maxRetries && waitMs <= this.maxRetryWaitMs) {
          await this.clock.sleep(waitMs);
          continue;
        }
        this.breaker.recordFailure();
        throw new SourceError('rate_limited', `The SEC is limiting requests (${response.status}).`);
      }
      this.breaker.recordFailure();
      throw new SourceError('unavailable', `The SEC returned an error (${response.status}).`);
    }
  }
}

function isValidUserAgent(value: string | undefined): value is string {
  return !!value && /\S+@\S+\.\S+/.test(value);
}

export function padCik(cik: string | number): string {
  return String(cik).padStart(10, '0');
}
