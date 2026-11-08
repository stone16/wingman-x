# Wingman-X verification map

This directory is the maintained source for verifying the extension surfaces a person uses. Read this index, then follow one feature file. Launch and doctor are in the parent `SKILL.md`.

## Baseline preconditions

- Run `node .cursor/skills/verify-wingman-x/drive.mjs launch` so the daemon listens with an empty `WINGMAN_X_STATE_DIR`.
- Run `node .cursor/skills/verify-wingman-x/drive.mjs doctor` and require the recorded port, daemon version, and state directory.
- Drive one feature, then `cleanup`, then `launch` again before the next feature.
- Never attach to a daemon this run did not start, including one already bound in 53827 through 53836 or writing `~/.wingman-x`.

## Driving conventions

- Commands below are literal. Run them from the repo root.
- Popup handles are `data-testid` values in `packages/extension/src/popup/`.
- The dock root is `#twh-dock`. Fill uses `[data-testid="twh-fill"]`.
- The helper opens the popup document directly. That is the same `popup.html` the toolbar loads.

## Proof and skip reporting

- Capture the click or the POST and the state after it.
- A screenshot plus the text proof file is the visible half. A second `GET` of `/candidates` or `/signals`, written into the evidence directory, is the stored half.
- Record the feature name on the proof text file.
- If a path cannot be reached, report the command and the missing precondition. Do not mark it verified through a different feature.

## Features

- [Popup list](./popup-list.md) shows one seeded reply in the popup.
- [Popup empty](./popup-empty.md) shows the empty copy when the daemon has no active candidates.
- [Dismiss a candidate](./popup-dismiss.md) removes a card and persists `dismissed`.
- [Request discovery](./request-discovery.md) asks the daemon for a pending `discovery_requested` signal.
- [Fill from the dock](./dock-fill.md) writes the drafted reply into the tweet composer and persists `filled`.
