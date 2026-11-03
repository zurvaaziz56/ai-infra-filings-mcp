import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRole } from './access.js';
import { AuditLog } from './audit.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { SourceError } from './errors.js';
import { TokenBucket } from './resilience.js';
import { SecClient } from './sec-client.js';
import { buildServer } from './server.js';

// stdout carries the MCP protocol, so every log line goes to stderr.
try {
  const config = loadConfig();
  const role = loadRole(config.rolesPath, config.role);
  const db = await openDb(config);
  const perMinute = role.sec_requests_per_minute;
  const sec = new SecClient({ userAgent: config.secUserAgent, budget: new TokenBucket(perMinute, perMinute / 60) });
  const server = buildServer({ db, sec, role, audit: new AuditLog(config.auditLogPath) });
  await server.connect(new StdioServerTransport());
  console.error(`ai-infra-filings-mcp is running as role "${role.name}".`);
} catch (error) {
  console.error(error instanceof SourceError ? error.message : error);
  process.exit(1);
}
