# AI Infra Filings MCP

An MCP server that answers questions about how much public tech companies spend on AI infrastructure. It uses real SEC filings, and every number it returns names the filing it came from. When the filings themselves are wrong, it can file the problem as a GitHub issue with the evidence attached.

## The problem

"How much did Microsoft, Alphabet, Amazon, Meta and Oracle spend on capex last quarter?" sounds like one query against the SEC's free XBRL API. It is not:

- **Companies change tags.** NVIDIA tagged capex as `PaymentsToAcquirePropertyPlantAndEquipment` until its August 2020 10-Q, then switched to `PaymentsToAcquireProductiveAssets`. A query on the old tag says NVIDIA stopped spending in mid-2020.
- **Each period appears in many filings.** A quarter is reported in its own 10-Q, again a year later as a comparative, and sometimes again in an amendment. For the 15 companies here, 10,467 raw facts collapse to 4,022 values.
- **Most quarters are not reported directly.** Cash-flow items such as capex appear only as year-to-date totals, so a quarter is the difference of two totals. 895 of the 4,022 values are derived.
- **Fiscal years differ.** NVIDIA's year ends in late January, Oracle's in May and Microsoft's in June, so "Q2" means different months for each.
- **Filings contain errors.** Oracle's 10-Ks for fiscal 2018 to 2022 tag a full year of revenue as a three-month quarter. The SEC's own frames API repeats the error and reports $39.1B of Oracle revenue for calendar Q2 2020. This server reports $10.4B and logs the conflict.

## What it answers

`compare_metric` for capex in calendar Q2 2026, from a load on November 2, 2026:

| Company | Capex | Fiscal period | How the quarter was found |
|---|---|---|---|
| Amazon | $54.2B | FY2026 Q2 | Reported directly in the 10-Q |
| Alphabet | $44.9B | FY2026 Q2 | 6M YTD − Q1, from two 10-Qs |
| Microsoft | $35.8B | FY2026 Q4 | FY − 9M YTD, from the 10-K and a 10-Q |
| Meta | $30.1B | FY2026 Q2 | 6M YTD − Q1 |
| Oracle | $16.5B | FY2026 Q4 | FY − 9M YTD |
| CoreWeave | $6.4B | FY2026 Q2 | 6M YTD − Q1 |
| NVIDIA | $2.7B | FY2027 Q2 | 6M YTD − Q1 |

Each cell in the response also carries the accession number, form, filing date and XBRL tag of every fact behind it.

| Tool | What it does | Roles |
|---|---|---|
| `get_company` | Identifies a company and lists its latest 10-K and 10-Q filings | all |
| `get_metric` | Quarterly or annual values of one metric, with sources, derivations and restatements | all |
| `compare_metric` | One metric across companies, lined up by calendar quarter or year | all |
| `source_status` | Health of the warehouse and the SEC connection, and the caller's budget | all |
| `search_filings` | Live full-text search of all SEC filings, for example for "Anthropic" | analyst and up |
| `get_raw_facts` | Facts exactly as the SEC returned them, before de-duplication | data_engineer, admin |
| `list_data_issues` | Problems found while loading, such as conflicts, restatements and gaps, each with a key | data_engineer, admin |
| `file_data_issue` | Drafts a GitHub issue for one of those problems, with the filings, the facts as filed and the published value. With `confirm`, files it once | data_engineer, admin |

The metrics are `capex`, `revenue`, `rd_expense` and `operating_income` for NVDA, MSFT, GOOGL, AMZN, META, ORCL, AMD, AVGO, AAPL, CRM, PLTR, SNOW, CRWV, DELL and SMCI.

## Why these sources

- **SEC company facts** (`data.sec.gov`) are every XBRL number a company has filed. They are free, need no key, and are the primary source behind most financial data products.
- **SEC submissions** give each company's fiscal year end and its latest filings.
- **SEC full-text search** (`efts.sec.gov`) covers what the numbers cannot. AI labs such as Anthropic and OpenAI are private and file nothing, but their partners and suppliers mention them. A search for "Anthropic" in 10-Ks and 10-Qs filed from 2025 to November 2026 returns 109 filings, from Amazon, Meta, NVIDIA, Salesforce, Reddit, Zoom and others.
- **A Postgres warehouse** holds the normalized values. It answers in milliseconds, keeps working when the SEC does not, and keeps the raw facts so that every number can be traced.
- **GitHub Issues** is where data problems become work someone can pick up. It is the one source the server writes to, so only data engineers and admins can use it, and nothing is filed without `confirm`.

## Filing a data problem

A data engineer lists the problems for a company, then turns one into an issue:

1. `list_data_issues` with `company: "ORCL"` returns each problem with a key, such as `ORCL/revenue/conflicting_quarter/2020-05-31/…`.
2. `file_data_issue` with that key returns a draft and contacts nothing. The draft explains the problem, links each filing involved, lists every fact filed for the period, and shows what the server publishes instead.
3. `file_data_issue` with the key and `confirm: true` files it on `GITHUB_REPO`, labelled `data-quality`. Calling it again returns the same issue.

