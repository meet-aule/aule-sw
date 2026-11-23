#!/usr/bin/env bash
# Backup tests for Aule's database, run from the Mac that holds the private key.
# Decrypted data only flows through pipes: it is never written to a disk, and it
# is restored into a throwaway Postgres on aule-prod with no network, in memory,
# removed at the end. Only counts and statuses are printed.
set -euo pipefail
GPG=(gpg --homedir "$HOME/.config/aule/backup-gpg" --batch --pinentry-mode error --quiet --decrypt)
RUN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TEST="aule-restore-test-$RUN"
NET="aule-restore-net-$RUN"
MIGRATE="aule-restore-migrate-$RUN"
container_created=0; network_created=0
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass + 1)); }
ko() { echo "FAIL  $*"; fail=$((fail + 1)); return 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none aule-prod "$@"; }
offsite() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none aule-agent "$@"; }
cleanup() {
  local status=$?
  trap - EXIT
  # A migration can still be running after an interrupted SSH connection.
  if [ "$(remote "docker inspect '$MIGRATE' --format '{{index .Config.Labels \"aule.restore-test\"}}' 2>/dev/null" || true)" = "$RUN" ]; then
    remote "docker rm -f '$MIGRATE' >/dev/null" || status=1
  fi
  if [ "$container_created" = 1 ]; then remote "docker rm -f '$TEST' >/dev/null" || status=1; fi
  if [ "$network_created" = 1 ]; then remote "docker network rm '$NET' >/dev/null" || status=1; fi
  echo "== $pass passed, $fail failed; exit $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

COUNTS_SQL="select format('select %L, count(*) from public.%I', table_name, table_name)
  from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
  and table_name <> '_sqlx_migrations' order by 1 \gexec"

echo "== 1. a backup made exactly the way cron makes it"
started=$(remote 'date +%s')
remote 'sudo -n -u aule-admin env -i HOME=/home/aule-admin PATH=/usr/local/bin:/usr/bin:/bin SHELL=/bin/sh sh -c "cd \$HOME && umask 077; /usr/bin/flock -n /home/aule-admin/.local/state/aule/aule-backup.lock /etc/aule/aule-backup.sh >> /home/aule-admin/.local/state/aule/aule-backup.log 2>&1"' \
  && ok "backup script exited 0 under cron's environment" || ko "backup script failed under cron's environment"
# Production counts right after the dump, to compare with its restore.
prod_counts=$(remote "echo \"$COUNTS_SQL\" | docker exec -i aule-sw-postgres-1 sh -c 'psql -At -F\" \" -U \$POSTGRES_USER -d \$POSTGRES_DB'")
newest=$(remote 'sudo -n -u aule-admin bash -c "cd / && ls -1t /var/lib/aule/backups/aule-sw/*/aule-*.sql.gz.gpg | head -1"')
oldest=$(remote 'sudo -n -u aule-admin bash -c "cd / && ls -1tr /var/lib/aule/backups/aule-sw/*/aule-*.sql.gz.gpg | head -1"')
[ "$(remote "sudo -n -u aule-admin stat -c %Y '$newest'")" -ge "$started" ] && ok "a fresh backup was created" || ko "backup script did not create a fresh file"
remote "sudo -n -u aule-admin tail -1 /home/aule-admin/.local/state/aule/aule-backup.log" | grep -q "backup: $newest" \
  && ok "the log names the new file" || ko "the log does not name the new file"

echo "== 2. every backup file is whole"
# sha256sum answers in the machine's language ("La suma coincide" on a Spanish
# one); the checks below read its English "OK", so the language is fixed.
checks=$(remote 'sudo -n -u aule-admin bash -c "set -e; cd /; for f in /var/lib/aule/backups/aule-sw/*/*.sha256; do (cd \$(dirname \$f) && LC_ALL=C sha256sum -c \$(basename \$f)); done"') || ko "backup checksum verification failed"
while read -r line; do
  case "$line" in *": OK") ok "checksum ${line%%:*}" ;; *) ko "checksum $line" ;; esac
done <<<"$checks"
size=$(remote "sudo -n -u aule-admin stat -c %s $newest")
[ "$size" -gt 100000 ] && ok "newest file is $size bytes (not empty or cut)" || ko "newest file is only $size bytes"
# The first packet names the key it is encrypted to; anything else is not a backup we can read.
# (\| alternation is not portable to the Mac's grep, which made this check pass whatever it saw.)
# Only the start of the file is read, so gpg complains about the rest: its
# listing is kept and checked apart from its exit status.
packets=$(remote "sudo -n -u aule-admin head -c 4096 $newest" | gpg --list-packets --batch 2>/dev/null || true)
grep -q -E "pubkey enc packet: .*keyid 26CC75B6BC18FD63" <<<"$packets" \
  && ok "encrypted to the backup key (subkey 26CC75B6BC18FD63)" || ko "not encrypted to the backup key (subkey 26CC75B6BC18FD63)"

