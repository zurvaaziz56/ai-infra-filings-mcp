import { loadConfig } from './config.js';
import { migrate, openDb } from './db.js';
import { SourceError } from './errors.js';
import { COMPANIES, loadCompanies } from './load.js';
import { SecClient } from './sec-client.js';

const config = loadConfig();
const db = await openDb(config);
try {
  await migrate(db);
  const started = Date.now();
  const results = await loadCompanies(db, new SecClient({ userAgent: config.secUserAgent }), COMPANIES);
  console.table(results);
  const loaded = results.filter((result) => result.status === 'loaded').length;
  const target = config.databaseUrl ? 'Postgres' : config.dataDir;
  console.log(`Loaded ${loaded} of ${results.length} companies into ${target} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  process.exitCode = loaded === results.length ? 0 : 1;
} catch (error) {
  console.error(error instanceof SourceError ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
