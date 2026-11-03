import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SourceError } from './errors.js';

const RoleSchema = z.object({
  description: z.string(),
  tools: z.array(z.string()).min(1),
  sec_requests_per_minute: z.number().int().min(0).max(480),
});

const RolesFileSchema = z.object({ roles: z.record(z.string(), RoleSchema) });

export type Role = z.infer<typeof RoleSchema> & { name: string };

// Tools are granted by name in config/roles.json, so a new tool needs a config change and
// no change here.
export function loadRole(path: string, name: string): Role {
  const parsed = RolesFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new SourceError('config', `${path} is not a valid roles file: ${z.prettifyError(parsed.error)}`);
  const role = parsed.data.roles[name];
  if (!role) {
    throw new SourceError('config', `Unknown role "${name}". Set MCP_ROLE to one of: ${Object.keys(parsed.data.roles).join(', ')}.`);
  }
  return { ...role, name };
}

export function canUse(role: Role, tool: string): boolean {
  return role.tools.includes('*') || role.tools.includes(tool);
}
