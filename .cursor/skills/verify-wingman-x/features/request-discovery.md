# Request discovery

Request discovery asks the local agent, via the daemon, to look for new tweets. The popup confirms the request. The daemon keeps a pending signal until something acks it.

## Sub-features

- `request-discovery-status` shows the requested-at confirmation.
- `request-discovery-signal` stores a pending `discovery_requested` signal.

## How to get to it (user POV)

- Open the popup with no candidates and choose Request discovery.
- Open the popup with a candidate list and choose Request discovery under the list.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` passed on this launch.
- Either the empty state or the list state is on screen, so a Request discovery button exists.

- **Click.** Run `node .cursor/skills/verify-wingman-x/drive.mjs drive request-discovery`. The helper opens the popup and clicks the first visible `[data-testid="twh-request-discovery-empty"]` or `[data-testid="twh-request-discovery-list"]`.
- **Confirmation.** The matching status node shows text that starts with `Requested at`.
- **Stored copy.** `GET /signals?kind=discovery_requested&status=pending` returns at least one signal with that kind and status.
- **Proof.** The evidence directory receives `request-discovery.png`, `request-discovery.txt`, and `signals.json`.

## Gotchas

- The success sentence includes the local time, so assert the `Requested at` prefix, not a full timestamp.
- `No daemon connection.` means the popup never resolved a port. Doctor should already have failed that run.
- `Request failed — check daemon log.` means the POST did not succeed. Do not treat the button click alone as a pass.
- This drive does not ack the signal. A second click on the same launch adds another pending signal.
