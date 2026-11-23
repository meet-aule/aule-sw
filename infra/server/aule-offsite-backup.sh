#!/usr/bin/env bash
# Run as the existing backup-pull user, whose private backup directory stays private.
set -uo pipefail
umask 077
mkdir -p "$HOME/.local/state"
exec 9>"$HOME/.local/state/aule-backup-pull.lock"
flock -n 9 || exit 1

status=0
"$HOME/bin/pull-aule-backups.sh" || status=$?
# A public health-only directory; the publisher refuses a foreign-owned or
# writable directory. The backup directory and credentials stay private.
mkdir -m 755 /var/tmp/aule-backup-health 2>/dev/null || true
python3 "$HOME/.local/lib/aule/offsite-health.py" publish \
  "$HOME/respaldos/aule-sw" /var/tmp/aule-backup-health/latest.json "$status"
