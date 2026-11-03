# Post-mortem: the first eval run tested an agent with no tools

- **Date:** November 3, 2026. Times are UTC: run times come from the run IDs, and the others are approximate.
- **Author:** Zurva Aziz
- **Impact:** The first full eval run reported 10 of 27 passing. In 23 of the 27 cases the agent had never been connected to the server, and 6 of the 10 passes were refusals made without tools. None of the results were valid. Nothing outside the project was affected.

## What broke

The evals run Claude, through Claude Code in non-interactive mode, against this MCP server, then grade each answer. In the first full run, most answers said something like "I don't have a filings tool in this session, so I won't estimate." The grader scored those answers as if the agent had tried.

That was worse than a run that simply fails. Six cases expect a refusal: Amazon has no R&D tag, a viewer cannot search, and similar. Those six passed, because "I have no tools" matches the phrases the grader accepts as "the data is not available". A 37% score looked like a server with real problems, and half of its passes looked like evidence of good refusals. Both readings were wrong.

## Timeline

- **05:44** The first single-case run answers without tools. The transcript's first event shows the server as `"status": "pending"` with no tools listed.
- **05:46** Starting the server by hand works, but it answers the MCP handshake only after opening its PGlite database, which takes over a second. I change the server to answer first and open the database in the background. The handshake now takes 0.3 seconds, and the single case passes.
- **05:47** The full run, 3 cases at a time, connects in only 4 of 27 cases. It reports 10 of 27.
- **05:49** I add a check that the server was connected, and re-score the saved transcripts: 4 valid cases, 23 not run.
- **05:50** I set `MCP_CONNECT_TIMEOUT_MS=30000` and retry each unconnected case twice. Now 16 of 27 connect. The failures still answer in about 5 seconds, so Claude Code is not waiting at all.
- **05:52** Claude Code's CLI ships as a binary with its JavaScript inside. Reading that code shows that MCP connections in non-interactive mode do not block unless `MCP_CONNECTION_NONBLOCKING` is set to a false value. The 30-second timeout applies only when they block.
- **05:53** With `MCP_CONNECTION_NONBLOCKING=false`, all 27 cases connect. The first valid baseline is 24 of 27.

## Root causes

1. **The server did slow work before answering the handshake.** `src/index.ts` awaited `openDb()` before connecting the transport. Every client had to wait for PGlite before seeing any tools.
2. **The client did not wait.** By default, this version of Claude Code starts the model's first turn with whatever servers are ready. A server that connects a second later is not in that turn, and with one question per run, there is no later turn.
3. **The grader scored answers without checking how they were produced.** It checked what the answer said, not whether the agent could have looked. A refusal and an inability look alike in text.

The first cause alone would only have made the server slow to start. It became an incident because of the second. The third turned the incident into false results.

## How it was diagnosed

The transcripts made the failure visible. The first event of each run lists every MCP server and its status, and `pending` with an empty tool list was unambiguous. Counting connections per run then separated the causes:

| Run | Server connected |
|---|---|
| Before the server fix | 0 of 1 |
| After the server fix | 4 of 27 |
| After the timeout and retries | 16 of 27 |
| After setting the client to wait | 27 of 27 |

The timeout step was the important clue. If the client had been waiting and timing out, a longer timeout would have fixed it, but answers still came back in about 5 seconds. That pointed at the client's mode, not its timing.

## What changed

- **Server:** it now connects at once and opens the database in the background (`deferredDb` in `src/db.ts`). A test checks that tools are listed while the database is still opening. While diagnosing, I also found that the server did not exit when its input closed, because the open database kept the process alive. It now exits then.
- **Runner:** it sets `MCP_CONNECTION_NONBLOCKING=false` and `MCP_CONNECT_TIMEOUT_MS=30000`, and retries a case twice if the server did not connect.
- **Grader:** the first check on every case is "server connected". A case that never connected is reported as "not run" and left out of the score, so it can never pass again.

## What went well

- **Saved transcripts:** full transcripts let me re-score old runs once the check existed, without rerunning them.
- **A second look:** the low score prompted a look at why, instead of server "fixes" aimed at the wrong problem.

## What I would do differently

- **Check the environment before the answers.** An eval result should carry its preconditions: which model ran, which tools it had, whether the servers connected. Without them it is not a result. I added the check after the fact; it belongs in the first version of any harness.
- **Run a canary first.** One case that must call a tool, run alone before the suite, would have caught this in seconds and saved a full run.
- **Make refusal cases prove they could have looked.** Accepting a refusal when the agent had nothing to look with tests the wrong thing.
- **Do not trust a tool's non-interactive defaults.** In print mode, the only sign of the problem was one status field in the first event of each transcript. The setting that fixed it is not mentioned in `claude --help`, so I found it by reading the CLI's code. I would now check how any agent runtime starts its tools before building on it.
