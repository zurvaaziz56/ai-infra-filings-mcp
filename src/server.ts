import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { canUse } from './access.js';
import { type AuditEntry, type AuditLog, hashArgs } from './audit.js';
import { SourceError } from './errors.js';
import { requestCounter } from './http.js';
import { type Tool, type ToolContext, type ToolResult, TOOLS } from './tools.js';

export interface ServerDeps extends ToolContext {
  audit: AuditLog;
}

// Checks the role again on every call, so a registration mistake cannot expose a tool.
export async function invokeTool(tool: Tool, args: Record<string, unknown>, deps: ServerDeps): Promise<ToolResult> {
  const started = performance.now();
  const requests: Record<string, number> = {};
  let result: ToolResult;
  let outcome: AuditEntry['outcome'];

  if (!canUse(deps.role, tool.name)) {
    result = { data: null, sources: [], error: { code: 'forbidden', message: `The ${deps.role.name} role cannot use ${tool.name}.` } };
    outcome = 'denied';
  } else {
    try {
      result = await requestCounter.run(requests, () => tool.handler(args, deps));
      outcome = result.sources.some((source) => source.status !== 'ok') ? 'degraded' : 'ok';
    } catch (error) {
      if (!(error instanceof SourceError)) console.error(`[${tool.name}]`, error);
      result = {
        data: null,
        sources: [],
        error:
          error instanceof SourceError
            ? { code: error.kind, message: error.message }
            : { code: 'internal', message: 'The tool failed. Check that the warehouse is loaded (npm run load).' },
      };
      outcome = 'error';
    }
  }

  try {
    await deps.audit.record({
      ts: new Date().toISOString(),
      role: deps.role.name,
      tool: tool.name,
      args_sha256: hashArgs(args),
      outcome,
      duration_ms: Math.round(performance.now() - started),
      sec_requests: requests.sec ?? 0,
      github_requests: requests.github ?? 0,
    });
  } catch (error) {
    console.error('Could not write the audit log:', error);
  }
  return result;
}

export function buildServer(deps: ServerDeps, tools: Tool[] = TOOLS): McpServer {
  const server = new McpServer({ name: 'ai-infra-filings-mcp', version: '0.1.0' });
  for (const tool of tools) {
    // Tools outside the role are never registered, so clients never see them in the list.
    if (!canUse(deps.role, tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        const result = await invokeTool(tool, args, deps);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.error !== undefined };
      },
    );
  }
  return server;
}
