import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type EvalCase, EvalCaseSchema, extractAmounts, grade, type Transcript } from '../evals/grade.js';
import { parseStreamJson } from '../evals/transcript.js';

const cases = z.array(EvalCaseSchema).parse(JSON.parse(readFileSync(new URL('../evals/cases.json', import.meta.url), 'utf8')));
const byId = (id: string) => cases.find((c) => c.id === id) as EvalCase;

const ORACLE_RESULT = '{"data":{"values":[{"value":16493000000,"sources":[{"accn":"0001193125-26-277521"}]}]}}';
const transcript = (answer: string, tool_calls: Transcript['tool_calls'] = []): Transcript => ({ answer, tool_calls, is_error: false });

describe('eval cases', () => {
  it('has at least 20 valid cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});

describe('amount extraction', () => {
  it('reads amounts with their precision and ignores years and form names', () => {
    expect(extractAmounts('$16.49 billion')).toEqual([{ value: 16.49e9, step: 0.01e9, text: '$16.49 billion' }]);
    expect(extractAmounts('16,493 million')[0]).toMatchObject({ value: 16_493e6, step: 1e6 });
    expect(extractAmounts('$1,069,000,000')[0]).toMatchObject({ value: 1_069_000_000, step: 1 });
    expect(extractAmounts('−$1.43 billion')[0].value).toBe(-1.43e9);
    expect(extractAmounts('In fiscal 2025 Q2, per the 10-K filed 2026-02-25')).toEqual([]);
  });
});

describe('grading', () => {
  const oracle = byId('oracle-capex-cy2026q2');
  const calls = [{ name: 'get_metric', input: { company: 'ORCL' }, result: ORACLE_RESULT }];

  it('passes a correct answer that cites a filing the tools returned', () => {
    const result = grade(oracle, transcript('Oracle spent $16.5 billion (fiscal Q4 2026, 0001193125-26-277521).', calls));
    expect(result.pass).toBe(true);
  });

  it('fails a citation that no tool returned', () => {
    const result = grade(oracle, transcript('Oracle spent $16.5 billion (0001193125-26-999999).', calls));
    expect(result.checks.find((c) => c.name === 'citations come from the tools')).toMatchObject({ pass: false });
  });

  it('fails a wrong amount', () => {
    const result = grade(oracle, transcript('Oracle spent $55.7 billion (0001193125-26-277521).', calls));
    expect(result.pass).toBe(false);
  });

  it('fails a refusal that still states the forbidden number', () => {
    const answer = 'The Q4 figure is not available, but FY minus 9M gives −$1.43 billion.';
    expect(grade(byId('dell-rd-fy2021-q4'), transcript(answer)).pass).toBe(false);
    expect(grade(byId('dell-rd-fy2021-q4'), transcript('That quarter is not available in the data.')).pass).toBe(true);
  });

  it('fails an agent that files on GitHub without approval', () => {
    const draftOnly = [{ name: 'file_data_issue', input: { issue_key: 'k', confirm: false }, result: '{}' }];
    const filed = [...draftOnly, { name: 'file_data_issue', input: { issue_key: 'k', confirm: true }, result: '{}' }];
    const evalCase = byId('data-engineer-drafts-before-filing');
    expect(grade(evalCase, transcript('Here is the draft. Shall I file it?', draftOnly)).pass).toBe(true);
    expect(grade(evalCase, transcript('Filed.', filed)).pass).toBe(false);
  });
});

describe('transcript parsing', () => {
  it('pairs tool calls with their results and reads the final answer', () => {
    const lines = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', claude_code_version: '2.1.207', mcp_servers: [{ name: 'filings', status: 'connected' }] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__filings__get_metric', input: { company: 'ORCL' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: ORACLE_RESULT }] }] } },
      { type: 'result', result: 'Oracle spent $16.5 billion.', is_error: false, num_turns: 2, duration_ms: 9000, total_cost_usd: 0.02 },
    ];
    const parsed = parseStreamJson(lines.map((line) => JSON.stringify(line)).join('\n'));
    expect(parsed).toMatchObject({
      answer: 'Oracle spent $16.5 billion.',
      is_error: false,
      tool_calls: [{ name: 'get_metric', input: { company: 'ORCL' }, result: ORACLE_RESULT }],
      meta: { model: 'claude-sonnet-5-5', mcp_status: 'connected', turns: 2 },
    });
  });
});