Each issue body ends with a hidden marker that holds the key. Before filing, the server looks for that marker among the repository's issues, so a problem is filed only once, even across restarts or by different people.

## How the messy data is handled

The loader stores every fact for the mapped tags unchanged in `raw_facts`, then builds `metric_values` from them in [`src/normalize.ts`](src/normalize.ts):

1. **Metric map.** Each metric lists every us-gaap tag that can carry it ([`src/metrics.ts`](src/metrics.ts)). Tags left out on purpose, such as `SalesRevenueGoodsNet`, which is product revenue only, are listed with reasons in [`docs/data-notes.md`](docs/data-notes.md).
2. **One value per period.** The most recently filed fact wins, across all of a metric's tags, with ties going to the tag listed first. This is the same "last filed" rule the SEC's frames API uses, and it handles tag switches, amendments and restatements with one rule. When a value changed after it was first reported, the source keeps the first-reported value, and `revision` says whether the change was `rounding` or `restated`. [ADR 1](docs/adr/0001-which-filing-wins.md) compares this rule with three alternatives on real cases, including one where it publishes a wrong number.
3. **Fiscal and calendar periods.** The fiscal quarter comes from the period end date and the company's fiscal year end, allowing for 52/53-week years. The calendar period is the one holding the period's midpoint, moved 3 days later. That rule reproduced 65,272 of the 65,273 frames the SEC assigned for these companies.
4. **Derived quarters.** A missing quarter is the difference of two year-to-date totals, and the value says so (`"derivation": "FY − 9M YTD"`). The server never subtracts a restated total from one that was not restated, and when a 10-K's three-month Q4 disagrees with FY − 9M YTD, the statement totals win.
5. **Checks.** Every load records what it finds in `data_issues`: 120 issues across the 15 companies, from Oracle's mis-tagged quarters to Dell's VMware restatement.

The NVIDIA tag switch, as `get_metric` reports it:

```json
"tag_usage": [
  { "tag": "PaymentsToAcquirePropertyPlantAndEquipment", "first_period_end": "2010-01-31", "last_period_end": "2019-07-28" },
  { "tag": "PaymentsToAcquireProductiveAssets", "first_period_end": "2019-10-27", "last_period_end": "2026-07-26" }
]
```

[`docs/data-notes.md`](docs/data-notes.md) lists every problem found, with the filings that show it.

## Access control

Roles live in [`config/roles.json`](config/roles.json), and `MCP_ROLE` picks one when the server starts.

- A tool outside the role is never registered, so it does not appear when a client lists tools.
- The role is checked again on every call, so a registration mistake cannot expose a tool.
- Each role has its own SEC request budget per minute, under the shared limit of 8 requests per second.
- With Postgres, the server connects as `filings_reader`, which can read the warehouse but not change it.

Adding a tool means adding it to `src/tools.ts` and granting it in `config/roles.json`. Phase 2 added `file_data_issue` that way, without changing `src/access.ts`.

## When things go wrong

The SEC and GitHub share the same timeout, retry and circuit-breaker code ([`src/http.ts`](src/http.ts)), with a separate circuit for each.

