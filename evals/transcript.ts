import type { ToolCall, Transcript } from './grade.js';

export interface RunMeta {
  model: string | null;
  claude_code_version: string | null;
  mcp_status: string | null;
  turns: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ text?: string }>;
}

// Reads Claude Code's --output-format stream-json: one JSON event per line.
export function parseStreamJson(text: string, serverName = 'filings'): Transcript & { meta: RunMeta } {
  const calls = new Map<string, ToolCall>();
  const ordered: ToolCall[] = [];
  const meta: RunMeta = { model: null, claude_code_version: null, mcp_status: null, turns: null, duration_ms: null, cost_usd: null };
  let answer = '';
  let isError = true;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = ((event.message as { content?: ContentBlock[] } | undefined)?.content ?? []) as ContentBlock[];
    if (event.type === 'system' && event.subtype === 'init') {
      meta.model = (event.model as string) ?? null;
      meta.claude_code_version = (event.claude_code_version as string) ?? null;
      const server = (event.mcp_servers as Array<{ name: string; status: string }> | undefined)?.find((s) => s.name === serverName);
      meta.mcp_status = server?.status ?? null;
    } else if (event.type === 'assistant') {
      for (const block of blocks.filter((b) => b.type === 'tool_use')) {
        const call: ToolCall = { name: (block.name ?? '').replace(`mcp__${serverName}__`, ''), input: block.input ?? {}, result: '' };
        calls.set(block.id ?? '', call);
        ordered.push(call);
      }
    } else if (event.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        const call = calls.get(block.tool_use_id ?? '');
        if (call) call.result = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c) => c.text ?? '').join('\n');
      }
    } else if (event.type === 'result') {
      answer = (event.result as string) ?? '';
      isError = !!event.is_error;
      meta.turns = (event.num_turns as number) ?? null;
      meta.duration_ms = (event.duration_ms as number) ?? null;
      meta.cost_usd = (event.total_cost_usd as number) ?? null;
    }
  }
  return { answer, tool_calls: ordered, is_error: isError, meta };
}
