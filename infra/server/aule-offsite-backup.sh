#!/usr/bin/env bash
# Run as the existing backup-pull user, whose private backup directory stays private.
set -uo pipefail
umask 077
mkdir -p "$HOME/.local/state"
exec 9>"$HOME/.local/state/aule-backup-pull.lock"
flock -n 9 || exit 1

status=0
"$HOME/bin/pull-aule-backups.sh" || status=$?
python3 /usr/local/lib/aule/offsite-health.py publish \
  "$HOME/respaldos/aule-sw" /var/lib/aule/backup-health/latest.json "$status"
