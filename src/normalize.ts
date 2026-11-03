import { CANDIDATE_TAGS, METRIC_IDS, METRICS, type MetricId } from './metrics.js';
import type { CompanyFacts } from './sec-client.js';

export const PERIODIC_FORMS: ReadonlySet<string> = new Set(['10-K', '10-Q', '10-K/A', '10-Q/A']);

const DAY_MS = 86_400_000;
const QUARTER_DAYS = 91.31;

export interface RawFact {
  taxonomy: string;
  tag: string;
  unit: string;
  period_start: string | null;
  period_end: string;
  value: number;
  accn: string;
  fy: number | null;
  fp: string | null;
  form: string;
  filed: string;
  frame: string | null;
}

export type Revision = 'none' | 'rounding' | 'restated';

export interface FactSource {
  tag: string;
  accn: string;
  form: string;
  filed: string;
  period_start: string;
  period_end: string;
  value: number;
  first_reported?: { value: number; accn: string; filed: string };
}

export interface MetricValue {
  metric: MetricId;
  period_type: 'quarter' | 'year';
  fiscal_year: number;
  fiscal_period: string;
  period_start: string;
  period_end: string;
  calendar_period: string;
  value: number;
  derived: boolean;
  derivation: string | null;
  revision: Revision;
  warnings: string[];
  sources: FactSource[];
}

export const DATA_ISSUE_KINDS = [
  'conflicting_filing',
  'conflicting_quarter',
  'mixed_restatement',
  'off_calendar_period',
  'missing_quarter',
  'negative_derived_value',
  'quarters_do_not_sum',
  'no_mapped_tag',
] as const;

export type DataIssueKind = (typeof DATA_ISSUE_KINDS)[number];

export interface DataIssue {
  metric: MetricId;
  kind: DataIssueKind;
  period_end: string | null;
  detail: string;
}

interface Winner {
  fact: RawFact & { period_start: string };
  revision: Revision;
  sources: FactSource[];
}

export function extractRawFacts(companyFacts: CompanyFacts): RawFact[] {
  const usGaap = companyFacts.facts['us-gaap'] ?? {};
  const rows: RawFact[] = [];
  for (const tag of CANDIDATE_TAGS) {
    for (const [unit, facts] of Object.entries(usGaap[tag]?.units ?? {})) {
      for (const fact of facts) {
        rows.push({
          taxonomy: 'us-gaap',
          tag,
          unit,
          period_start: fact.start ?? null,
          period_end: fact.end,
          value: fact.val,
          accn: fact.accn,
          fy: fact.fy ?? null,
          fp: fact.fp ?? null,
          form: fact.form,
          filed: fact.filed,
          frame: fact.frame ?? null,
        });
      }
    }
  }
  return rows;
}

// One value per period: the most recently filed fact wins, across every candidate tag.
// Ties go to the tag listed first in the metric map. The SEC's frames API uses the same
// "last filed" rule.
export function pickWinners(facts: RawFact[], metric: MetricId, issues: DataIssue[]): Winner[] {
  const tags: readonly string[] = METRICS[metric].tags;
  const groups = new Map<string, Winner['fact'][]>();
  for (const fact of facts) {
    if (fact.unit !== 'USD' || fact.period_start === null || !PERIODIC_FORMS.has(fact.form) || !tags.includes(fact.tag)) continue;
    const key = `${fact.period_start}/${fact.period_end}`;
    groups.set(key, [...(groups.get(key) ?? []), fact as Winner['fact']]);
  }

  const priority = (fact: RawFact) => tags.indexOf(fact.tag);
  const winners: Winner[] = [];
  for (const group of groups.values()) {
    const oldestFirst = [...group].sort((a, b) => a.filed.localeCompare(b.filed) || priority(a) - priority(b));
    const newestFirst = [...group].sort((a, b) => b.filed.localeCompare(a.filed) || priority(a) - priority(b) || b.accn.localeCompare(a.accn));
    const winner = newestFirst[0];
    const first = oldestFirst[0];

    if (sameAfterRounding(first.value, winner.value)) {
      for (const middle of oldestFirst.filter((fact) => fact !== first && fact !== winner)) {
        if (!sameAfterRounding(middle.value, winner.value)) {
          issues.push({
            metric,
            kind: 'conflicting_filing',
            period_end: winner.period_end,
            detail: `${middle.form} ${middle.accn} (filed ${middle.filed}) reports ${middle.value} under ${middle.tag} for ${middle.period_start} to ${middle.period_end}, but earlier and later filings report ${winner.value}.`,
          });
        }
      }
    }

    const revision: Revision =
      first.value === winner.value ? 'none' : sameAfterRounding(first.value, winner.value) ? 'rounding' : 'restated';
    const source: FactSource = {
      tag: winner.tag,
      accn: winner.accn,
      form: winner.form,
      filed: winner.filed,
      period_start: winner.period_start,
      period_end: winner.period_end,
      value: winner.value,
      ...(revision === 'none' ? {} : { first_reported: { value: first.value, accn: first.accn, filed: first.filed } }),
    };
    winners.push({ fact: winner, revision, sources: [source] });
  }
  return winners;
}

