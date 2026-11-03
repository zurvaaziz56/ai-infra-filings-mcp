import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { SourceError } from './errors.js';
import { METRICS, type MetricId } from './metrics.js';
import type { DataIssueKind } from './normalize.js';

export interface DataIssueRow {
  cik: string;
  ticker: string;
  name: string;
  loaded_at: Date;
  metric: MetricId;
  kind: DataIssueKind;
  period_end: string | null;
  detail: string;
}

const KIND_SUMMARIES: Record<DataIssueKind, string> = {
  conflicting_filing: 'One filing reports a different value from the filings before and after it, which usually means a tagging error in that filing.',
  conflicting_quarter: "A 10-K's three-month Q4 value disagrees with FY − 9M YTD. The server publishes FY − 9M YTD.",
  mixed_restatement: 'A quarter cannot be derived, because one of the totals it needs was restated and the other was not.',
  off_calendar_period: "A reported period does not line up with the company's fiscal quarters.",
  missing_quarter: 'A quarter is neither reported nor derivable from year-to-date totals.',
  negative_derived_value: 'A quarter derived from year-to-date totals is negative for a metric that cannot be negative.',
  quarters_do_not_sum: 'The reported quarters do not add up to the year-to-date total.',
  no_mapped_tag: 'The company reports none of the tags mapped to this metric.',
};

// The key changes when a reload changes the issue's details, so a changed issue is a new one.
export function issueKey(issue: Pick<DataIssueRow, 'ticker' | 'metric' | 'kind' | 'period_end' | 'detail'>): string {
  const digest = createHash('sha256').update(issue.detail).digest('hex').slice(0, 8);
  return [issue.ticker, issue.metric, issue.kind, issue.period_end ?? 'none', digest].join('/');
}

export function issueMarker(key: string): string {
  return `<!-- ai-infra-filings-mcp data-issue: ${key} -->`;
}

export async function findDataIssue(db: Db, key: string): Promise<DataIssueRow> {
  const rows = await db.query<DataIssueRow>(
    `SELECT c.cik, c.ticker, c.name, c.loaded_at, d.metric, d.kind, d.period_end, d.detail
     FROM data_issues d JOIN companies c USING (cik) WHERE c.ticker = $1`,
    [key.split('/')[0]],
  );
  const issue = rows.find((row) => issueKey(row) === key);
  if (!issue) throw new SourceError('not_found', `No data issue has the key "${key}". Get current keys from list_data_issues.`);
  return issue;
}

export async function draftIssue(db: Db, issue: DataIssueRow): Promise<{ key: string; marker: string; title: string; body: string; labels: string[] }> {
  const key = issueKey(issue);
  const link = (accn: string) => `[${accn}](https://www.sec.gov/Archives/edgar/data/${Number(issue.cik)}/${accn.replaceAll('-', '')}/)`;
  const amount = (value: number) => value.toLocaleString('en-US');
  const cited = [...new Set(issue.detail.match(/\d{10}-\d{2}-\d{6}/g) ?? [])];
  const facts = issue.period_end
    ? await db.query<{ tag: string; period_start: string | null; period_end: string; value: number; form: string; filed: string; accn: string }>(
        `SELECT tag, period_start, period_end, value, form, filed, accn FROM raw_facts
         WHERE cik = $1 AND tag = ANY($2::text[]) AND unit = 'USD' AND period_end = $3::date ORDER BY filed, tag LIMIT 25`,
        [issue.cik, [...METRICS[issue.metric].tags], issue.period_end],
      )
    : [];
  const published = issue.period_end
    ? await db.query<{ fiscal_year: number; fiscal_period: string; period_start: string; period_end: string; value: number; derivation: string | null; revision: string }>(
        `SELECT fiscal_year, fiscal_period, period_start, period_end, value, derivation, revision FROM metric_values
         WHERE cik = $1 AND metric = $2 AND period_end = $3::date ORDER BY period_type`,
        [issue.cik, issue.metric, issue.period_end],
      )
    : [];

  const lines = [
    '## What was found',
    '',
    KIND_SUMMARIES[issue.kind],
    '',
    `> ${issue.detail}`,
    '',
    '| | |',
    '|---|---|',
    `| Company | ${issue.name} (${issue.ticker}, CIK ${issue.cik}) |`,
    `| Metric | \`${issue.metric}\`: ${METRICS[issue.metric].label} |`,
    `| Period end | ${issue.period_end ?? 'Not tied to one period'} |`,
    `| Found in the load of | ${issue.loaded_at.toISOString()} |`,
  ];
  if (cited.length > 0) lines.push('', '## Filings cited', '', ...cited.map((accn) => `- ${link(accn)}`));
  if (facts.length > 0) {
    lines.push(
      '', '## Facts for this period, as filed', '',
      '| Tag | Period | Value | Form | Filed | Filing |',
      '|---|---|---:|---|---|---|',
      ...facts.map((f) => `| \`${f.tag}\` | ${f.period_start ?? ''} to ${f.period_end} | ${amount(f.value)} | ${f.form} | ${f.filed} | ${link(f.accn)} |`),
    );
  }
  if (issue.period_end) {
    lines.push('', '## What the server publishes', '');
    if (published.length === 0) lines.push('Nothing for this period.');
    else {
      lines.push(
        '| Period | Dates | Value | How |',
        '|---|---|---:|---|',
        ...published.map((p) => `| FY${p.fiscal_year} ${p.fiscal_period} | ${p.period_start} to ${p.period_end} | ${amount(p.value)} | ${p.derivation ?? 'Reported'}${p.revision === 'none' ? '' : `, ${p.revision}`} |`),
      );
    }
  }
  lines.push('', '---', '_Filed by ai-infra-filings-mcp. Run `npm run load` again to see whether the issue is still there._', '', issueMarker(key));

  const when = issue.period_end ? `period ending ${issue.period_end}` : (issue.detail.match(/FY\d{4} Q[1-4]/)?.[0] ?? 'all periods');
  return {
    key,
    marker: issueMarker(key),
    title: `${issue.ticker} ${issue.metric}: ${issue.kind.replaceAll('_', ' ')} (${when})`,
    body: lines.join('\n'),
    labels: ['data-quality'],
  };
}
