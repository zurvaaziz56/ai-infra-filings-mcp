export type SourceErrorKind =
  | 'config'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'circuit_open'
  | 'timeout'
  | 'unavailable';

// Messages are written for the MCP client, so they never carry secrets, URLs with
// credentials, or stack traces.
export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