// Filers often report a number in dollars or thousands one year and in millions the next.
// Comparatives in millions are sometimes derived rather than rounded (CoreWeave's Q2 2025
// revenue went from 1,212,788,000 to 1,212,000,000), so anything within one step counts.
function sameAfterRounding(a: number, b: number): boolean {
  return Math.abs(a - b) < Math.max(roundingStep(a), roundingStep(b));
}

function roundingStep(value: number): number {
  if (value % 1_000_000 === 0) return 1_000_000;
  return value % 1_000 === 0 ? 1_000 : 1;
}

// A difference of two rounded figures can be off by up to two rounding steps.
function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= 2 * Math.max(roundingStep(a), roundingStep(b));
}

function isRestated(part: { revision: Revision }): boolean {
  return part.revision === 'restated';
}

export function quartersSpanned(start: string, end: string): number | null {
  const days = (toMs(end) - toMs(start)) / DAY_MS + 1;
  const quarters = Math.round(days / QUARTER_DAYS);
  return quarters >= 1 && quarters <= 4 && Math.abs(days - quarters * QUARTER_DAYS) <= 12 ? quarters : null;
}

// fiscalYearEnd is the SEC's MMDD value. Companies on 52/53-week years end within a few
// days of it, so the match allows 10 days after the nominal date.
export function fiscalPosition(end: string, fiscalYearEnd: string): { fiscalYear: number; quarter: number } | null {
  const endMs = toMs(end);
  const month = Number(fiscalYearEnd.slice(0, 2)) - 1;
  const day = Number(fiscalYearEnd.slice(2));
  const year = new Date(endMs).getUTCFullYear();
  for (let fiscalYear = year - 1; fiscalYear <= year + 1; fiscalYear++) {
    const anchor = Date.UTC(fiscalYear, month, day);
    if (endMs > anchor + 10 * DAY_MS) continue;
    const daysBefore = (anchor - endMs) / DAY_MS;
    const quarter = 4 - Math.round(daysBefore / QUARTER_DAYS);
    if (quarter < 1 || Math.abs(daysBefore - (4 - quarter) * QUARTER_DAYS) > 20) return null;
    return { fiscalYear, quarter };
  }
  return null;
}

// A period belongs to the calendar quarter or year that holds its midpoint, moved 3 days
// later so that a July-to-June year counts as the year it ends in. This reproduced 65,272 of
// the 65,273 frames the SEC assigned for the 15 companies; the one miss was a 52-day merger
// stub period, which never reaches this function.
export function calendarPeriod(start: string, end: string, periodType: 'quarter' | 'year'): string {
  const midpoint = new Date((toMs(start) + toMs(end)) / 2 + 3 * DAY_MS);
  const year = midpoint.getUTCFullYear();
  return periodType === 'year' ? `CY${year}` : `CY${year}Q${Math.floor(midpoint.getUTCMonth() / 3) + 1}`;
}

