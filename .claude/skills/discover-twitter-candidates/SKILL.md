---
name: discover-twitter-candidates
description: Discover Twitter candidates and draft voice-matched replies for review in the local WingmanX daemon.
---

# Discover Twitter Candidates

Follow the instructions in [../../../docs/agent-workflow.md](../../../docs/agent-workflow.md).

## Scope

- Read `tone.md` and `handles.md` from `~/.wingman-x/kb/`; select only
  `library/` notes relevant to the candidate topics.
- Attach to an already-logged-in Chrome profile through CDP
  (`CDP_URL`, default `http://127.0.0.1:9223`) and use the
  `packages/agent-kit/scripts/scrape-x-*.ts` scraper path.
- **On start, check for pending pull-signals**:
  `createDaemonClient(port).listSignals({ kind: "discovery_requested",
  status: "pending" })`. The extension's "Request discovery" button
  writes these — their presence is a priority hint the user wants a
  fresh batch. Run discovery regardless (signals are hints, not gates).
- Generate 3–10 candidate replies per invocation using bounded handle/profile
  scraping from the configured every-run handles and rotation pool.
- POST via the daemon-client exported from `@twitter-helper/agent-kit`
  (`createDaemonClient(port).postCandidates([...])`).
- **After a successful POST**, ack every pending signal picked up above:
  `createDaemonClient(port).ackSignal(id)` per signal.

## Output

Each run ends with a single call to
`createDaemonClient(port).postCandidates([...])` using the exact
`Candidate` shape documented in
[`docs/agent-workflow.md#candidate-json-shape`](../../../docs/agent-workflow.md#candidate-json-shape).

## Failure Handling

On login gate, rate limit, DOM churn, or unreachable daemon: follow the
recovery strategy in
[`docs/agent-workflow.md#failure-modes`](../../../docs/agent-workflow.md#failure-modes)
and surface the failure class to the user. Do **not** auto-retry within a
single run.
