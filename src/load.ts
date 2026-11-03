import type { Db } from './db.js';
import { SourceError } from './errors.js';
import { extractRawFacts, normalizeCompany } from './normalize.js';
import { padCik, type SecClient } from './sec-client.js';

export const COMPANIES = [
  'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL', 'AMD', 'AVGO', 'AAPL', 'CRM', 'PLTR', 'SNOW', 'CRWV', 'DELL', 'SMCI',
] as const;

export interface LoadResult {
  ticker: string;
  status: 'loaded' | 'failed';
  detail?: string;
  raw_facts?: number;
  metric_values?: number;
  data_issues?: number;
}

// Each company loads in its own transaction. A company that fails keeps its previous data,
// so one bad response never empties the warehouse.
export async function loadCompanies(db: Db, sec: SecClient, tickers: readonly string[], now = () => new Date()): Promise<LoadResult[]> {
  const tickerFile = Object.values(await sec.tickers());
  const results: LoadResult[] = [];
  for (const ticker of tickers) {
    const row = tickerFile.find((entry) => entry.ticker === ticker);
    if (!row) {
      results.push({ ticker, status: 'failed', detail: 'Not in the SEC ticker file.' });
      continue;
    }
    const cik = padCik(row.cik_str);
    try {
      const submissions = await sec.submissions(cik);
      const facts = await sec.companyFacts(cik);
      const fiscalYearEnd = submissions.fiscalYearEnd ?? '1231';
      const raw = extractRawFacts(facts);
      const { values, issues } = normalizeCompany(raw, fiscalYearEnd);

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO companies (cik, ticker, name, sic_description, fiscal_year_end, loaded_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (cik) DO UPDATE SET ticker = $2, name = $3, sic_description = $4, fiscal_year_end = $5, loaded_at = $6`,
          [cik, ticker, submissions.name, submissions.sicDescription ?? null, fiscalYearEnd, now().toISOString()],
        );
        for (const table of ['raw_facts', 'metric_values', 'data_issues']) {
          await tx.query(`DELETE FROM ${table} WHERE cik = $1`, [cik]);
        }
        await tx.query(
          `INSERT INTO raw_facts (cik, taxonomy, tag, unit, period_start, period_end, value, accn, fy, fp, form, filed, frame)
           SELECT $1, taxonomy, tag, unit, period_start, period_end, value, accn, fy, fp, form, filed, frame
           FROM jsonb_to_recordset($2::jsonb) AS r (taxonomy text, tag text, unit text, period_start date, period_end date,
             value double precision, accn text, fy integer, fp text, form text, filed date, frame text)`,
          [cik, JSON.stringify(raw)],
        );
        await tx.query(
          `INSERT INTO metric_values (cik, metric, period_type, fiscal_year, fiscal_period, period_start, period_end,
             calendar_period, value, derived, derivation, revision, warnings, sources)
           SELECT $1, metric, period_type, fiscal_year, fiscal_period, period_start, period_end,
             calendar_period, value, derived, derivation, revision, warnings, sources
           FROM jsonb_to_recordset($2::jsonb) AS r (metric text, period_type text, fiscal_year integer, fiscal_period text,
             period_start date, period_end date, calendar_period text, value double precision, derived boolean,
             derivation text, revision text, warnings jsonb, sources jsonb)`,
          [cik, JSON.stringify(values)],
        );
        await tx.query(
          `INSERT INTO data_issues (cik, metric, kind, period_end, detail)
           SELECT $1, metric, kind, period_end, detail
           FROM jsonb_to_recordset($2::jsonb) AS r (metric text, kind text, period_end date, detail text)`,
          [cik, JSON.stringify(issues)],
        );
      });
      results.push({ ticker, status: 'loaded', raw_facts: raw.length, metric_values: values.length, data_issues: issues.length });
    } catch (error) {
      results.push({ ticker, status: 'failed', detail: error instanceof SourceError ? error.message : 'Unexpected error while loading.' });
      if (!(error instanceof SourceError)) console.error(error);
    }
  }
  return results;
}
