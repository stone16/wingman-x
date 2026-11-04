# Dismiss a candidate

Dismiss removes the card from the popup and stores the candidate as dismissed so a later open does not show it again.

## Sub-features

- `popup-dismiss-card` removes the card after Dismiss.
- `popup-dismiss-persist` stores `status` `dismissed` on the daemon.

## How to get to it (user POV)

- Open the popup, then choose Dismiss on a candidate card.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` passed on a fresh launch.
- Tweet id `9001` is not already stored.

- **Seed and open.** Run `node .cursor/skills/verify-wingman-x/drive.mjs drive popup-dismiss`. The helper POSTs the same `@wingman_verify` candidate as popup list, then opens the popup.
- **Dismiss.** It clicks `[data-testid="twh-popup-dismiss"]` inside `[data-testid="twh-popup-card"][data-id="9001"]`.
- **Empty popup.** The page then shows `No candidates yet — run your agent.`
- **Stored copy.** `GET /candidates` still returns tweet id `9001`, now with `status` `dismissed`.
- **Proof.** The evidence directory receives `popup-dismiss.png`, `popup-dismiss.txt`, and `candidates-dismissed.json`.

## Gotchas

- The popup removes the card before the POST returns. A screenshot of the empty popup alone does not prove the daemon stored `dismissed`. The drive fails unless the second GET says `dismissed`.
- The action path is `/candidates/<tweet_id>/action` with body `{ "action": "dismissed" }`. The state key is the tweet id.
