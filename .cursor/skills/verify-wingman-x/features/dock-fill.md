# Fill from the dock

On a tweet page, the dock shows the drafted reply. Fill writes that reply into the composer and marks the candidate filled. The extension does not submit the tweet.

## Sub-features

- `dock-fill-mount` shows the dock when `/suggestion` knows the tweet.
- `dock-fill-composer` inserts the drafted reply and enables Tweet.
- `dock-fill-persist` stores `status` `filled`.

## How to get to it (user POV)

- Open a tweet the daemon already has a candidate for. The dock anchors on the page. Choose Fill.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` passed on a fresh launch.
- Tweet id `20` is not already stored.
- `test/fixtures/tweet-detail.html` is the page under test. It is a localhost stand-in for a tweet permalink, with a contenteditable `[data-testid="tweetTextarea_0"]` and a disabled `[data-testid="tweetButtonInline"]`.

- **Seed and open.** Run `node .cursor/skills/verify-wingman-x/drive.mjs drive dock-fill`. The helper POSTs `@jack` / tweet id `20` / reply `Hi Jack, great first tweet.`, serves the fixture at `http://localhost:<port>/jack/status/20`, and opens that URL with the extension loaded.
- **Dock.** `#twh-dock` is visible. The composer is empty and Tweet is disabled.
- **Fill.** The helper clicks `[data-testid="twh-fill"]`. The composer text becomes `Hi Jack, great first tweet.` and Tweet is enabled.
- **Stored copy.** `GET /candidates` lists tweet id `20` with `status` `filled`.
- **Proof.** The evidence directory receives `dock-fill.png`, `dock-fill.txt`, and `candidates-filled.json`.

## Gotchas

- The content script matches `http://localhost/<handle>/status/<id>`, not `127.0.0.1`. A fixture bound only on a raw IP never mounts the dock.
- The fixture enables Tweet only after an `input` event. A DOM write that skips the event fails this drive.
- This journey never clicks Tweet and never opens x.com. A logged-in x.com fill is a different entry point and stays unverified until a run does it.
- The dock does not mount when `/suggestion` returns 404. Seeding tweet id `20` is the precondition, not an optional shortcut.