restore() { # Restore an encrypted file into the throwaway database.
  remote "sudo -n -u aule-admin cat $1" | "${GPG[@]}" | gunzip \
    | remote "docker exec -i '$TEST' psql -q -v ON_ERROR_STOP=1 -U aule -d aule >/dev/null 2>/dev/null"
}
counts() { remote "echo \"$COUNTS_SQL\" | docker exec -i $TEST psql -At -F' ' -U aule -d aule"; }

echo "== 3. restores into a throwaway database"
image=$(remote "docker inspect aule-sw-postgres-1 --format '{{.Image}}'")
platform_image=$(remote "docker inspect aule-sw-platform-1 --format '{{.Image}}'")
PW=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
# An internal network: the test database and the platform's migrate reach each other and nothing else.
remote "docker network create --internal '$NET' >/dev/null"
network_created=1
remote "docker create --name '$TEST' --network '$NET' --log-driver none --memory 1g --memory-swap 1g --tmpfs /var/lib/postgresql/data:rw,size=2g -e POSTGRES_USER=aule -e POSTGRES_PASSWORD=$PW -e POSTGRES_DB=aule '$image' >/dev/null"
container_created=1
remote "docker start '$TEST' >/dev/null"
ready=0
for _ in $(seq 1 30); do
  if remote "docker exec '$TEST' pg_isready -U aule -d aule -q"; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || ko "throwaway database did not become ready"

if restore "$newest" newest; then ok "newest backup restores with no error (ON_ERROR_STOP)"; else ko "newest backup did not restore"; fi
restored=$(counts)
tables=$(echo "$restored" | grep -c .)
[ "$tables" -ge 25 ] && ok "$tables tables restored" || ko "only $tables tables restored"
same=0; differ=0
while read -r table n; do
  p=$(echo "$prod_counts" | awk -v t="$table" '$1 == t {print $2}')
  if [ "$p" = "$n" ]; then same=$((same + 1)); else differ=$((differ + 1)); echo "      $table: production $p, restored $n"; fi
done <<<"$restored"
if [ "$differ" -eq 0 ]; then
  ok "every table has the same number of rows as the post-backup sample ($same tables)"
else
  echo "INFO  $differ tables differ from the live sample; concurrent writes and housekeeping can change counts"
fi
total=$(echo "$restored" | awk '{s += $2} END {print s}')
echo "      ($total rows in all)"
remote "docker exec $TEST psql -At -U aule -d aule -c \"select extname from pg_extension order by 1\"" | tr '\n' ' ' | grep -q "vector" \
  && ok "extensions restored (pgvector included)" || ko "pgvector missing after restore"
restored_history=$(remote "docker exec $TEST psql -At -U aule -d aule -c 'select string_agg(version::text, chr(44) order by version) from _sqlx_migrations where success'")
prod_history=$(remote "echo 'select string_agg(version::text, chr(44) order by version) from _sqlx_migrations where success' | docker exec -i aule-sw-postgres-1 sh -c 'psql -At -U \$POSTGRES_USER -d \$POSTGRES_DB'")
[ "$restored_history" = "$prod_history" ] && ok "migration history matches production ($prod_history)" || ko "migration history differs: restored [$restored_history], production [$prod_history]"

if restore "$newest" again; then ok "restoring the same backup again over it works (--clean --if-exists)"; else ko "restoring over an existing copy failed"; fi
[ "$(counts)" = "$restored" ] && ok "the second restore gives the same rows" || ko "the second restore differs"

migrate() {
  local output status=0
  output=$(remote "docker run --rm --name '$MIGRATE' --label aule.restore-test='$RUN' --log-driver none --network '$NET' -e DATABASE_URL=postgres://aule:$PW@$TEST:5432/aule -e AULE_ADMIN_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') '$platform_image' migrate >/dev/null" 2>&1) || status=$?
  # Error details can contain rows: only expose the expected refusal marker.
  if [[ "$output" == *pre-baseline* ]]; then echo pre-baseline; fi
  return "$status"
}
version() { remote "docker exec $TEST psql -At -U aule -d aule -c 'select max(version) from _sqlx_migrations'"; }
current=$(remote "echo 'select max(version) from _sqlx_migrations' | docker exec -i aule-sw-postgres-1 sh -c 'psql -At -U \$POSTGRES_USER -d \$POSTGRES_DB'")
migrate && [ "$(version)" = "$current" ] && ok "the platform finds the restored copy up to date (migration $current)" || ko "migrate on the restored copy failed or moved it"