export function normalizeMetric(
  facts: RawFact[],
  metric: MetricId,
  fiscalYearEnd: string,
): { values: MetricValue[]; issues: DataIssue[] } {
  const definition = METRICS[metric];
  const issues: DataIssue[] = [];
  const winners = pickWinners(facts, metric, issues);
  if (winners.length === 0) {
    issues.push({ metric, kind: 'no_mapped_tag', period_end: null, detail: `No 10-K or 10-Q facts for ${definition.tags.join(', ')}.` });
    return { values: [], issues };
  }

  const key = (fiscalYear: number, quarter: number) => `${fiscalYear}Q${quarter}`;
  const discrete = new Map<string, Winner>();
  const cumulative = new Map<string, Winner>();
  const fiscalYears = new Set<number>();
  for (const winner of winners) {
    const { period_start: start, period_end: end, tag, accn } = winner.fact;
    const span = quartersSpanned(start, end);
    const position = fiscalPosition(end, fiscalYearEnd);
    if (span === null || position === null) {
      issues.push({
        metric,
        kind: 'off_calendar_period',
        period_end: end,
        detail: `${start} to ${end} (${tag}, ${accn}) does not line up with fiscal quarters for a year ending near ${fiscalYearEnd}.`,
      });
      continue;
    }
    fiscalYears.add(position.fiscalYear);
    const slot = key(position.fiscalYear, position.quarter);
    if (span === 1) discrete.set(slot, winner);
    if (span === position.quarter) cumulative.set(slot, winner);
  }

  const values: MetricValue[] = [];
  const quarters = new Map<string, MetricValue>();
  for (const fiscalYear of [...fiscalYears].sort()) {
    for (let quarter = 1; quarter <= 4; quarter++) {
      const slot = key(fiscalYear, quarter);
      const direct = discrete.get(slot);
      const toDate = cumulative.get(slot);
      const previous = cumulative.get(key(fiscalYear, quarter - 1));
      const earlier = Array.from({ length: quarter - 1 }, (_, i) => quarters.get(key(fiscalYear, i + 1)));

      // Subtracting a restated total from one that was never restated mixes two bases. Dell's
      // annual numbers were restated after the VMware spin-off, but its old 9M YTD figures
      // were not, and FY − 9M YTD gave a negative R&D quarter.
      let derived: MetricValue | null = null;
      let mixedBasis = false;
      if (toDate && quarter > 1) {
        if (previous && previous.fact.period_start === toDate.fact.period_start) {
          mixedBasis = isRestated(toDate) !== isRestated(previous);
          if (!mixedBasis) {
            derived = buildValue(
              metric, 'quarter', fiscalYear, `Q${quarter}`, nextDay(previous.fact.period_end), toDate.fact.period_end,
              toDate.fact.value - previous.fact.value, `${toDateLabel(quarter)} − ${toDateLabel(quarter - 1)}`, [toDate, previous],
            );
          }
        } else if (earlier.every((part) => part !== undefined)) {
          const parts = earlier as MetricValue[];
          mixedBasis = parts.some((part) => isRestated(part) !== isRestated(toDate));
          if (!mixedBasis) {
            derived = buildValue(
              metric, 'quarter', fiscalYear, `Q${quarter}`, nextDay(parts[parts.length - 1].period_end), toDate.fact.period_end,
              toDate.fact.value - parts.reduce((sum, part) => sum + part.value, 0),
              [toDateLabel(quarter), ...parts.map((part) => part.fiscal_period)].join(' − '), [toDate, ...parts],
            );
          }
        }
      }

      let value = direct
        ? buildValue(metric, 'quarter', fiscalYear, `Q${quarter}`, direct.fact.period_start, direct.fact.period_end, direct.fact.value, null, [direct])
        : derived;
      // A 10-K shows only full-year statements, so a three-month Q4 fact in it comes from a
      // footnote or a tagging slip. When it disagrees with FY − 9M YTD, the statements win.
      if (direct && quarter === 4 && derived && !closeEnough(direct.fact.value, derived.value)) {
        issues.push({
          metric,
          kind: 'conflicting_quarter',
          period_end: direct.fact.period_end,
          detail: `${direct.fact.form} ${direct.fact.accn} reports ${direct.fact.value} for FY${fiscalYear} Q4, but ${derived.derivation} gives ${derived.value}. Using ${derived.derivation}.`,
        });
        value = derived;
      }
      if (!value && mixedBasis && toDate) {
        issues.push({
          metric,
          kind: 'mixed_restatement',
          period_end: toDate.fact.period_end,
          detail: `FY${fiscalYear} Q${quarter} is left out: ${toDateLabel(quarter)} was restated but the figure it would be subtracted from was not, or the other way round.`,
        });
      }

      if (value && !definition.canBeNegative && value.value < 0) {
        issues.push({ metric, kind: 'negative_derived_value', period_end: value.period_end, detail: `${value.derivation} gives ${value.value} for FY${fiscalYear} Q${quarter}, so the quarter is left out.` });
      } else if (value) {
        values.push(value);
        quarters.set(slot, value);
      }
      if (quarter === 4 && toDate) {
        values.push(buildValue(metric, 'year', fiscalYear, 'FY', toDate.fact.period_start, toDate.fact.period_end, toDate.fact.value, null, [toDate]));
      }
    }
  }

  checkYearToDateSums(metric, cumulative, quarters, issues);
  findMissingQuarters(metric, quarters, issues);
  return { values, issues };
}