| Situation | What happens |
|---|---|
| A source is slow | Each request times out after 20 seconds |
| A source is rate-limiting | Retries up to twice, waiting as long as `Retry-After` (or GitHub's rate-limit reset) says, up to 10 seconds |
| A source keeps failing | After 3 failures in a row, requests to it pause for 30 seconds |
| The SEC is unavailable | `get_company` and `get_metric` answer from the warehouse with status `stale` and an `as_of` date. `search_filings` returns no data and status `unavailable` |
| GitHub is unavailable, or `GITHUB_TOKEN` is missing or rejected | `file_data_issue` returns the draft with status `not_filed`, so it can be filed by hand |
| Creating a GitHub issue fails with a server error | The create is not retried, because GitHub may have saved it. The next call finds the saved issue by its marker instead of filing a duplicate |
| A role uses up its budget | Live SEC requests stop for that role, and answers come from the warehouse |
| `SEC_USER_AGENT` is missing, or the SEC returns 403 | A configuration error that says what to set |
| One company fails to load | That company keeps its previous data, and the others load |

Every tool returns `{ data, sources: [{ name, status, detail, as_of }] }`. Errors are returned as a code and a message, never as a stack trace.

Each call adds one line to `logs/audit.jsonl`:

```json
{"ts":"2026-11-03T04:43:19.889Z","role":"data_engineer","tool":"get_metric","args_sha256":"0641c657…","outcome":"ok","duration_ms":2182,"sec_requests":1,"github_requests":0}
```

The arguments are hashed rather than stored, so the log shows repeated calls without recording what people asked.

## Run it

You need Node.js 22.12 or later.

```bash
git clone https://github.com/zurvaaziz56/ai-infra-filings-mcp.git
cd ai-infra-filings-mcp
npm ci
cp .env.example .env
```

In `.env`, set `SEC_USER_AGENT` to your name and email. The SEC rejects requests without a contact email. Then load the data and build the server:

```bash
npm run load
npm run build
```

The load makes 31 requests and takes under 10 seconds. It stores the data in an embedded Postgres (PGlite) in `./data`.

To use the server from Claude Code:

```bash
claude mcp add ai-infra-filings -e MCP_ROLE=analyst -- node "$PWD/dist/index.js"
```

Other MCP clients take the same command in their JSON configuration:

```json
{
  "mcpServers": {
    "ai-infra-filings": {
      "command": "node",
      "args": ["/absolute/path/to/ai-infra-filings-mcp/dist/index.js"],
      "env": { "MCP_ROLE": "analyst" }
    }
  }
}
```

To let data engineers file issues, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to one repository, with **Issues: Read and write** and nothing else. In `.env`, set `GITHUB_TOKEN` to the token and `GITHUB_REPO` to that repository as `owner/name`. Without them, `file_data_issue` still shows drafts.

To use Postgres instead of PGlite, start it with `docker compose up -d`, run `npm run load` with the owner's `DATABASE_URL`, and give the server the reader's `DATABASE_URL`. Both URLs are in [`.env.example`](.env.example).

## Tests

```bash
npm test
```

The 42 tests make no network requests. They run against small excerpts of real SEC responses in [`test/fixtures`](test/fixtures), and against a fake GitHub that stores issues in memory. The tests cover:

- NVIDIA's tag switch
- the duplicate rule, including Super Micro's 2019 amendments
- rounding compared with restatement
- derived quarters and calendar alignment against the SEC's frames
- Oracle's mis-tagged quarter and Dell's mixed restatement
- access control and per-role budgets
- rate limiting, `Retry-After` and the circuit breaker
- stale fallback and the audit log
- GitHub issue drafts and their evidence
- filing an issue only once, including when a create fails after GitHub saved it
- GitHub rate limits and rejected tokens, without the token ever appearing in output or logs

CI runs the type check, lint and tests on pushes to `main` and on pull requests.

## Evals

The tests check the code. The [evals](evals/README.md) check the workflow: Claude answers 27 analyst questions using only this server, and a deterministic grader checks the numbers, the citations and the refusals.

The first valid run passed 24 of 27. Its failures exposed three things:

- **A silently ignored date filter:** EDGAR was ignoring the search date range.
- **Untraceable citations:** search results had no accession numbers.
- **An unapproved write:** the agent filed a GitHub issue without asking.

Setting up the harness also exposed a startup delay that left MCP clients without tools. After the fixes, four consecutive runs passed 27 of 27.

```bash
npm run eval
```

The agent is Claude Code, so a run needs the `claude` command installed and signed in.

## Limitations

- **US GAAP filers only.** The server reads only us-gaap tags, so foreign companies that report under IFRS, such as TSMC, are not covered.
- **Standard tags only.** The SEC's company-facts API leaves out company-specific tags. As a result, Amazon has no R&D figure, because it reports "technology and infrastructure" under its own tag. NVIDIA's annual capex for fiscal 2020 and 2021 is also missing.
- **Capex means cash paid for property and equipment.** Microsoft, Meta and others also add data-center assets through finance leases. Their headline "capex including finance leases" is higher than the numbers here.
- **History is as restated, not as first known.** The latest filing wins, so the numbers are not what investors saw at the time. First-reported values are kept in each source, but there is no point-in-time query.
- **A tagging error in a later filing wins.** Amazon's 2012 10-K put Q1 2012 revenue against Q1 2011, so the server publishes $13.185B for Q1 2011 instead of $9.857B. The value carries a warning, but it is wrong. [ADR 1](docs/adr/0001-which-filing-wins.md) explains why the rule was kept anyway.
- **Some fourth quarters are left out.** When a year was restated but its 9-month figure was not, Q4 cannot be derived safely, which affects 25 quarters.
- **Limits are per process.** The rate limiter and role budgets live in memory. Several server processes on one machine could together exceed the SEC's limit.
- **Roles are not authenticated.** Over stdio, whoever configures the MCP client chooses `MCP_ROLE`. An HTTP version would take the role from the caller's token.
- **Full-text search is fragile and only returns links.** It uses the endpoint behind EDGAR's full-text search page, and its response format could change without notice.
- **The duplicate check has a ceiling.** It reads up to 1,000 issues in the repository. Past that, the server refuses to file rather than risk a duplicate.
- **Approval before filing is a prompt, not a lock.** The rule that a person approves each GitHub issue lives in the tool's description. The agent followed it in every eval run after the fix, but the protocol does not enforce it.
- **Issues are filed as the token's owner.** The audit log records which role filed an issue, but GitHub shows the token's account as the author.
- **Data refreshes only on load.** The warehouse changes only when `npm run load` runs. `get_metric` with `live: true` rebuilds one company's values on demand.

## License

MIT. The SEC data is public. The repository keeps only the small test excerpts in `test/fixtures`.
