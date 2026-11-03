# Data notes

What the SEC data for the 15 companies actually looks like, from a load on November 2, 2026. Accession numbers identify the filings. Open any of them at `https://www.sec.gov/Archives/edgar/data/<CIK>/<accession without dashes>/`.

## Metric map

| Metric | Tags, in tie-break order |
|---|---|
| `capex` | `PaymentsToAcquirePropertyPlantAndEquipment`, `PaymentsToAcquireProductiveAssets` |
| `revenue` | `RevenueFromContractWithCustomerExcludingAssessedTax`, `Revenues`, `SalesRevenueNet`, `RevenueFromContractWithCustomerIncludingAssessedTax` |
| `rd_expense` | `ResearchAndDevelopmentExpense`, `ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost` |
| `operating_income` | `OperatingIncomeLoss` |

These tags appear in the data but are left out on purpose:

| Tag | Why it is left out |
|---|---|
| `SalesRevenueGoodsNet` | Product revenue only. Amazon, Microsoft and Dell report it next to total revenue. |
| `PaymentsForProceedsFromProductiveAssets` | Capex net of proceeds from selling assets, a different measure. Used by Amazon (2015–2018), Oracle (2008–2011) and AMD (recent 10-Ks). |
| `PaymentsToAcquireOtherPropertyPlantAndEquipment` | One component of capex. Used by Dell (2016–2020) and Salesforce (2014–2018). |

The SEC's company-facts API includes only standard taxonomies, so company-specific tags never arrive. Amazon reports "technology and infrastructure" instead of R&D, under its own tag, so `rd_expense` is empty for Amazon.

## Which tag each company used, and when

Periods are the first and last period ends of values that the duplicate rule kept. They overlap where both tags were filed for the same period.

| Company | FYE | capex | revenue | rd_expense |
|---|---|---|---|---|
| AAPL | 09-26 | ProductiveAssets 2007-09–2013-06<br>PP&E 2013-09–2026-06 | SalesRevenueNet 2007-09–2016-09<br>Revenues 2016-09–2017-09<br>RevenueFromContract 2017-09–2026-06 | R&D 2007-09–2026-06 |
| AMD | 12-26 | PP&E 2008-12–2026-06 | SalesRevenueNet 2010-12–2016-12<br>RevenueFromContract 2016-12–2026-06 | R&D 2008-12–2026-06 |
| AMZN | 12-31 | PP&E 2007-12–2017-03<br>ProductiveAssets 2016-12–2026-09 | SalesRevenueNet 2007-12–2016-12<br>RevenueFromContract 2016-12–2026-09 | none |
| AVGO | 11-01 | PP&E 2016-10–2026-08 | Revenues 2016-10–2017-10<br>RevenueFromContract 2017-10–2026-08 | R&D 2016-10–2026-08 |
| CRM | 01-31 | PP&E 2008-01–2026-07 | Revenues 2008-01–2017-01<br>RevenueFromContract 2017-01–2026-07 | R&D 2008-01–2026-07 |
| CRWV | 12-31 | PP&E 2023-12–2026-06 | RevenueFromContract 2023-12–2026-06 | R&D 2023-12–2026-06 |
| DELL | 01-29 | PP&E 2015-01–2026-07 | SalesRevenueNet 2015-01–2017-02<br>Revenues 2017-02–2026-07 | R&D 2015-01–2026-07 |
| GOOGL | 12-31 | PP&E 2013-12–2026-09 | Revenues 2013-12–2026-09<br>RevenueFromContract 2016-12–2024-03 | R&D 2013-12–2026-09 |
| META | 12-31 | PP&E 2010-12–2026-09 | Revenues 2010-12–2016-09<br>RevenueFromContract 2016-12–2026-09 | R&D 2010-12–2026-09 |
| MSFT | 06-30 | PP&E 2008-06–2026-09 | Revenues 2007-09–2009-06<br>SalesRevenueNet 2009-06–2016-09<br>RevenueFromContract 2016-06–2026-09 | R&D 2008-06–2026-09 |
| NVDA | 01-31 | PP&E 2010-01–2019-07<br>ProductiveAssets 2019-10–2026-07 | Revenues 2008-01–2026-07<br>RevenueFromContract 2017-01–2020-01 | R&D 2008-01–2026-07 |
| ORCL | 05-31 | PP&E 2010-05–2026-08 | Revenues 2008-05–2017-02<br>RevenueFromContract 2017-05–2026-08 | R&D 2009-05–2026-08 |
| PLTR | 12-31 | PP&E 2018-12–2026-06 | RevenueFromContract 2018-12–2026-06<br>RevenueFromContract incl. tax 2019-09 | R&D 2018-12–2026-06 |
| SMCI | 06-30 | PP&E 2010-06–2026-06 | SalesRevenueNet 2010-06–2015-06<br>Revenues 2015-06–2017-06<br>RevenueFromContract 2017-06–2026-06 | R&D 2010-06–2026-06 |
| SNOW | 01-31 | PP&E 2019-01–2026-07 | RevenueFromContract 2019-01–2026-07 | R&D 2019-01–2026-07 |

