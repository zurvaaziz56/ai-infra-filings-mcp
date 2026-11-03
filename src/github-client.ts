import { SourceError } from './errors.js';
import { HttpSource, type HttpSourceOptions, type RetryDelay } from './http.js';
import { parseRetryAfter } from './resilience.js';

export interface GitHubIssue {
  number: number;
  html_url: string;
  state: string;
  body: string | null;
  pull_request?: unknown;
}

export interface GitHubClientOptions extends HttpSourceOptions {
  token: string | undefined;
  repo: string | undefined;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const MAX_PAGES = 10;

// GitHub signals rate limits with 429, or with 403 plus Retry-After or x-ratelimit-remaining: 0.
const retryRateLimit: RetryDelay = (response, attempt, nowMs) => {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), nowMs);
  if (retryAfter !== null) return retryAfter;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) ? Math.max(0, reset * 1000 - nowMs) : 60_000;
  }
  return response.status === 429 ? 60_000 * 2 ** attempt : null;
};

const retryRead: RetryDelay = (response, attempt, nowMs) =>
  retryRateLimit(response, attempt, nowMs) ?? ([502, 503, 504].includes(response.status) ? 1000 * 2 ** attempt : null);

export class GitHubClient {
  readonly http: HttpSource;

  constructor(private readonly options: GitHubClientOptions) {
    this.http = new HttpSource('github', 'GitHub', { ...options, defaultRate: 1 });
  }

  get configured(): boolean {
    return !!this.options.token && REPO_PATTERN.test(this.options.repo ?? '');
  }

  get repo(): string | null {
    return this.options.repo ?? null;
  }

  // Issue lists include pull requests, which are skipped.
  async findIssue(marker: string): Promise<GitHubIssue | null> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const issues = await this.request<GitHubIssue[]>('GET', `/issues?state=all&per_page=100&page=${page}`);
      const match = issues.find((issue) => !issue.pull_request && issue.body?.includes(marker));
      if (match) return match;
      if (issues.length < 100) return null;
    }
    throw new SourceError('unavailable', `${this.repo} has more than ${MAX_PAGES * 100} issues, so a duplicate cannot be ruled out.`);
  }

  createIssue(issue: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
    return this.request('POST', '/issues', issue);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new SourceError('config', 'Set GITHUB_TOKEN and GITHUB_REPO (owner/name) to file issues on GitHub.');
    }
    const response = await this.http.send(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-infra-filings-mcp',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A create that fails with 5xx may still have been saved, so it is never retried.
      // The next call finds the saved issue by its marker instead.
      retryDelay: method === 'GET' ? retryRead : retryRateLimit,
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 401) throw new SourceError('config', 'GitHub rejected GITHUB_TOKEN (401). Create a new token.');
    if (response.status === 403 || response.status === 404) {
      throw new SourceError('forbidden', `GitHub refused access to ${this.repo} (${response.status}). The token needs read and write access to issues on that repository.`);
    }
    if (response.status === 410) throw new SourceError('forbidden', `Issues are turned off for ${this.repo}.`);
    throw new SourceError('unavailable', `GitHub returned an error (${response.status}).`);
  }
}
