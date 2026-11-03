import { describe, expect, it } from 'vitest';
import type { MetricId } from '../src/metrics.js';
import { extractRawFacts, fiscalPosition, type MetricValue, normalizeMetric, quartersSpanned, tagUsage } from '../src/normalize.js';
import type { CompanyFacts } from '../src/sec-client.js';
import { fixture } from './helpers.js';

function rawFacts(ticker: string) {
  return extractRawFacts(fixture<CompanyFacts>(`${ticker}-companyfacts.json`));
}

function normalize(ticker: string, metric: MetricId) {
  return normalizeMetric(rawFacts(ticker), metric, fixture<{ fiscalYearEnd: string }>(`${ticker}-submissions.json`).fiscalYearEnd);
}

function period(values: MetricValue[], fiscalYear: number, fiscalPeriod: string) {
  return values.find((value) => value.fiscal_year === fiscalYear && value.fiscal_period === fiscalPeriod);
}

describe('metric mapping', () => {
  it("follows NVIDIA's capex across its 2020 tag switch", () => {
    const { values } = normalize('nvda', 'capex');
    expect(period(values, 2020, 'Q1')).toMatchObject({ value: 128_000_000, sources: [{ tag: 'PaymentsToAcquirePropertyPlantAndEquipment' }] });
    expect(period(values, 2021, 'Q1')).toMatchObject({ value: 155_000_000, sources: [{ tag: 'PaymentsToAcquireProductiveAssets' }] });
    expect(tagUsage(values)).toEqual([
      { tag: 'PaymentsToAcquirePropertyPlantAndEquipment', first_period_end: '2019-04-28', last_period_end: '2019-07-28' },
      { tag: 'PaymentsToAcquireProductiveAssets', first_period_end: '2019-10-27', last_period_end: '2022-01-30' },
    ]);
  });

  it('reports quarters it cannot fill instead of guessing', () => {
    const { values, issues } = normalize('nvda', 'capex');
    expect(period(values, 2021, 'Q4')).toBeUndefined();
    expect(issues.filter((issue) => issue.kind === 'missing_quarter').map((issue) => issue.detail)).toEqual([
      'No reported or derivable value for FY2020 Q4.',
      'No reported or derivable value for FY2021 Q4.',
    ]);
  });
});

describe('duplicate rule', () => {
  it('takes the latest filing, amendments included, and keeps the first-reported value', () => {
    const { values } = normalize('smci', 'operating_income');
    expect(period(values, 2016, 'Q1')).toMatchObject({
      value: 25_205_000,
      revision: 'restated',
      sources: [{ form: '10-Q/A', filed: '2019-05-17', first_reported: { value: 21_440_000, filed: '2015-11-16' } }],
    });
  });

  it('flags a filing that disagrees with the filings before and after it', () => {
    const { values, issues } = normalize('nvda', 'revenue');
    expect(period(values, 2018, 'Q2')?.value).toBe(2_230_000_000);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'conflicting_filing', detail: expect.stringContaining('0001045810-18-000010 (filed 2018-02-28) reports 2230000000') }),
    );
  });

  it('treats a change of rounding as rounding, not a restatement', () => {
    const { values } = normalize('crwv', 'revenue');
    expect(period(values, 2025, 'Q1')).toMatchObject({ value: 982_000_000, revision: 'rounding', sources: [{ first_reported: { value: 981_632_000 } }] });
    expect(period(values, 2025, 'Q2')?.revision).toBe('rounding');
  });
});

describe('calendar alignment', () => {
  it('derives quarters from year-to-date totals and says how', () => {
    const { values } = normalize('msft', 'capex');
    expect(period(values, 2025, 'Q4')).toMatchObject({ value: 17_079_000_000, derived: true, derivation: 'FY − 9M YTD', calendar_period: 'CY2025Q2' });
    expect(period(values, 2025, 'Q4')?.sources.map((source) => source.form)).toEqual(['10-K', '10-Q']);
  });

  it("trusts FY − 9M YTD over a Q4 that Oracle's 10-K tagged with the full year", () => {
    const { values, issues } = normalize('orcl', 'revenue');
    expect(period(values, 2020, 'Q4')).toMatchObject({ value: 10_439_000_000, derived: true });
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'conflicting_quarter', detail: expect.stringContaining('reports 39068000000') }));
  });

  it('never subtracts a restated total from one that was not restated', () => {
    const { values, issues } = normalize('dell', 'rd_expense');
    expect(period(values, 2021, 'FY')?.revision).toBe('restated');
    expect(period(values, 2021, 'Q4')).toBeUndefined();
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'mixed_restatement' }));
  });

  it('assigns the same calendar periods as the SEC frames API', () => {
    let compared = 0;
    for (const [ticker, metric] of [['nvda', 'capex'], ['nvda', 'revenue'], ['orcl', 'revenue'], ['msft', 'capex'], ['smci', 'operating_income'], ['dell', 'rd_expense']] as const) {
      const raw = rawFacts(ticker);
      for (const value of normalize(ticker, metric).values.filter((v) => !v.derived)) {
        const [source] = value.sources;
        const fact = raw.find((f) => f.accn === source.accn && f.tag === source.tag && f.period_start === source.period_start && f.period_end === source.period_end);
        if (fact?.frame) {
          expect(`${ticker} ${value.calendar_period}`).toBe(`${ticker} ${fact.frame}`);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(period(normalize('msft', 'capex').values, 2025, 'FY')?.calendar_period).toBe('CY2025');
  });

  it('places 52/53-week periods in the right fiscal quarter', () => {
    expect(fiscalPosition('2024-02-02', '0129')).toEqual({ fiscalYear: 2024, quarter: 4 });
    expect(fiscalPosition('2023-12-30', '1226')).toEqual({ fiscalYear: 2023, quarter: 4 });
    expect(fiscalPosition('2025-10-26', '0131')).toEqual({ fiscalYear: 2026, quarter: 3 });
    expect(fiscalPosition('2020-03-31', '0131')).toBeNull();
    expect(quartersSpanned('2024-01-29', '2025-01-26')).toBe(4);
    expect(quartersSpanned('2016-09-07', '2016-10-28')).toBeNull();
  });
});