echo "== 4. an old backup: refused by the platform, brought back with the pre-baseline image"
if [ "$oldest" != "$newest" ]; then
  remote "docker exec $TEST psql -q -U aule -d aule -c 'drop schema public cascade; create schema public;'" >/dev/null 2>&1 && ok "schema emptied"
  if restore "$oldest" oldest; then ok "oldest backup kept ($(basename "$oldest"), migration $(version)) restores"; else ko "oldest backup did not restore"; fi
  old_version=$(version)
  if [ "$old_version" -ge 16 ] 2>/dev/null; then
    migrate && [ "$(version)" = "$current" ] && ok "old backup migrated from $old_version to $current" || ko "migrate failed on a baseline-compatible backup"
  else
    if out=$(migrate); then
      ko "the platform started on a pre-baseline backup"
    elif [ "$out" = pre-baseline ]; then
      ok "the platform refuses it, naming the pre-baseline image"
    else
      ko "refused without the expected pre-baseline message"
    fi
    [ "$(version)" = "$old_version" ] && ok "left as it was (migration $old_version)" || ko "the refusal changed it"
    # The documented way back: the pre-baseline image brings it to 16, then the platform converts it.
    legacy_image=$(remote "docker image inspect aule-sw-platform:pre-baseline --format '{{.Id}}'")
    remote "docker run --rm --name '$MIGRATE' --label aule.restore-test='$RUN' --log-driver none --network '$NET' -e DATABASE_URL=postgres://aule:$PW@$TEST:5432/aule -e AULE_ADMIN_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') '$legacy_image' migrate >/dev/null 2>&1" \
      && [ "$(version)" = "16" ] && ok "the pre-baseline image brought it to migration 16" || ko "the pre-baseline image did not reach 16 (at $(version))"
    migrate && [ "$(version)" = "$current" ] && ok "then the platform converted it (migration $current)" || ko "the conversion after the pre-baseline image failed"
  fi
  old_rows=$(counts | awk '{s += $2} END {print s}')
  [ "${old_rows:-0}" -gt 0 ] && ok "the old backup's data is there ($old_rows rows)" || ko "no rows"
fi

echo "== 5. the offsite copy is current, intact and restorable"
checks=$(offsite 'set -e; for f in "$HOME"/respaldos/aule-sw/*/*.sha256; do (cd "$(dirname "$f")" && LC_ALL=C sha256sum -c "$(basename "$f")"); done') || ko "offsite checksum verification failed"
while read -r line; do
  case "$line" in *": OK") ok "offsite checksum ${line%%:*}" ;; *) ko "offsite checksum $line" ;; esac
done <<<"$checks"
replica=$(offsite 'ls -1t "$HOME"/respaldos/aule-sw/*/aule-*.sql.gz.gpg | head -1')
replica_age=$(offsite "echo \$((\$(date +%s) - \$(stat -c %Y '$replica')))")
# Nightly replication of six-hourly dumps: allow a full cycle plus one dump interval.
[ "$replica_age" -ge 0 ] && [ "$replica_age" -le 108000 ] && ok "offsite backup is within 30 hours" || ko "offsite backup is stale or future-dated"
origin="/var/lib/aule/backups/aule-sw/${replica##*/aule-sw/}"
origin_hash=$(remote "sudo -n -u aule-admin sha256sum '$origin'" | cut -d ' ' -f 1)
replica_hash=$(offsite "sha256sum '$replica'" | cut -d ' ' -f 1)
[ "$origin_hash" = "$replica_hash" ] && ok "offsite ciphertext matches the original" || ko "offsite copy differs from the original"
offsite "cat '$replica'" | "${GPG[@]}" | gunzip \
  | remote "docker exec -i '$TEST' psql -q -v ON_ERROR_STOP=1 -U aule -d aule >/dev/null 2>/dev/null" \
  && ok "offsite backup restores with no error" || ko "offsite backup did not restore"
replica_counts=$(counts)
[ "$(echo "$replica_counts" | grep -c .)" -ge 25 ] && ok "offsite tables restored" || ko "offsite tables missing"
migrate && [ "$(version)" = "$current" ] && ok "offsite backup migrates to the current schema" || ko "offsite migration failed"

remote "docker rm -f '$TEST' >/dev/null"
container_created=0
remote "docker network rm '$NET' >/dev/null"
network_created=0
ok "throwaway database and network removed"
[ "$fail" -eq 0 ]
