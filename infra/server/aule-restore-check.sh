#!/usr/bin/env bash
# Weekly, local to the server. No private key, network, published port, SQL log,
# or persistent database volume. Only a successful completion timestamp survives.
set -euo pipefail
umask 077
ROOT=${AULE_BACKUP_ROOT:-/var/lib/aule/backups/aule-sw}
STATE=${AULE_RESTORE_STATE:-/home/aule-admin/.local/state/aule}
SOURCE=${AULE_POSTGRES_CONTAINER:-aule-sw-postgres-1}
mkdir -p "$STATE"
exec 9>"$STATE/restore.lock"
flock -n 9 || exit 0
RUN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TEST="aule-restore-check-$RUN"
created=0
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$created" = 1 ]; then docker rm -fv "$TEST" >/dev/null 2>&1 || status=1; fi
  if [ "$status" != 0 ]; then
    rm -f "$STATE/restore.ok"
    echo 'FAIL backup restore check' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Names come only from the backup script. Ignore partial files and old ciphertext.
latest=$(find "$ROOT" -mindepth 2 -maxdepth 2 -type f -name 'aule-*.sql.gz' -printf '%T@ %p\n' | sort -rn | sed -n '1s/^[^ ]* //p')
[ -n "$latest" ] && [ ! -L "$latest" ]
age=$(( $(date +%s) - $(stat -c %Y "$latest") ))
[ "$age" -ge 0 ] && [ "$age" -le 25200 ]
[ "$(stat -c %a "$latest")" = 600 ]
# The checksum sidecar must name exactly this file, not an arbitrary path.
expected="$(sha256sum "$latest" | cut -d ' ' -f 1)  $(basename "$latest")"
[ "$(cat "$latest.sha256")" = "$expected" ]
gzip -t "$latest" 2>/dev/null

image=$(docker inspect "$SOURCE" --format '{{.Image}}')
# Use the already-running database's immutable image; never download during cron.
docker create --pull never --name "$TEST" --label "aule.restore-check=$RUN" \
  --network none --log-driver none --memory 1g --memory-swap 1g --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,size=1g \
  -e POSTGRES_USER=aule -e POSTGRES_DB=aule -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" >/dev/null
created=1
docker start "$TEST" >/dev/null
ready=0
for _ in $(seq 1 30); do
  if docker exec "$TEST" pg_isready -U aule -d aule -q >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ]
gzip -dc "$latest" | docker exec -i "$TEST" psql -X -q -v ON_ERROR_STOP=1 -U aule -d aule >/dev/null 2>/dev/null
verified=$(docker exec "$TEST" psql -X -qAt -v ON_ERROR_STOP=1 -U aule -d aule -c \
  "select (select count(*) >= 25 from information_schema.tables where table_schema = 'public')
   and exists(select 1 from pg_extension where extname = 'vector')
   and exists(select 1 from _sqlx_migrations where success)
   and not exists(select 1 from _sqlx_migrations where not success)" 2>/dev/null)
[ "$verified" = t ]
docker rm -fv "$TEST" >/dev/null
created=0
date +%s > "$STATE/restore.ok.part"
mv "$STATE/restore.ok.part" "$STATE/restore.ok"
echo 'PASS backup restored; schema, extension and migration history readable; test database removed'