## Problems found, with evidence

| Problem | Evidence | What the server does |
|---|---|---|
| Tag switch | NVIDIA's last capex fact under `PaymentsToAcquirePropertyPlantAndEquipment` covers the period ending 2020-07-26. From its November 2020 10-Q on, it uses `PaymentsToAcquireProductiveAssets`, including for comparatives back to 2019-10-27. | One metric covers both tags. `tag_usage` shows the switch. |
| The same period in many filings | 10,467 raw facts for 4,022 values. NVIDIA reports 23 of its 32 capex periods under the old tag more than once. | The latest filing wins. |
| Amendments that restate | Super Micro's 10-Q/As filed on 2019-05-17 restated fiscal 2016: Q1 operating income went from $21.44M (10-Q, 2015-11-16) to $25.205M. | The amendment wins. The source keeps the first-reported value, and `revision` is `restated`. 181 values are restated. |
| Rounding changes between filings | CoreWeave's Q2 2025 revenue is $1,212,788,000 in its 2025 10-Q and $1,212,000,000 in its 2026 10-Q. | `revision` is `rounding`, not `restated`. |
| A filing that disagrees with the filings before and after it | NVIDIA's fiscal 2018 10-K (0001045810-18-000010) reports $2.23B of revenue for the six months to 2017-07-30, which is Q2 alone. The 10-Qs before and after report $4.167B. | Logged as `conflicting_filing`. 28 such cases, most of them in Oracle's 2010–2011 filings. |
| A full year tagged as a quarter | Oracle's 10-Ks for fiscal 2018 to 2022 tag annual revenue with a three-month Q4 period, for example $39.068B for March to May 2020 (0001564590-22-023675). The SEC's frames API repeats it as Oracle's revenue for CY2020Q2. | FY − 9M YTD wins over a conflicting three-month Q4, giving $10.439B. Logged as `conflicting_quarter` (7 cases). |
| Restated totals mixed with old ones | Dell restated fiscal 2021 R&D to $2.455B after the VMware spin-off, but not its 9-month figure, so FY − 9M YTD gives −$1.43B. | The quarter is left out and logged as `mixed_restatement` (25 cases). |
| Quarters that do not add up | Microsoft's fiscal 2016 quarters add up to $85.3B of revenue, but the 10-K filed in 2018 reports $91.154B for the year, restated for the new revenue standard. | The values carry a warning, logged as `quarters_do_not_sum` (21 cases). |
| Values that are not there | NVIDIA's annual capex for fiscal 2020 and 2021 is not filed under any standard tag, so Q4 of those years cannot be derived. | Logged as `missing_quarter` (37 cases). |
| `fy` and `fp` describe the filing, not the period | Dell's 10-Q filed on 2025-12-09 reports the quarter ending 2024-11-01 with `fy` 2026. | Fiscal periods are computed from dates. `fy` and `fp` are kept only in raw facts. |
| 52/53-week years | NVIDIA's fiscal year end is listed as 01-31, but its fiscal 2026 ended on 2026-01-25. Dell's fiscal 2024 ended on 2024-02-02. | Fiscal year ends match within 10 days. |
| Inconsistent JSON | `cik` in company facts is a number for most filers and a zero-padded string for CoreWeave. | The type allows both. |
| The SEC enforces its User-Agent rule | Requests with no User-Agent, or one without an email, get 403. | The client refuses to send a request without an email in `SEC_USER_AGENT`. |

## Calendar periods

The SEC assigns each fact to a calendar "frame" such as `CY2024Q3`. A period's frame is the calendar quarter or year holding its midpoint, except that periods centred on a boundary go to the later one. A July-to-June year counts as the year it ends in. Moving the midpoint 3 days later reproduces 65,272 of the 65,273 frames the SEC assigned across these 15 companies. The one miss is Dell's 52-day stub period from 2016-09-07 to 2016-10-28, around the EMC merger.
