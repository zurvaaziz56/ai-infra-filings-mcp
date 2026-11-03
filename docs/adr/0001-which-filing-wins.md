# ADR 1: Which filing wins when a period is reported more than once

- **Status:** Accepted
- **Date:** November 2, 2026
- **Decider:** Zurva Aziz

## Context

Every number the server publishes comes from SEC XBRL facts, and most periods are reported more than once. A quarter appears in its own 10-Q, again a year later as a comparative, sometimes in the 10-K, and sometimes in an amendment. For the 15 companies here, 10,284 duration facts from 10-Ks and 10-Qs cover 5,020 distinct tag-and-period combinations, so each is reported about twice on average. When the values differ, the server has to pick one.

The values differ for four different reasons, and each one needs a different answer.

- **Deliberate restatements.** Microsoft restated fiscal 2016 revenue from $85.32B to $91.154B when it adopted the new revenue standard in its 2018 10-K. The new figure is the one comparable with later years.
- **Amendments.** Super Micro's May 2019 10-Q/As restated fiscal 2016 Q1 operating income from $21.44M to $25.205M, after an accounting review. The amendment is the correct figure.
- **Rounding.** CoreWeave's Q2 2025 revenue was $1,212,788,000 in one filing and $1,212,000,000 a year later. Both are correct.
- **Tagging errors.** NVIDIA's fiscal 2018 10-K reported $2.23B for a six-month period that the filings before and after it put at $4.167B. Amazon's 2012 10-K, filed in January 2013, reported Q1 2011 revenue as $13.185B. Three earlier filings say $9.857B, and $13.185B is in fact Amazon's revenue for Q1 2012.

The rule has to be simple enough to explain to an analyst, and every published number must still be traceable to a filing.

## Options considered

### 1. First filing wins

Publish the value as originally reported.

- **For:** It is what investors saw at the time, which is the right basis for backtesting. It ignores later tagging errors, so Amazon's Q1 2011 would be right.
- **Against:** It ignores every correction. Super Micro would show the figure its own amendment replaced, and Microsoft's fiscal 2016 would sit on a different accounting basis from fiscal 2017 onward, so trends would break at the change.

### 2. Latest filing wins, across all of a metric's tags

Publish the value from the most recently filed fact, considering every tag that can carry the metric. Ties go to the tag listed first.

- **For:** One rule handles tag switches, amendments and restatements, and it gives the most consistent basis for trends. It is also the rule the SEC's own frames API uses, so the numbers reconcile with the SEC's cross-company data. The first-reported value can still be kept beside the winner.
- **Against:** A tagging error in a later filing wins. It also mixes bases: a restated annual total can sit next to quarters that were never restated.

### 3. The value most filings agree on wins

Count the filings behind each value and publish the most common one.

- **For:** It rejects a one-off error in a later filing, so Amazon's Q1 2011 would be right.
- **Against:** It rejects one-off corrections just as readily. Microsoft's $85.32B appears in two 10-Ks and the restated $91.154B in one, so the old basis would win. Super Micro's original figure appears in two 10-Qs and the amendment in one, so the replaced figure would win. A restatement starts out outnumbered by the filings it corrects, and for older periods it often stays that way. This rule fails exactly where correctness matters most.

### 4. Keep every version, and choose at query time

Store every value with its filing date, and let each query ask "as reported" or "as of a date".

- **For:** It is the most complete option. It supports both trend analysis and point-in-time questions, and nothing is thrown away.
- **Against:** Every tool, cache and comparison needs a date parameter, and each derived quarter has to be computed per version. Most questions would still need a default, which brings back the original choice. That is too much surface for a first version.

### How the options handle the real cases

| Case | 1. First wins | 2. Latest wins | 3. Most agree |
|---|---|---|---|
| Microsoft FY2016 revenue, restated | Old basis | **Right** | Old basis |
| Super Micro FY2016 Q1, amended | Replaced figure | **Right** | Replaced figure |
| NVIDIA 2017 six-month revenue, error in a middle filing | **Right** | **Right** | **Right** |
| Amazon Q1 2011 revenue, error in the latest filing | **Right** | Wrong | **Right** |
| Oracle FY2020 Q4, the same error in every later 10-K | Wrong | Wrong | Wrong |

## Decision

**Option 2: the latest filing wins, across all of a metric's tags.** A company's later filing is usually a deliberate correction, and the decision favours corrections over occasional tagging errors. The cost is accepted on the condition that every error the rule lets through is visible:

- **First-reported values:** each value keeps its first-reported figure in its sources. `revision` says whether the change was `rounding` or `restated`.
- **Filing conflicts:** a filing that disagrees with the filings before and after it is logged as `conflicting_filing`.
- **Year-to-date checks:** reported quarters are checked against year-to-date totals. A mismatch adds a warning to the values and a `quarters_do_not_sum` issue.
- **Tag-agnostic errors:** for an error repeated in every filing, which no choice of filing can fix, a separate rule applies. When a 10-K's three-month Q4 disagrees with FY − 9M YTD, the statement totals win.

## Consequences

- **History is as restated, not as first known.** The data suits trend analysis but not backtests, because restated history leaks later knowledge into earlier periods. The README says so.
- **A later tagging error can win.** Amazon's Q1 2011 revenue is published as $13.185B instead of $9.857B. It carries a `restated` label and a `quarters_do_not_sum` warning. The label is wrong, because nothing was restated. This is the clearest cost of the decision.
- **Bases can mix.** When an annual total was restated but the 9-month figure before it was not, FY − 9M YTD would combine two bases. Dell's VMware restatement made R&D negative this way. The server leaves such quarters out instead, which affects 25 quarters, each logged as `mixed_restatement`.
- **Same rule as the SEC.** The rule matches the SEC's frames API, so analysts can reconcile the numbers with the SEC's own data, including its errors where the two agree.

## What would change this decision

- **A point-in-time use case.** If anyone needs to know what was known on a given date, move to option 4. The raw facts already keep every version with its filing date, so this is mostly a query and API change, not a reload.
- **Errors like Amazon's becoming common.** The narrow fix: when the latest value disagrees with every earlier filing and also fails the year-to-date check, publish the value the earlier filings agree on, and log the conflict. The count of `quarters_do_not_sum` issues is the signal to watch.
- **Lost fourth quarters.** If the 25 missing quarters matter to users, derive Q4 on the original basis, from the first-reported annual total and the 9-month figure, and label it as such.
