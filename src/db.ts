import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Dates stay as 'YYYY-MM-DD' strings. Parsing them into JS Dates would shift them by the
// local time zone.
const DATE_OID = 1082;

export async function openDb(options: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  return options.databaseUrl ? openPostgres(options.databaseUrl) : openPglite(options.dataDir);
}

// Lets the server answer the MCP handshake while the database is still opening. Opening
// PGlite takes a second or more, and some clients send their first request before then.
export function deferredDb(opening: Promise<Db>): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await opening).query<T>(sql, params),
    exec: async (sql) => (await opening).exec(sql),
    transaction: async (fn) => (await opening).transaction(fn),
    close: async () => (await opening).close(),
  };
}

function openPostgres(connectionString: string): Db {
  const types = {
    getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
      oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
  };
  const pool = new pg.Pool({ connectionString, types });
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(dataDir, { parsers: { [DATE_OID]: (value: string) => value } });
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: async <T>(sql: string, params?: unknown[]) => (await tx.query<T>(sql, params)).rows })),
    close: () => db.close(),
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  cik text PRIMARY KEY,
  ticker text NOT NULL UNIQUE,
  name text NOT NULL,
  sic_description text,
  fiscal_year_end text NOT NULL,
  loaded_at timestamptz NOT NULL
);

-- Every fact for the tags the metric map considers, exactly as the SEC returns it.
CREATE TABLE IF NOT EXISTS raw_facts (
  cik text NOT NULL REFERENCES companies (cik),
  taxonomy text NOT NULL,
  tag text NOT NULL,
  unit text NOT NULL,
  period_start date,
  period_end date NOT NULL,
  value double precision NOT NULL,
  accn text NOT NULL,
  fy integer,
  fp text,
  form text NOT NULL,
  filed date NOT NULL,
  frame text
);
CREATE INDEX IF NOT EXISTS raw_facts_by_tag ON raw_facts (cik, tag, period_end);

CREATE TABLE IF NOT EXISTS metric_values (
  cik text NOT NULL REFERENCES companies (cik),
  metric text NOT NULL,
  period_type text NOT NULL CHECK (period_type IN ('quarter', 'year')),
  fiscal_year integer NOT NULL,
  fiscal_period text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  calendar_period text NOT NULL,
  value double precision NOT NULL,
  derived boolean NOT NULL,
  derivation text,
  revision text NOT NULL CHECK (revision IN ('none', 'rounding', 'restated')),
  warnings jsonb NOT NULL,
  sources jsonb NOT NULL,
  PRIMARY KEY (cik, metric, period_type, period_end)
);

CREATE TABLE IF NOT EXISTS data_issues (
  cik text NOT NULL REFERENCES companies (cik),
  metric text NOT NULL,
  kind text NOT NULL,
  period_end date,
  detail text NOT NULL
);
`;

export function migrate(db: Db): Promise<void> {
  return db.exec(SCHEMA);
}
