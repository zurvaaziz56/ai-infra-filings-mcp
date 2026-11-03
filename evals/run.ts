import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PROJECT_ROOT } from '../src/config.js';
import { type Check, type EvalCase, EvalCaseSchema, grade } from './grade.js';
import { parseStreamJson, type RunMeta } from './transcript.js';

const { values: options } = parseArgs({
  options: {
    case: { type: 'string', multiple: true },
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    concurrency: { type: 'string', default: '3' },
    label: { type: 'string', default: 'run' },
    regrade: { type: 'string' },
  },
});

interface CaseResult {
  id: string;
  category: EvalCase['category'];
  role: EvalCase['role'];
  question: string;
  pass: boolean;
  harness_error: boolean;
  checks: Check[];
  answer: string;
  tools: Array<{ name: string; input: Record<string, unknown> }>;
  meta: RunMeta;
}

const EVALS = join(PROJECT_ROOT, 'evals');
const cases = z.array(EvalCaseSchema).parse(JSON.parse(readFileSync(join(EVALS, 'cases.json'), 'utf8')));
const selected = options.case?.length ? cases.filter((c) => options.case?.includes(c.id)) : cases;
const runId = options.regrade ? basename(options.regrade) : `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${options.label}`;
const runDir = options.regrade ? resolve(options.regrade) : join(EVALS, 'runs', runId);

function claude(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    // By default Claude Code starts answering without waiting for MCP servers, and a server
    // that connects late is missing from the first turn. These make it wait up to 30 seconds.
    const env = { ...process.env, MCP_CONNECTION_NONBLOCKING: 'false', MCP_CONNECT_TIMEOUT_MS: '30000' };
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      if (stderr.trim()) writeFileSync(join(runDir, 'stderr.log'), `${stderr}\n`, { flag: 'a' });
      done(stdout);
    });
  });
}

