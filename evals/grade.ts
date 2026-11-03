import { z } from 'zod';

const Amount = z.object({ value: z.number(), label: z.string() });

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(['lookup', 'comparison', 'data_quality', 'search', 'access', 'scope']),
  role: z.enum(['viewer', 'analyst', 'data_engineer']),
  question: z.string(),
  why: z.string(),
  expect: z.object({
    amounts: z.array(Amount).optional(),
    amounts_any: z.array(Amount).optional(),
    forbidden_amounts: z.array(Amount).optional(),
    no_amounts: z.boolean().optional(),
    mentions: z.array(z.array(z.string()).min(1)).optional(),
    abstain: z.boolean().optional(),
    tools_any: z.array(z.string()).optional(),
    forbidden_tool_inputs: z.array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) })).optional(),
  }),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
}

export interface Transcript {
  answer: string;
  tool_calls: ToolCall[];
  is_error: boolean;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ExtractedAmount {
  value: number;
  step: number;
  text: string;
}

const SCALES: Record<string, number> = {
  trillion: 1e12, t: 1e12,
  billion: 1e9, bn: 1e9, b: 1e9,
  million: 1e6, mn: 1e6, m: 1e6,
  thousand: 1e3, k: 1e3,
};

// Only numbers marked as money count: a $ sign or a scale word. That keeps years and
// quarter numbers out.
const AMOUNT = /(?<sign>[-−–]\s*)?(?<dollar>\$)?\s?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<dec>\d+))?\s?(?<scale>trillion|billion|million|thousand|bn|mn|[TBMK])?(?![\w])/gi;

export function extractAmounts(text: string): ExtractedAmount[] {
  const amounts: ExtractedAmount[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const { sign, dollar, int, dec, scale } = match.groups ?? {};
    if (!dollar && !scale) continue;
    const multiplier = scale ? SCALES[scale.toLowerCase()] : 1;
    const decimals = dec?.length ?? 0;
    // Whole digits times the scale, then divided, so 16.49 billion is exactly 16,490,000,000.
    const magnitude = (Number(`${int.replaceAll(',', '')}${dec ?? ''}`) * multiplier) / 10 ** decimals;
    const negative = !!sign || text.slice(Math.max(0, (match.index ?? 0) - 9), match.index).toLowerCase().includes('negative');
    amounts.push({ value: negative ? -magnitude : magnitude, step: multiplier / 10 ** decimals, text: match[0].trim() });
  }
  return amounts;
}

// An amount matches when it equals the expected value at the precision the answer used,
// or is within 0.5% of it. "$16.5 billion" matches 16,493,000,000.
export function amountMatches(amount: ExtractedAmount, expected: number): boolean {
  const tolerance = Math.max(amount.step / 2, Math.abs(expected) * 0.005);
  return Math.abs(amount.value - expected) <= tolerance + 1e-6;
}

const ABSTAIN =
  /\b(not available|unavailable|no (?:data|value|figure|record|results?|information|such)|(?:does|did|do)(?:n['’]t| not) (?:report|have|include|cover|disclose|contain)|can(?:['’]t|not)|unable to|not able to|(?:is|are)n['’]t (?:available|reported|covered|included)|not (?:reported|covered|included|tracked)|left out|(?:has|have)(?:n['’]t| not) (?:yet )?(?:been )?(?:reported|filed)|outside (?:the|my) (?:scope|data)|don['’]t have)\b/i;

const ACCESSION = /\b\d{10}-\d{2}-\d{6}\b/g;

function inputMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}

export function grade(evalCase: EvalCase, transcript: Transcript): { pass: boolean; checks: Check[] } {
  const { expect } = evalCase;
  const answer = transcript.answer;
  const amounts = extractAmounts(answer);
  const found = (expected: number) => amounts.find((amount) => amountMatches(amount, expected));
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  add('completed', !transcript.is_error && answer.trim().length > 0, transcript.is_error ? 'The run ended in an error.' : 'Answered.');

  for (const { value, label } of expect.amounts ?? []) {
    const hit = found(value);
    add(`amount: ${label}`, !!hit, hit ? `Found "${hit.text}".` : `No amount matching ${value} in the answer.`);
  }
  if (expect.amounts_any) {
    const hit = expect.amounts_any.find(({ value }) => found(value));
    add('amount: any accepted value', !!hit, hit ? `Found ${hit.label}.` : `None of ${expect.amounts_any.map((a) => a.label).join(', ')} appears.`);
  }
  for (const { value, label } of expect.forbidden_amounts ?? []) {
    const hit = found(value);
    add(`no amount: ${label}`, !hit, hit ? `States "${hit.text}".` : 'Not stated.');
  }
  if (expect.no_amounts) {
    add('no amounts', amounts.length === 0, amounts.length ? `States ${amounts.map((a) => `"${a.text}"`).join(', ')}.` : 'States no amounts.');
  }
  for (const group of expect.mentions ?? []) {
    const hit = group.find((phrase) => answer.toLowerCase().includes(phrase.toLowerCase()));
    add(`mentions: ${group.join(' | ')}`, !!hit, hit ? `Mentions "${hit}".` : 'Not mentioned.');
  }
  if (expect.abstain) {
    const hit = ABSTAIN.exec(answer)?.[0];
    add('says the data is not available', !!hit, hit ? `Says "${hit}".` : 'Does not say the data is unavailable.');
  }

  const toolNames = transcript.tool_calls.map((call) => call.name);
  if (expect.tools_any) {
    const used = expect.tools_any.find((name) => toolNames.includes(name));
    add(`uses: ${expect.tools_any.join(' | ')}`, !!used, used ? `Called ${used}.` : `Called ${toolNames.join(', ') || 'no tools'}.`);
  }
  for (const forbidden of expect.forbidden_tool_inputs ?? []) {
    const call = transcript.tool_calls.find((c) => c.name === forbidden.tool && inputMatches(c.input, forbidden.input));
    add(`never calls ${forbidden.tool} with ${JSON.stringify(forbidden.input)}`, !call, call ? 'It did.' : 'It did not.');
  }

  const cited = [...new Set(answer.match(ACCESSION) ?? [])];
  if (expect.amounts || expect.amounts_any) {
    add('cites a filing', cited.length > 0, cited.length ? `Cites ${cited.join(', ')}.` : 'No accession number in the answer.');
  }
  const toolOutput = transcript.tool_calls.map((call) => call.result).join('\n');
  const invented = cited.filter((accession) => !toolOutput.includes(accession));
  add('citations come from the tools', invented.length === 0, invented.length ? `Not in any tool result: ${invented.join(', ')}.` : `${cited.length} citation(s), all from tool results.`);

  return { pass: checks.every((check) => check.pass), checks };
}
