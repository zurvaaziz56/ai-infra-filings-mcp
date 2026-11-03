import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRole } from '../src/access.js';
import { AuditLog } from '../src/audit.js';
import { PROJECT_ROOT } from '../src/config.js';
import { type Db, deferredDb } from '../src/db.js';
import { GitHubClient } from '../src/github-client.js';
import { loadCompanies } from '../src/load.js';
import { SecClient } from '../src/sec-client.js';
import { buildServer, invokeTool, type ServerDeps } from '../src/server.js';
import { TOOLS } from '../src/tools.js';
import { fakeClock, fixtureFetch, fixtureWarehouse, json, TEST_USER_AGENT } from './helpers.js';

let db: Db;
let auditPath: string;

const healthySec = () => new SecClient({ userAgent: TEST_USER_AGENT, fetch: fixtureFetch(), clock: fakeClock() });
const downSec = () => new SecClient({ userAgent: TEST_USER_AGENT, fetch: async () => json({}, 503), clock: fakeClock(), maxRetries: 0 });

beforeAll(async () => {
  db = await fixtureWarehouse();
  auditPath = join(await mkdtemp(join(tmpdir(), 'ai-infra-audit-')), 'audit.jsonl');
});

function depsFor(roleName: string, sec = healthySec()): ServerDeps {
  return {
    db,
    sec,
    github: new GitHubClient({ token: undefined, repo: undefined }),
    role: loadRole(join(PROJECT_ROOT, 'config/roles.json'), roleName),
    audit: new AuditLog(auditPath),
  };
}

async function connect(roleName: string, sec = healthySec()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(depsFor(roleName, sec)).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError, text, body: text.startsWith('{') ? JSON.parse(text) : null };
  };
  return { client, call };
}

async function lastAuditEntry() {
  const lines = (await readFile(auditPath, 'utf8')).trim().split('\n');
  return { raw: lines[lines.length - 1], entry: JSON.parse(lines[lines.length - 1]) };
}

describe('access control', () => {
  it('lists only the tools a role was given', async () => {
    const names = async (role: string) => (await (await connect(role)).client.listTools()).tools.map((tool) => tool.name).sort();
    expect(await names('viewer')).toEqual(['compare_metric', 'get_company', 'get_metric', 'source_status']);
    expect(await names('analyst')).not.toContain('file_data_issue');
    expect(await names('data_engineer')).toEqual(expect.arrayContaining(['search_filings', 'get_raw_facts', 'list_data_issues', 'file_data_issue']));
  });

  it('lists its tools before the database has opened', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer({ ...depsFor('viewer'), db: deferredDb(new Promise(() => {})) }).connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(4);
  });

  it('refuses a tool outside the role, even when called directly', async () => {
    const { call } = await connect('viewer');
    expect(await call('search_filings', { query: 'Anthropic' })).toMatchObject({ isError: true, text: expect.stringContaining('not found') });

    const rawFacts = TOOLS.find((tool) => tool.name === 'get_raw_facts')!;
    const result = await invokeTool(rawFacts, { company: 'NVDA' }, depsFor('viewer'));
    expect(result).toMatchObject({ data: null, error: { code: 'forbidden' } });
    expect((await lastAuditEntry()).entry).toMatchObject({ role: 'viewer', tool: 'get_raw_facts', outcome: 'denied' });
  });
});

describe('answers', () => {
  it('names the filing behind every number', async () => {
    const { call } = await connect('analyst');
    const { body } = await call('get_metric', { company: 'nvda', metric: 'capex', limit: 50 });
    expect(body.data.values.length).toBeGreaterThan(5);
    for (const value of body.data.values) {
      expect(value.sources.length).toBeGreaterThan(0);
      for (const source of value.sources) {
        expect(source).toMatchObject({ accn: expect.stringMatching(/^\d{10}-\d{2}-\d{6}$/), form: expect.any(String), filed: expect.any(String), tag: expect.any(String) });
      }
    }
  });

  it('lines companies up by calendar quarter and leaves gaps empty', async () => {
    const { call } = await connect('analyst');
    const { body } = await call('compare_metric', { companies: ['NVDA', 'MSFT'], metric: 'capex', calendar_periods: ['CY2021Q4', 'CY2025Q2'] });
    const [q4, q2] = body.data.periods;
    expect(q4.values.NVDA).toMatchObject({ value: 273_000_000, fiscal_period: 'FY2022 Q4', derived: true });
    expect(q2.values.MSFT).toMatchObject({ value: 17_079_000_000, fiscal_period: 'FY2025 Q4', period_start: '2025-04-01', period_end: '2025-06-30' });
    expect(q2.values.NVDA).toBeNull();
    expect(q2.values.MSFT.sources[0].accn).toMatch(/^\d{10}-\d{2}-\d{6}$/);
  });

  it('returns full-text search hits as filing links', async () => {
    const { call } = await connect('analyst');
    const { body } = await call('search_filings', { query: 'Anthropic', forms: ['10-K', '10-Q'] });
    expect(body.data.total).toBe(109);
    expect(body.data.results[0].accession).toMatch(/^\d{10}-\d{2}-\d{6}$/);
    expect(body.data.results[0].link).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1018724\/\d{18}\/amzn-\d{8}\.htm$/);
  });
});

describe('degradation', () => {
  it('answers from the warehouse, marked stale, when the SEC is down', async () => {
    const { call } = await connect('analyst', downSec());
    const company = await call('get_company', { company: 'NVDA' });
    expect(company.body.data).toMatchObject({ name: 'NVIDIA CORP', recent_filings: null });
    expect(company.body.sources).toEqual([
      expect.objectContaining({ name: 'warehouse', status: 'stale', as_of: expect.any(String) }),
      expect.objectContaining({ name: 'sec_live', status: 'unavailable' }),
    ]);

    const metric = await call('get_metric', { company: 'NVDA', metric: 'capex', live: true });
    expect(metric.isError).toBeFalsy();
    expect(metric.body.data.values.length).toBeGreaterThan(0);
    expect(metric.body.sources[0]).toMatchObject({ name: 'warehouse', status: 'stale' });
  });

  it('reports search as unavailable instead of failing', async () => {
    const { call } = await connect('analyst', downSec());
    const { isError, body } = await call('search_filings', { query: 'Anthropic' });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({ data: null, sources: [{ name: 'sec_live', status: 'unavailable' }] });
  });

  it('keeps the previous data when a company fails to reload', async () => {
    const working = fixtureFetch();
    const failing: typeof fetch = async (input, init) => (String(input).includes('/companyfacts/') ? json({}, 503) : working(input, init));
    const [result] = await loadCompanies(db, new SecClient({ userAgent: TEST_USER_AGENT, fetch: failing, clock: fakeClock(), maxRetries: 0 }), ['NVDA']);
    expect(result.status).toBe('failed');
    const { body } = await (await connect('analyst')).call('get_metric', { company: 'NVDA', metric: 'capex' });
    expect(body.data.values.length).toBeGreaterThan(0);
  });
});

describe('audit log', () => {
  it('writes one line per call with the SEC requests it made, and no arguments', async () => {
    const { call } = await connect('analyst');
    await call('get_company', { company: 'NVDA' });
    const { raw, entry } = await lastAuditEntry();
    expect(entry).toMatchObject({ role: 'analyst', tool: 'get_company', outcome: 'ok', sec_requests: 1, github_requests: 0, args_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(raw).not.toContain('NVDA');
  });
});
