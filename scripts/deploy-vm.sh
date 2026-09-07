#!/bin/zsh
# Deploy the current working tree to the Oracle VM and restart the services.
#   scripts/deploy-vm.sh            # code + .env, build, restart
#   scripts/deploy-vm.sh --state    # also push ~/.wingman-x (KB, watchlist, themes) — NOT processed/candidates/state
set -euo pipefail
HOST="${VM_HOST:-ubuntu@193.122.155.118}"
KEY="${VM_KEY:-$HOME/Downloads/ssh-key-2026-09-05.key}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "→ code"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude 'packages/chime-in-old' \
  --exclude test-results --exclude playwright-report \
  -e "${SSH[*]}" "$ROOT/" "$HOST:~/wingman-x/"

if [[ "${1:-}" == "--state" ]]; then
  echo "→ KB, watchlist, themes, policy (state files left alone)"
  rsync -az -e "${SSH[*]}" "$HOME/.wingman-x/kb/" "$HOST:~/.wingman-x/kb/"
  rsync -az -e "${SSH[*]}" "$HOME/.wingman-x/chime-in/watchlist.csv" "$HOME/.wingman-x/chime-in/themes.txt" "$HOST:~/.wingman-x/chime-in/"
fi

echo "→ waiting for any in-flight scan to finish (marker: ~/.wingman-x/chime-in/scan.inprogress)"
"${SSH[@]}" "$HOST" 'i=0; while [ -f ~/.wingman-x/chime-in/scan.inprogress ] && [ $i -lt 90 ]; do sleep 10; i=$((i+1)); done; if [ -f ~/.wingman-x/chime-in/scan.inprogress ]; then echo "  still scanning after 15 min; restarting anyway"; else echo "  idle"; fi'

echo "→ build + restart"
"${SSH[@]}" "$HOST" 'set -e; cd ~/wingman-x && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build:no-bump >/dev/null 2>&1; i=0; while [ -f ~/.wingman-x/chime-in/scan.inprogress ] && [ $i -lt 90 ]; do sleep 5; i=$((i+1)); done; [ -f ~/.wingman-x/chime-in/scan.inprogress ] && echo "  (busy after build; restarting anyway)" || true; systemctl --user restart wingman-daemon chime-watch && sleep 6 && systemctl --user is-active wingman-daemon chime-watch && journalctl --user -u chime-watch --no-pager -n 4 -o cat'