// Each worker gets its own copy of the warehouse, because PGlite allows one process per data
// folder. The copies also pin every case in a run to the same snapshot.
async function runCase(evalCase: EvalCase, warehouse: string, emptyDir: string): Promise<string> {
  const configPath = join(runDir, 'mcp', `${evalCase.id}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        filings: {
          command: process.execPath,
          args: [join(PROJECT_ROOT, 'dist/index.js')],
          // An empty GITHUB_TOKEN keeps evals from filing real issues, whatever .env says.
          env: { MCP_ROLE: evalCase.role, PGLITE_DATA_DIR: warehouse, AUDIT_LOG_PATH: join(runDir, 'audit.jsonl'), GITHUB_TOKEN: '', GITHUB_REPO: '' },
        },
      },
    }),
  );
  // A run where the server never connected says nothing about the server, so it is retried.
  let output = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    output = await claude(
      [
        '-p', evalCase.question,
        '--model', options.model ?? 'claude-sonnet-5-5',
        '--system-prompt', readFileSync(join(EVALS, 'system-prompt.md'), 'utf8'),
        '--tools', '',
        '--mcp-config', configPath,
        '--strict-mcp-config',
        '--allowedTools', 'mcp__filings',
        '--output-format', 'stream-json',
        '--verbose',
        '--no-session-persistence',
      ],
      emptyDir,
      300_000,
    );
    if (parseStreamJson(output).meta.mcp_status === 'connected') break;
  }
  writeFileSync(join(runDir, 'transcripts', `${evalCase.id}.jsonl`), output);
  return output;
}

function score(evalCase: EvalCase, output: string): CaseResult {
  const transcript = parseStreamJson(output);
  const connected = transcript.meta.mcp_status === 'connected';
  const graded = grade(evalCase, transcript);
  // Without the server's tools, a refusal would pass for the wrong reason.
  const checks = [{ name: 'server connected', pass: connected, detail: `MCP server status: ${transcript.meta.mcp_status ?? 'unknown'}.` }, ...graded.checks];
  return {
    id: evalCase.id,
    category: evalCase.category,
    role: evalCase.role,
    question: evalCase.question,
    pass: connected && graded.pass,
    harness_error: !connected,
    checks,
    answer: transcript.answer,
    tools: transcript.tool_calls.map(({ name, input }) => ({ name, input })),
    meta: transcript.meta,
  };
}

function resultLabel(result: CaseResult): string {
  if (result.harness_error) return 'not run';
  return result.pass ? 'pass' : 'FAIL';
}

function report(results: CaseResult[]): string {
  const valid = results.filter((r) => !r.harness_error);
  const notRun = results.filter((r) => r.harness_error);
  const passed = valid.filter((r) => r.pass).length;
  const percent = (n: number, of: number) => `${Math.round((n / Math.max(of, 1)) * 100)}%`;
  const meta = results.find((r) => r.meta.model)?.meta;
  const lines = [
    `# Eval run ${runId}`,
    '',
    `Model: \`${meta?.model ?? options.model}\`. Claude Code ${meta?.claude_code_version ?? 'unknown'}. ${results.length} cases.`,
    '',
    `**Passed ${passed} of ${valid.length} (${percent(passed, valid.length)}).**`,
    ...(notRun.length ? ['', `${notRun.length} case(s) did not run, because the MCP server never connected: ${notRun.map((r) => r.id).join(', ')}. They are left out of the score.`] : []),
    '',
    '| Category | Passed |',
    '|---|---|',
    ...[...new Set(valid.map((r) => r.category))].map((category) => {
      const group = valid.filter((r) => r.category === category);
      return `| ${category} | ${group.filter((r) => r.pass).length} of ${group.length} |`;
    }),
    '',
    '## Failures',
    '',
  ];
  for (const result of valid.filter((r) => !r.pass)) {
    lines.push(
      `### ${result.id}`,
      '',
      `${result.category}, as ${result.role}: "${result.question}"`,
      '',
      ...result.checks.filter((c) => !c.pass).map((c) => `- **${c.name}**: ${c.detail}`),
      `- Tools: ${result.tools.map((t) => `\`${t.name}(${JSON.stringify(t.input)})\``).join(', ') || 'none'}`,
      '',
      ...result.answer.trim().split('\n').map((line) => `> ${line}`),
      '',
    );
  }
  if (passed === valid.length) lines.push('None.', '');
  lines.push(
    '## All cases',
    '',
    '| Case | Result | Tools | Turns | Seconds | Cost |',
    '|---|---|---|---|---|---|',
    ...results.map((r) =>
      `| ${r.id} | ${resultLabel(r)} | ${r.tools.map((t) => t.name).join(', ') || '–'} | ${r.meta.turns ?? '–'} | ${r.meta.duration_ms ? (r.meta.duration_ms / 1000).toFixed(0) : '–'} | ${r.meta.cost_usd === null ? '–' : `$${r.meta.cost_usd.toFixed(3)}`} |`,
    ),
  );
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  if (selected.length === 0) throw new Error('No cases match --case.');
  for (const dir of ['transcripts', 'mcp']) mkdirSync(join(runDir, dir), { recursive: true });

  const outputs = new Map<string, string>();
  if (options.regrade) {
    for (const evalCase of selected) outputs.set(evalCase.id, readFileSync(join(runDir, 'transcripts', `${evalCase.id}.jsonl`), 'utf8'));
  } else {
    if (!existsSync(join(PROJECT_ROOT, 'dist/index.js'))) throw new Error('Run npm run build first.');
    const workers = Math.max(1, Math.min(Number(options.concurrency), selected.length));
    const emptyDir = mkdtempSync(join(tmpdir(), 'ai-infra-eval-'));
    const queue = [...selected];
    await Promise.all(
      Array.from({ length: workers }, async (_, worker) => {
        const warehouse = join(runDir, `warehouse-${worker}`);
        cpSync(join(PROJECT_ROOT, 'data/pglite'), warehouse, { recursive: true });
        for (let evalCase = queue.shift(); evalCase; evalCase = queue.shift()) {
          const output = await runCase(evalCase, warehouse, emptyDir);
          if (/Failed to authenticate|Not logged in|Invalid API key/i.test(output)) {
            throw new Error('Claude Code is not signed in. Run `claude auth login`, then try again.');
          }
          outputs.set(evalCase.id, output);
          console.log(`${resultLabel(score(evalCase, output))}  ${evalCase.id}`);
        }
      }),
    );
  }

  const results = selected.map((evalCase) => score(evalCase, outputs.get(evalCase.id) ?? ''));
  const resultsDir = join(EVALS, 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${runId}.md`), report(results));
  writeFileSync(join(resultsDir, `${runId}.json`), `${JSON.stringify(results, null, 2)}\n`);
  const valid = results.filter((r) => !r.harness_error);
  console.log(`\nPassed ${valid.filter((r) => r.pass).length} of ${valid.length}, ${results.length - valid.length} not run. Report: evals/results/${runId}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
