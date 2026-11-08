# Popup list

The popup lists each active candidate the daemon is holding, with the author handle, the tweet, the drafted reply, Open, and Dismiss.

## Sub-features

- `popup-list-card` renders the seeded candidate as one card.
- `popup-list-port` shows the daemon port the popup actually fetched.

## How to get to it (user POV)

- Click the Wingman-X toolbar icon after the daemon has at least one candidate that is not dismissed.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` passed on this launch.
- No candidate with tweet id `9001` is stored yet.

- **Seed.** The helper POSTs one candidate (`@wingman_verify`, tweet id `9001`, reply `Verified reply from the Wingman-X popup journey.`). Run `node .cursor/skills/verify-wingman-x/drive.mjs drive popup-list`.
- **Open popup.** The helper opens `popup.html`. A card `[data-testid="twh-popup-card"][data-id="9001"]` is visible and contains `@wingman_verify` and the full drafted reply.
- **Port line.** The footer `[data-testid="twh-popup-port-status"]` contains the port from the run record.
- **Stored copy.** `GET /candidates` still lists tweet id `9001` with `status` `pending`, and `state.json` has that key.
- **Proof.** The evidence directory receives `popup-list.png`, `popup-list.txt`, and `candidates.json`.

## Gotchas

- The card `data-id` is the tweet id, not the candidate `id` field (`cand-verify-9001`).
- The list footer test id is `twh-popup-port-status`. The empty-state footer test id is `port-status`.
- Dismissed candidates are filtered out of the list. A prior `popup-dismiss` on this same launch hides the card even though the row remains in `state.json`.
