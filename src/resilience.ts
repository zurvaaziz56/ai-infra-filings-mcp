export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.updatedAt = clock.now();
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async take(): Promise<void> {
    while (!this.tryTake()) {
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
    }
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = this.clock.now();
    const earned = ((now - this.updatedAt) / 1000) * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + earned);
    this.updatedAt = now;
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000,
    private readonly clock: Clock = systemClock,
  ) {}

  state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.clock.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  allows(): boolean {
    return this.state() !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    // A failed trial request in half-open state reopens the circuit at once.
    if (this.state() === 'half_open' || this.failures >= this.threshold) {
      this.openedAt = this.clock.now();
    }
  }
}

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
