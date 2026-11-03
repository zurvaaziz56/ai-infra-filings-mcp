-- The MCP server connects as filings_reader, which can read the warehouse but not change it.
-- npm run load connects as filings_owner. Passwords are for local development only.
CREATE ROLE filings_reader LOGIN PASSWORD 'filings_reader_dev';
GRANT CONNECT ON DATABASE filings TO filings_reader;
GRANT USAGE ON SCHEMA public TO filings_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE filings_owner IN SCHEMA public GRANT SELECT ON TABLES TO filings_reader;
