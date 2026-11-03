import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadRole } from '../src/access.js';
import { AuditLog } from '../src/audit.js';
import { PROJECT_ROOT } from '../src/config.js';
import type { Db } from '../src/db.js';
import { GitHubClient, type GitHubClientOptions } from '../src/github-client.js';
import { SecClient } from '../src/sec-client.js';
import { invokeTool, type ServerDeps } from '../src/server.js';
import { TOOLS } from '../src/tools.js';
import { fakeClock, fakeGitHub, fixtureWarehouse, json, TEST_USER_AGENT } from './helpers.js';

const TOKEN = 'github_pat_test_value';
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

let db: Db;
let auditPath: string;
let oracleKey: string;

function deps(github: Partial<GitHubClientOptions> = {}, roleName = 'data_engineer'): ServerDeps {
  return {
    db,
    sec: new SecClient({ userAgent: TEST_USER_AGENT, fetch: async () => json({}, 503), clock: fakeClock() }),
    github: new GitHubClient({ token: TOKEN, repo: 'owner/data-issues', clock: fakeClock(), ...github }),
    role: loadRole(join(PROJECT_ROOT, 'config/roles.json'), roleName),
    audit: new AuditLog(auditPath),
  };
}

const file = (d: ServerDeps, confirm = true) => invokeTool(tool('file_data_issue'), { issue_key: oracleKey, confirm }, d);

beforeAll(async () => {
  db = await fixtureWarehouse();
  auditPath = join(await mkdtemp(join(tmpdir(), 'ai-infra-audit-')), 'audit.jsonl');
  const listed = await invokeTool(tool('list_data_issues'), { company: 'ORCL', kind: 'conflicting_quarter', limit: 100 }, deps());
  oracleKey = (listed.data as { issues: Array<{ key: string }> }).issues[0].key;
});

describe('filing data issues on GitHub', () => {
  it('drafts the issue with its evidence without contacting GitHub', async () => {
    const fetch = vi.fn(async () => json([]));
    const result = await file(deps({ token: undefined, fetch }), false);
    const data = result.data as { status: string; issue: { title: string; body: string } };
    expect(data.status).toBe('draft');
    expect(data.issue.title).toBe('ORCL revenue: conflicting quarter (period ending 2020-05-31)');
    expect(data.issue.body).toContain('[0001564590-22-023675](https://www.sec.gov/Archives/edgar/data/1341439/000156459022023675/)');
    expect(data.issue.body).toContain('| `Revenues` | 2020-03-01 to 2020-05-31 | 39,068,000,000 |');
    expect(data.issue.body).toContain('| FY2020 Q4 | 2020-03-01 to 2020-05-31 | 10,439,000,000 | FY − 9M YTD |');
    expect(data.issue.body).toContain(`<!-- ai-infra-filings-mcp data-issue: ${oracleKey} -->`);
    expect(result.sources[1]).toMatchObject({ name: 'github', status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('files an issue once and returns the same issue on the next call', async () => {
    const github = fakeGitHub();
    const first = await file(deps({ fetch: github.fetch }));
    const second = await file(deps({ fetch: github.fetch }));
    expect(first.data).toMatchObject({ status: 'filed', number: 1, url: 'https://github.com/owner/data-issues/issues/1' });
    expect(second.data).toMatchObject({ status: 'already_filed', number: 1 });
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]).toMatchObject({ labels: ['data-quality'] });
    expect(github.requests[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' });

    const lines = (await readFile(auditPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ tool: 'file_data_issue', outcome: 'ok', github_requests: 1 });
  });

  it('does not file twice when a create fails after GitHub saved the issue', async () => {
    const github = fakeGitHub();
    github.state.failNextCreateAfterSaving = true;
    const first = await file(deps({ fetch: github.fetch }));
    expect(first.data).toMatchObject({ status: 'not_filed', issue: { title: expect.any(String) } });
    expect(first.sources[1]).toMatchObject({ name: 'github', status: 'unavailable', detail: expect.stringContaining('502') });
    expect(github.requests.filter((r) => r.method === 'POST')).toHaveLength(1);

    const second = await file(deps({ fetch: github.fetch }));
    expect(second.data).toMatchObject({ status: 'already_filed', number: 1 });
    expect(github.issues).toHaveLength(1);
  });

  it('waits out a secondary rate limit, then files', async () => {
    const github = fakeGitHub();
    const clock = fakeClock();
    let limited = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!limited) {
        limited = true;
        return json({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '1' });
      }
      return github.fetch(input, init);
    };
    const result = await file(deps({ fetch, clock }));
    expect(result.data).toMatchObject({ status: 'filed' });
    expect(clock.slept).toContain(1000);
  });

  it('reports a rejected token without ever repeating it', async () => {
    const result = await file(deps({ fetch: async () => json({ message: 'Bad credentials' }, 401) }));
    expect(result.data).toMatchObject({ status: 'not_filed' });
    expect(result.sources[1].detail).toContain('GITHUB_TOKEN');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await readFile(auditPath, 'utf8')).not.toContain(TOKEN);
  });

  it('refuses analysts, even when called directly', async () => {
    const github = fakeGitHub();
    const result = await file(deps({ fetch: github.fetch }, 'analyst'));
    expect(result.error).toMatchObject({ code: 'forbidden' });
    expect(github.requests).toHaveLength(0);
  });
});
