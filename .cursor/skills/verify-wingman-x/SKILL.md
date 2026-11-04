---
name: verify-wingman-x
description: "Drive the Wingman-X Chrome extension against a disposable local daemon and prove popup, dock, and discovery behavior. Use when a change touches the extension popup, the tweet dock, or the daemon endpoints those surfaces call."
disable-model-invocation: true
---

# Verify Wingman-X

Primary surface is the Chrome extension. A person opens the popup, reviews drafted replies, and fills the composer from the dock. The daemon on `127.0.0.1` is the local store those screens read. There is no product CLI. Agent scripts under `packages/agent-kit/scripts/` are out of this map.

Do not drive a daemon this run did not start. The listen range 53827 through 53836 is shared with any other Wingman-X on the machine, and the default state directory is `~/.wingman-x`.

## Launch

From the repo root, with dependencies installed (`npm ci`):

```bash
node .cursor/skills/verify-wingman-x/drive.mjs launch
```

Launch builds `packages/extension/dist`, starts `npm --workspace @wingman-x/daemon run dev` with `WINGMAN_X_STATE_DIR` set to an empty directory under `/tmp/wingman-x-verify-<id>/state`, and waits until that process prints `[daemon] listening on port <port>`. Ready means `GET /health` on that port returns `status: ok` and the popup can resolve the same port. The run record is `/tmp/wingman-x-verify-current.json`.

Playwright Chromium must already be installed for the `playwright` package the helper imports, not the `@playwright/test` binary on `PATH`:

```bash
node node_modules/playwright/cli.js install chromium
```

The helper launches that browser, not Google Chrome and not the user's profile. Branded Chrome blocks `--load-extension`. `npx playwright` in this repo resolves `@playwright/test` and can install a different Chromium build than `import "playwright"` expects.

If a previous run's pid is still alive, launch refuses. Run cleanup first.

## Doctor

```bash
node .cursor/skills/verify-wingman-x/drive.mjs doctor
```

Doctor is read-only. It passes only when all of these are true:

- The pid in the run record is alive.
- `/proc/net/tcp` shows that pid, or a descendant, holding the listening socket for the recorded port.
- That process environment contains `WINGMAN_X_STATE_DIR` equal to the recorded state directory.
- `GET http://127.0.0.1:<port>/health` returns HTTP 200, body `{ "status": "ok", "version": "<packages/daemon/package.json version>" }`, and header `x-twitter-helper-daemon` with the same version.
- `packages/extension/dist/manifest.json` exists and its `name` is `Wingman-X`.

## Drive

One feature per launch. A drive that POSTs candidates or signals leaves state behind, so the next feature needs a fresh launch.

```bash
node .cursor/skills/verify-wingman-x/drive.mjs drive popup-list
node .cursor/skills/verify-wingman-x/drive.mjs drive popup-empty
node .cursor/skills/verify-wingman-x/drive.mjs drive popup-dismiss
node .cursor/skills/verify-wingman-x/drive.mjs drive request-discovery
node .cursor/skills/verify-wingman-x/drive.mjs drive dock-fill
```

The helper opens `chrome-extension://<id>/popup.html` in a tab. That document is the popup the toolbar button loads. The toolbar click itself is not what the helper performs.

`dock-fill` serves `test/fixtures/tweet-detail.html` at `http://localhost:<ephemeral>/jack/status/20`, which matches the extension content-script pattern. The fixture's Tweet button listens for a real `input` event. A fill that only writes `textContent` leaves the button disabled, and the drive fails.

Selectors and end states are in `features/`.

## Evidence

Proof files go to the `evidence` directory named in the run record (`/tmp/wingman-x-verify-<id>/evidence`). Cleanup does not delete that directory.

Each drive writes a screenshot and a text file that names the feature, the page URL, and the visible result. Mutation drives also write the follow-up JSON (`candidates.json`, `candidates-dismissed.json`, `candidates-filled.json`, or `signals.json`) from a second read of the daemon after the click.

A full popup-list proof is:

```bash
node .cursor/skills/verify-wingman-x/drive.mjs prove
```

`prove` runs launch, doctor, `drive popup-list`, then cleanup, and exits non-zero if `popup-list.png`, `popup-list.txt`, or `candidates.json` is missing afterward.

## Cleanup

```bash
node .cursor/skills/verify-wingman-x/drive.mjs cleanup
```

Cleanup signals the recorded daemon process group, signals any Chrome pid whose command line contains this run's chrome directory, deletes the state directory and the chrome profile, and deletes `/tmp/wingman-x-verify-current.json`. Evidence stays.

## Helpers

`drive.mjs` is the only helper. Run it from the repo root with Node 20+. Subcommands are `launch`, `doctor`, `drive <feature>`, `cleanup`, and `prove`.

## Stand-in steps

This harness was proved on a cloud VM, not on a person's logged-in Chrome. These steps will not happen on that machine:

- Playwright downloads its own Chromium. The user's Google Chrome profile is never opened.
- The popup is opened by navigating to `popup.html`, not by clicking the toolbar icon.
- `dock-fill` uses `test/fixtures/tweet-detail.html` on localhost. It does not open x.com, and it does not submit a tweet.
- The candidate body is POSTed by the helper. No discovery agent runs.

Keep the map at `features/`. When a drive cannot find a control the map names, fix the map with `/maintain-verification-skill` and drive again. When the control is there and the product is wrong, fix the product.
