import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Paths resolve from the project root, because MCP clients start the server from any folder.
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface AppConfig {
  secUserAgent: string | undefined;
  databaseUrl: string | undefined;
  dataDir: string;
  role: string;
  rolesPath: string;
  auditLogPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envFile = join(PROJECT_ROOT, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  const fromRoot = (path: string) => join(PROJECT_ROOT, path);
  return {
    secUserAgent: env.SEC_USER_AGENT?.trim() || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.PGLITE_DATA_DIR ?? fromRoot('data/pglite'),
    role: env.MCP_ROLE ?? 'viewer',
    rolesPath: env.ROLES_PATH ?? fromRoot('config/roles.json'),
    auditLogPath: env.AUDIT_LOG_PATH ?? fromRoot('logs/audit.jsonl'),
  };
}