export function normalizeCompany(facts: RawFact[], fiscalYearEnd: string): { values: MetricValue[]; issues: DataIssue[] } {
  const results = METRIC_IDS.map((metric) => normalizeMetric(facts, metric, fiscalYearEnd));
  return { values: results.flatMap((result) => result.values), issues: results.flatMap((result) => result.issues) };
}

export function tagUsage(values: MetricValue[]): Array<{ tag: string; first_period_end: string; last_period_end: string }> {
  const usage = new Map<string, { tag: string; first_period_end: string; last_period_end: string }>();
  for (const source of values.flatMap((value) => value.sources)) {
    const entry = usage.get(source.tag) ?? { tag: source.tag, first_period_end: source.period_end, last_period_end: source.period_end };
    if (source.period_end < entry.first_period_end) entry.first_period_end = source.period_end;
    if (source.period_end > entry.last_period_end) entry.last_period_end = source.period_end;
    usage.set(source.tag, entry);
  }
  return [...usage.values()].sort((a, b) => a.first_period_end.localeCompare(b.first_period_end));
}

function buildValue(
  metric: MetricId,
  periodType: 'quarter' | 'year',
  fiscalYear: number,
  fiscalPeriod: string,
  start: string,
  end: string,
  value: number,
  derivation: string | null,
  parts: Array<{ revision: Revision; sources: FactSource[] }>,
): MetricValue {
  const revisions = parts.map((part) => part.revision);
  return {
    metric,
    period_type: periodType,
    fiscal_year: fiscalYear,
    fiscal_period: fiscalPeriod,
    period_start: start,
    period_end: end,
    calendar_period: calendarPeriod(start, end, periodType),
    value,
    derived: derivation !== null,
    derivation,
    revision: revisions.includes('restated') ? 'restated' : revisions.includes('rounding') ? 'rounding' : 'none',
    warnings: [],
    sources: parts.flatMap((part) => part.sources),
  };
}

// A reported quarter plus the quarters before it should add up to the year-to-date total.
// Only quarters that were reported directly are checked; derived ones match by construction.
function checkYearToDateSums(metric: MetricId, cumulative: Map<string, Winner>, quarters: Map<string, MetricValue>, issues: DataIssue[]): void {
  for (const [slot, toDate] of cumulative) {
    const [fiscalYear, quarter] = slot.split('Q').map(Number);
    if (quarter < 2 || quarters.get(slot)?.derived !== false) continue;
    const parts = Array.from({ length: quarter }, (_, i) => quarters.get(`${fiscalYear}Q${i + 1}`));
    if (parts.some((part) => part === undefined)) continue;
    const sum = parts.reduce((total, part) => total + (part as MetricValue).value, 0);
    if (Math.abs(sum - toDate.fact.value) > 2_000_000) {
      const detail = `FY${fiscalYear} Q1 to Q${quarter} add up to ${sum}, but ${toDate.fact.accn} reports ${toDate.fact.value} year to date.`;
      issues.push({ metric, kind: 'quarters_do_not_sum', period_end: toDate.fact.period_end, detail });
      for (const part of parts as MetricValue[]) part.warnings.push(detail);
    }
  }
}

function findMissingQuarters(metric: MetricId, quarters: Map<string, MetricValue>, issues: DataIssue[]): void {
  const present = [...quarters.values()].map((value) => value.fiscal_year * 4 + Number(value.fiscal_period.slice(1)) - 1).sort((a, b) => a - b);
  for (let index = present[0]; index < present[present.length - 1]; index++) {
    if (!present.includes(index)) {
      const fiscalYear = Math.floor(index / 4);
      issues.push({ metric, kind: 'missing_quarter', period_end: null, detail: `No reported or derivable value for FY${fiscalYear} Q${(index % 4) + 1}.` });
    }
  }
}

function toDateLabel(quarter: number): string {
  if (quarter === 4) return 'FY';
  return quarter === 1 ? 'Q1' : `${quarter * 3}M YTD`;
}

function toMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function nextDay(date: string): string {
  return new Date(toMs(date) + DAY_MS).toISOString().slice(0, 10);
}
