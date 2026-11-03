import { AsyncLocalStorage } from 'node:async_hooks';
import { SourceError } from './errors.js';
import { CircuitBreaker, type Clock, parseRetryAfter, systemClock, TokenBucket } from './resilience.js';

// Counts the requests each source makes while one tool call runs, for the audit log.
export const requestCounter = new AsyncLocalStorage<Record<string, number>>();

export interface HttpSourceOptions {
  fetch?: typeof fetch;
  clock?: Clock;
  limiter?: TokenBucket;
  breaker?: CircuitBreaker;
  budget?: TokenBucket;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
}

// Returns how long to wait before retrying a response, or null when it should not be retried.
export type RetryDelay = (response: Response, attempt: number, nowMs: number) => number | null;

export const retryBusy: RetryDelay = (response, attempt, nowMs) =>
  response.status === 429 || response.status === 503
    ? (parseRetryAfter(response.headers.get('retry-after'), nowMs) ?? 1000 * 2 ** attempt)
    : null;

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  retryDelay?: RetryDelay;
}

// The timeout, retry, rate limit, budget and circuit breaker that every live source shares.
// Client errors (4xx) come back to the caller, which knows what they mean for its source.
export class HttpSource {
  readonly breaker: CircuitBreaker;
  readonly budget: TokenBucket | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: TokenBucket;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;

  constructor(
    private readonly name: string,
    private readonly label: string,
    options: HttpSourceOptions & { defaultRate: number },
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    // Capacity 1 spaces requests evenly, so no one-second window exceeds the rate.
    this.limiter = options.limiter ?? new TokenBucket(1, options.defaultRate, this.clock);
    this.breaker = options.breaker ?? new CircuitBreaker(3, 30_000, this.clock);
    this.budget = options.budget;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
  }

  async send(url: string, options: SendOptions = {}): Promise<Response> {
    const Label = this.label[0].toUpperCase() + this.label.slice(1);
    const retryDelay = options.retryDelay ?? retryBusy;
    for (let attempt = 0; ; attempt++) {
      if (!this.breaker.allows()) {
        throw new SourceError('circuit_open', `${Label} requests are paused after repeated failures. Try again in about 30 seconds.`);
      }
      if (this.budget && !this.budget.tryTake()) {
        throw new SourceError('budget_exceeded', `This role has used its ${this.label} request budget for now.`);
      }
      await this.limiter.take();
      const counts = requestCounter.getStore();
      if (counts) counts[this.name] = (counts[this.name] ?? 0) + 1;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        this.breaker.recordFailure();
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new SourceError(timedOut ? 'timeout' : 'unavailable', timedOut ? `${Label} did not respond in time.` : `Could not reach ${this.label}.`);
      }

      const waitMs = retryDelay(response, attempt, this.clock.now());
      if (waitMs !== null) {
        if (attempt < this.maxRetries && waitMs <= this.maxRetryWaitMs) {
          await this.clock.sleep(waitMs);
          continue;
        }
        this.breaker.recordFailure();
        throw new SourceError('rate_limited', `${Label} is limiting requests (${response.status}).`);
      }
      if (response.status >= 500) {
        this.breaker.recordFailure();
        throw new SourceError('unavailable', `${Label} returned an error (${response.status}).`);
      }
      this.breaker.recordSuccess();
      return response;
    }
  }
}
