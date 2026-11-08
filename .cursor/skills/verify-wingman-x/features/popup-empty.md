# Popup empty

With no active candidates, the popup tells the person to run their agent and offers Request discovery.

## Sub-features

- `popup-empty-copy` shows the exact empty sentence.
- `popup-empty-port` still shows which daemon port connected.

## How to get to it (user POV)

- Click the Wingman-X toolbar icon when the daemon has no candidates, or when every candidate is dismissed.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` passed on this launch.
- `GET /candidates` returns an empty `candidates` array. A launch that already ran `popup-list` or `popup-dismiss` does not qualify.

- **Open popup.** Run `node .cursor/skills/verify-wingman-x/drive.mjs drive popup-empty`.
- **Empty copy.** The page shows `No candidates yet — run your agent.`
- **Port line.** `[data-testid="port-status"]` reads `Connected to daemon on port <port>` for this run's port.
- **Proof.** The evidence directory receives `popup-empty.png` and `popup-empty.txt`.

## Gotchas

- The helper refuses to drive this feature when any candidate is already stored. Clean up and launch again.
- The sentence is exact, including the em dash between "yet" and "run".
- An unreachable daemon shows `Can't reach Wingman-X daemon. Is it running?` instead of the empty copy. That is the error state, not this feature.
