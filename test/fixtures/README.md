# Test fixtures

Excerpts of real SEC responses, downloaded on November 2, 2026. Values are unchanged. The only trimming is which facts are kept.

| File | Source | Kept |
|---|---|---|
| `company-tickers.json` | `https://www.sec.gov/files/company_tickers.json` | The six companies below |
| `<ticker>-submissions.json` | `https://data.sec.gov/submissions/CIK##########.json` | Name, tickers, industry, fiscal year end, and the two latest 10-K or 10-Q filings |
| `nvda-companyfacts.json` | `https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json` | Both capex tags for periods ending 2019-01 to 2022-01, and `Revenues` for periods ending 2017-04 to 2017-08 |
| `orcl-companyfacts.json` | `.../CIK0001341439.json` | Both revenue tags for fiscal 2020 |
| `msft-companyfacts.json` | `.../CIK0000789019.json` | Capex for fiscal 2025 |
| `smci-companyfacts.json` | `.../CIK0001375365.json` | Operating income for fiscal 2016, including the 2019 amendments |
| `dell-companyfacts.json` | `.../CIK0001571996.json` | R&D for fiscal 2021 |
| `crwv-companyfacts.json` | `.../CIK0001769628.json` | Revenue for the first half of 2025 |
| `search-anthropic.json` | `https://efts.sec.gov/LATEST/search-index?q=Anthropic&forms=10-K,10-Q` | The total and the first two hits, with only the fields the server reads |
