import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  ts: string;
  role: string;
  tool: string;
  args_sha256: string;
  outcome: 'ok' | 'degraded' | 'error' | 'denied';
  duration_ms: number;
  sec_requests: number;
}

// Arguments are hashed, not stored, so the log can show repeated calls without keeping
// what users asked.
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex');
}

export class AuditLog {
  constructor(private readonly path: string) {}

  async record(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }
}
