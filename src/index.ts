import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRole } from './access.js';
import { AuditLog } from './audit.js';
import { loadConfig } from './config.js';
import { deferredDb, openDb } from './db.js';
import { SourceError } from './errors.js';
import { GitHubClient } from './github-client.js';
import { TokenBucket } from './resilience.js';
import { SecClient } from './sec-client.js';
import { buildServer } from './server.js';

// stdout carries the MCP protocol, so every log line goes to stderr.
try {
  const config = loadConfig();
  const role = loadRole(config.rolesPath, config.role);
  const opening = openDb(config);
  opening.catch((error) => console.error('Could not open the warehouse:', error instanceof Error ? error.message : error));
  const db = deferredDb(opening);
  const perMinute = role.sec_requests_per_minute;
  const sec = new SecClient({ userAgent: config.secUserAgent, budget: new TokenBucket(perMinute, perMinute / 60) });
  const github = new GitHubClient({ token: config.githubToken, repo: config.githubRepo });
  const server = buildServer({ db, sec, github, role, audit: new AuditLog(config.auditLogPath) });
  await server.connect(new StdioServerTransport());
  // The client closes stdin when it is done. Exit then, because an open database would
  // otherwise keep the process alive.
  process.stdin.on('end', () => process.exit(0));
  console.error(`ai-infra-filings-mcp is running as role "${role.name}".`);
} catch (error) {
  console.error(error instanceof SourceError ? error.message : error);
  process.exit(1);
}
