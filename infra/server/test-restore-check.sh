#!/usr/bin/env bash
# Disposable synthetic data on a CI runner; never target an existing database.
set -euo pipefail
umask 077
SOURCE="aule-restore-fixture-$$"
ROOT=$(mktemp -d)
cleanup() { docker rm -fv "$SOURCE" >/dev/null 2>&1 || true; rm -rf "$ROOT"; }
trap cleanup EXIT
image=pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd
docker run -d --name "$SOURCE" --network none --log-driver none \
  --tmpfs /var/lib/postgresql/data:rw,size=1g \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=aule -e POSTGRES_DB=aule "$image" >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$SOURCE" pg_isready -U aule -q >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec -i "$SOURCE" psql -X -v ON_ERROR_STOP=1 -U aule -d aule >/dev/null <<'SQL'
create extension vector;
create table _sqlx_migrations (version bigint, success boolean);
insert into _sqlx_migrations values (1, true);
do $$ begin for n in 1..25 loop
  execute format('create table fixture_%s (n integer)', n);
  execute format('insert into fixture_%s values (42)', n);
end loop; end $$;
SQL
mkdir -p "$ROOT/backups/day" "$ROOT/state"
BACKUP="$ROOT/backups/day/aule-20261123T120000Z.sql.gz"
docker exec "$SOURCE" pg_dump -U aule --clean --if-exists --no-owner --no-privileges aule | gzip > "$BACKUP"
(cd "$(dirname "$BACKUP")" && sha256sum "$(basename "$BACKUP")" > "$(basename "$BACKUP").sha256")
export AULE_BACKUP_ROOT="$ROOT/backups" AULE_RESTORE_STATE="$ROOT/state" AULE_POSTGRES_CONTAINER="$SOURCE"
bash infra/server/aule-restore-check.sh
test -s "$ROOT/state/restore.ok"
test -z "$(docker ps -aq --filter label=aule.restore-check)"
# A well-compressed, checksummed file with invalid SQL must still fail restore.
printf 'this is not SQL;\n' | gzip > "$BACKUP"
(cd "$(dirname "$BACKUP")" && sha256sum "$(basename "$BACKUP")" > "$(basename "$BACKUP").sha256")
if bash infra/server/aule-restore-check.sh; then echo 'invalid SQL was accepted' >&2; exit 1; fi
test ! -e "$ROOT/state/restore.ok"
test -z "$(docker ps -aq --filter label=aule.restore-check)"
echo 'PASS synthetic restore and failure cleanup'
