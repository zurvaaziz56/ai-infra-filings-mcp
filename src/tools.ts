import { z } from 'zod';
import type { Role } from './access.js';
import type { Db } from './db.js';
import { SourceError } from './errors.js';
import { METRIC_IDS, METRICS } from './metrics.js';
import { DATA_ISSUE_KINDS, extractRawFacts, type MetricValue, normalizeMetric, PERIODIC_FORMS, tagUsage } from './normalize.js';
import type { SecClient, Submissions } from './sec-client.js';

export interface SourceStatus {
  name: 'warehouse' | 'sec_live';
  status: 'ok' | 'stale' | 'unavailable';
  detail?: string;
  as_of?: string | null;
}

export interface ToolResult {
  data: unknown;
  sources: SourceStatus[];
  error?: { code: string; message: string };
}

export interface ToolContext {
  db: Db;
  sec: SecClient;
  role: Role;
}

export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<ToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(tool: Tool<Shape>): Tool {
  return tool as unknown as Tool;
}

interface CompanyRow {
  cik: string;
  ticker: string;
  name: string;
  sic_description: string | null;
  fiscal_year_end: string;
  loaded_at: Date;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const companyArg = z.string().min(1).max(100).describe('Ticker, CIK, or part of the company name, for example "NVDA".');

async function findCompany(db: Db, query: string): Promise<CompanyRow> {
  const text = query.trim();
  const rows = await db.query<CompanyRow>(
    `SELECT * FROM companies
     WHERE upper(ticker) = upper($1) OR cik = lpad($1, 10, '0') OR name ILIKE '%' || $1 || '%'
     ORDER BY upper(ticker) = upper($1) DESC, ticker LIMIT 5`,
    [text],
  );
  if (rows.length === 0) throw new SourceError('not_found', `No loaded company matches "${text}".`);
  if (rows.length > 1 && rows[0].ticker.toUpperCase() !== text.toUpperCase()) {
    throw new SourceError('not_found', `"${text}" matches ${rows.map((row) => row.ticker).join(', ')}. Use a ticker.`);
  }
  return rows[0];
}

function warehouseSource(company: CompanyRow, status: SourceStatus['status'] = 'ok'): SourceStatus {
  return {
    name: 'warehouse',
    status,
    as_of: company.loaded_at.toISOString(),
    ...(status === 'stale' ? { detail: 'The SEC could not be reached, so this answer comes from the last load.' } : {}),
  };
}

async function tryLive<T>(request: () => Promise<T>): Promise<{ value: T | null; source: SourceStatus }> {
  try {
    return { value: await request(), source: { name: 'sec_live', status: 'ok', as_of: new Date().toISOString() } };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return { value: null, source: { name: 'sec_live', status: 'unavailable', detail: error.message } };
  }
}

function companySummary(company: CompanyRow) {
  return { ticker: company.ticker, name: company.name, cik: company.cik };
}

function filingLink(cik: string, accession: string, document: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${document}`;
}

function periodicFilings(submissions: Submissions, cik: string, limit: number) {
  const recent = submissions.filings.recent;
  return recent.form
    .map((form, i) => ({
      form,
      filed: recent.filingDate[i],
      period: recent.reportDate[i],
      accession: recent.accessionNumber[i],
      link: filingLink(cik, recent.accessionNumber[i], recent.primaryDocument[i]),
    }))
    .filter((filing) => PERIODIC_FORMS.has(filing.form))
    .slice(0, limit);
}

async function warehouseValues(db: Db, cik: string, metric: string): Promise<MetricValue[]> {
  return db.query<MetricValue>(
    `SELECT metric, period_type, fiscal_year, fiscal_period, period_start, period_end, calendar_period, value,
       derived, derivation, revision, warnings, sources
     FROM metric_values WHERE cik = $1 AND metric = $2 ORDER BY period_end, period_type`,
    [cik, metric],
  );
}

function presentValue({ metric: _metric, ...value }: MetricValue) {
  return value;
}

const getCompany = defineTool({
  name: 'get_company',
  title: 'Get company',
  description: 'Identify a loaded company and list its latest 10-K and 10-Q filings with links.',
  inputSchema: { company: companyArg },
  handler: async (args, ctx) => {
    const company = await findCompany(ctx.db, args.company);
    const live = await tryLive(() => ctx.sec.submissions(company.cik));
    return {
      data: {
        ...companySummary(company),
        industry: company.sic_description,
        fiscal_year_end: company.fiscal_year_end,
        recent_filings: live.value ? periodicFilings(live.value, company.cik, 6) : null,
      },
      sources: [warehouseSource(company, live.value ? 'ok' : 'stale'), live.source],
    };
  },
});

const getMetric = defineTool({
  name: 'get_metric',
  title: 'Get metric',
  description:
    'Quarterly or annual values of one metric for one company. Each value lists the filings it came from, ' +
    'whether it was derived from year-to-date totals, and whether it was later restated.',
  inputSchema: {
    company: companyArg,
    metric: z.enum(METRIC_IDS),
    period_type: z.enum(['quarter', 'year']).default('quarter'),
    from: isoDate.optional().describe('Earliest period end date to include.'),
    to: isoDate.optional().describe('Latest period end date to include.'),
    limit: z.number().int().min(1).max(200).default(12).describe('Return the latest N values in the range.'),
    live: z.boolean().default(false).describe('Rebuild the values from the SEC now. Falls back to the warehouse if the SEC is unavailable.'),
  },
  handler: async (args, ctx) => {
    const company = await findCompany(ctx.db, args.company);
    let values: MetricValue[];
    let sources: SourceStatus[];
    const live = args.live ? await tryLive(() => ctx.sec.companyFacts(company.cik)) : null;
    if (live?.value) {
      values = normalizeMetric(extractRawFacts(live.value), args.metric, company.fiscal_year_end).values;
      sources = [live.source];
    } else {
      values = await warehouseValues(ctx.db, company.cik, args.metric);
      sources = live ? [warehouseSource(company, 'stale'), live.source] : [warehouseSource(company)];
    }
    const selected = values
      .filter((value) => value.period_type === args.period_type)
      .filter((value) => (!args.from || value.period_end >= args.from) && (!args.to || value.period_end <= args.to))
      .slice(-args.limit);
    return {
      data: {
        company: companySummary(company),
        metric: args.metric,
        label: METRICS[args.metric].label,
        unit: 'USD',
        tag_usage: tagUsage(values),
        values: selected.map(presentValue),
        ...(values.length === 0 ? { note: `${company.ticker} reports no facts under ${METRICS[args.metric].tags.join(', ')}.` } : {}),
      },
      sources,
    };
  },
});

const compareMetric = defineTool({
  name: 'compare_metric',
  title: 'Compare metric',
  description:
    'Compare one metric across companies for the same calendar quarters (CY2025Q2) or years (CY2025). ' +
    'Fiscal periods are mapped to calendar periods, so companies with different fiscal years line up.',
  inputSchema: {
    companies: z.array(companyArg).min(1).max(15),
    metric: z.enum(METRIC_IDS),
    calendar_periods: z.array(z.string().regex(/^CY\d{4}(Q[1-4])?$/, 'Use CY2025Q2 or CY2025.')).min(1).max(12),
  },
  handler: async (args, ctx) => {
    const companies = await Promise.all(args.companies.map((query) => findCompany(ctx.db, query)));
    const rows = await ctx.db.query<MetricValue & { cik: string }>(
      `SELECT cik, period_type, fiscal_year, fiscal_period, calendar_period, value, derived, revision, warnings, sources
       FROM metric_values WHERE cik = ANY($1::text[]) AND metric = $2 AND calendar_period = ANY($3::text[])`,
      [companies.map((company) => company.cik), args.metric, args.calendar_periods],
    );
    const table = args.calendar_periods.map((period) => ({
      calendar_period: period,
      values: Object.fromEntries(
        companies.map((company) => {
          const periodType = period.includes('Q') ? 'quarter' : 'year';
          const row = rows.find((r) => r.cik === company.cik && r.calendar_period === period && r.period_type === periodType);
          return [
            company.ticker,
            row
              ? {
                  value: row.value,
                  fiscal_period: `FY${row.fiscal_year} ${row.fiscal_period}`,
                  derived: row.derived,
                  revision: row.revision,
                  warnings: row.warnings,
                  sources: row.sources,
                }
              : null,
          ];
        }),
      ),
    }));
    const oldest = companies.reduce((a, b) => (a.loaded_at < b.loaded_at ? a : b));
    return {
      data: { metric: args.metric, label: METRICS[args.metric].label, unit: 'USD', periods: table },
      sources: [warehouseSource(oldest)],
    };
  },
});

const searchFilings = defineTool({
  name: 'search_filings',
  title: 'Search filings',
  description:
    'Live full-text search of SEC filings since 2001, across all companies. Put phrases in double quotes. ' +
    'Returns links, not filing text.',
  inputSchema: {
    query: z.string().min(2).max(200).describe('For example "Anthropic" or "\\"GPU capacity\\"".'),
    forms: z.array(z.string().regex(/^[0-9A-Z/-]{1,10}$/)).max(10).optional().describe('For example ["10-K", "10-Q"].'),
    from: isoDate.optional(),
    to: isoDate.optional(),
    offset: z.number().int().min(0).max(9_900).default(0),
  },
  handler: async (args, ctx) => {
    const live = await tryLive(() => ctx.sec.searchFilings(args));
    if (!live.value) return { data: null, sources: [live.source] };
    return {
      data: {
        total: live.value.hits.total.value,
        offset: args.offset,
        results: live.value.hits.hits.map((hit) => ({
          company: hit._source.display_names[0] ?? null,
          cik: hit._source.ciks[0] ?? null,
          form: hit._source.form,
          filed: hit._source.file_date,
          period_ending: hit._source.period_ending ?? null,
          link: filingLink(hit._source.ciks[0] ?? '0', hit._source.adsh, hit._id.split(':')[1] ?? ''),
        })),
      },
      sources: [live.source],
    };
  },
});

const sourceStatus = defineTool({
  name: 'source_status',
  title: 'Source status',
  description: 'Health of the warehouse and the SEC connection, and what this role may do. Makes no SEC request.',
  inputSchema: {},
  handler: async (_args, ctx) => {
    let warehouse: SourceStatus;
    let counts: Record<string, unknown> | null = null;
    try {
      const [row] = await ctx.db.query<{ companies: number; oldest: Date | null; newest: Date | null }>(
        `SELECT count(*)::int AS companies, min(loaded_at) AS oldest, max(loaded_at) AS newest,
           (SELECT count(*)::int FROM metric_values) AS metric_values,
           (SELECT count(*)::int FROM data_issues) AS data_issues
         FROM companies`,
      );
      counts = row;
      warehouse = row.companies > 0
        ? { name: 'warehouse', status: 'ok', as_of: row.oldest?.toISOString() ?? null }
        : { name: 'warehouse', status: 'unavailable', detail: 'The warehouse is empty. Run npm run load.' };
    } catch {
      warehouse = { name: 'warehouse', status: 'unavailable', detail: 'The warehouse cannot be queried. Run npm run load, or check DATABASE_URL.' };
    }
    const circuit = ctx.sec.breaker.state();
    const live: SourceStatus = !ctx.sec.userAgentConfigured
      ? { name: 'sec_live', status: 'unavailable', detail: 'SEC_USER_AGENT is not set, so live requests are disabled.' }
      : circuit === 'open'
        ? { name: 'sec_live', status: 'unavailable', detail: 'Paused after repeated SEC failures.' }
        : { name: 'sec_live', status: 'ok', detail: 'Based on recent requests. This call does not contact the SEC.' };
    return {
      data: {
        role: ctx.role.name,
        allowed_tools: ctx.role.tools,
        warehouse: counts,
        sec: {
          circuit,
          sec_requests_per_minute: ctx.role.sec_requests_per_minute,
          budget_remaining: ctx.sec.budget?.available() ?? null,
        },
      },
      sources: [warehouse, live],
    };
  },
});

const getRawFacts = defineTool({
  name: 'get_raw_facts',
  title: 'Get raw facts',
  description:
    'Facts exactly as the SEC returned them, before de-duplication. Note that fy and fp describe the filing ' +
    'that reported a fact, not the period the fact covers.',
  inputSchema: {
    company: companyArg,
    metric: z.enum(METRIC_IDS).optional(),
    tag: z.string().regex(/^[A-Za-z]+$/).optional(),
    period_end: isoDate.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  },
  handler: async (args, ctx) => {
    const company = await findCompany(ctx.db, args.company);
    const tags = args.tag ? [args.tag] : args.metric ? [...METRICS[args.metric].tags] : null;
    const facts = await ctx.db.query(
      `SELECT tag, unit, period_start, period_end, value, accn, form, filed, fy, fp, frame FROM raw_facts
       WHERE cik = $1 AND ($2::text[] IS NULL OR tag = ANY($2::text[])) AND ($3::date IS NULL OR period_end = $3::date)
       ORDER BY period_end DESC, filed DESC LIMIT $4`,
      [company.cik, tags, args.period_end ?? null, args.limit],
    );
    return { data: { company: companySummary(company), facts }, sources: [warehouseSource(company)] };
  },
});

const listDataIssues = defineTool({
  name: 'list_data_issues',
  title: 'List data issues',
  description: 'Problems found in the SEC data while loading, such as conflicting filings, restatements, and gaps.',
  inputSchema: {
    company: companyArg.optional(),
    metric: z.enum(METRIC_IDS).optional(),
    kind: z.enum(DATA_ISSUE_KINDS).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  },
  handler: async (args, ctx) => {
    const company = args.company ? await findCompany(ctx.db, args.company) : null;
    const filters = [company?.cik ?? null, args.metric ?? null, args.kind ?? null];
    const where = `($1::text IS NULL OR d.cik = $1) AND ($2::text IS NULL OR d.metric = $2) AND ($3::text IS NULL OR d.kind = $3)`;
    const issues = await ctx.db.query(
      `SELECT c.ticker, d.metric, d.kind, d.period_end, d.detail FROM data_issues d JOIN companies c USING (cik)
       WHERE ${where} ORDER BY c.ticker, d.metric, d.period_end NULLS LAST LIMIT $4`,
      [...filters, args.limit],
    );
    const counts = await ctx.db.query(
      `SELECT d.kind, count(*)::int AS count FROM data_issues d WHERE ${where} GROUP BY d.kind ORDER BY count DESC`,
      filters,
    );
    const [loaded] = await ctx.db.query<{ oldest: Date | null }>('SELECT min(loaded_at) AS oldest FROM companies');
    return {
      data: { counts, issues },
      sources: [{ name: 'warehouse', status: 'ok', as_of: loaded?.oldest?.toISOString() ?? null }],
    };
  },
});

export const TOOLS: Tool[] = [getCompany, getMetric, compareMetric, searchFilings, sourceStatus, getRawFacts, listDataIssues];
