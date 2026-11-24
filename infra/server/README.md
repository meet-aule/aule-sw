# Server

What runs on aule-prod outside the containers, kept here so a new server can be set up from the repository. The live copies are in `/etc/aule/` (root-owned; the settings file `aule.env` holds the secrets and is not here).

| File | On the server | What it does |
|---|---|---|
| `aule-compose.sh` | `/etc/aule/aule-compose.sh` | `docker compose` for this repository with the server's settings: `sudo -u aule-admin /etc/aule/aule-compose.sh up -d --build <service>` |
| `aule-backup.sh` | `/etc/aule/aule-backup.sh` | Compressed, unencrypted backup of the database, every six hours |
| `RESTORE.md` | `/etc/aule/RESTORE.md` | How to restore one |
| `aule-restore-check.sh` | `/etc/aule/aule-restore-check.sh` | Weekly restore of a new backup into a temporary database |
| `backup-tests.sh` | (run from the Mac with the key) | Backup and restore tests |

The alerts are in `infra/watch`.

## Offsite copy health

On the offsite host, install the same `offsite-health.py` in both the existing
pull and watch users' `~/.local/lib/aule/` (mode 750), and `aule-offsite-backup.sh`
in the pull user's `~/bin/` (mode 750). No root installation or new privilege is
needed. The wrapper creates `/var/tmp/aule-backup-health`, owned by `aule-agent`,
mode 755. Publisher and reader verify ownership and reject writable or symlinked
status directories. It holds only
`latest.json`, mode 644: a boolean and two timestamps. Keep the backup directory,
SSH credentials and decryption key permissions unchanged.

Replace the existing nightly cron command with `~/bin/aule-offsite-backup.sh`,
keeping its schedule and log. The wrapper locks concurrent runs, calls the
existing `~/bin/pull-aule-backups.sh`, then verifies the newest backup file's
SHA-256 and source age before atomically publishing health. Run the publisher
once after a successful copy before updating the external watch, to avoid a
missing-status alert during installation. No mail is sent by the publisher.

This check proves copy integrity and freshness, for both `.sql.gz` and historical
`.sql.gz.gpg` files. It does not restore a database.

## Weekly restore

New backups use gzip without encryption, as requested by the owner. Existing
ciphertext and the private key are kept. Backup files are mode 600 and directories
700 on both hosts; anyone who can read a new file can read the database. SSH
still encrypts the offsite transfer. Do not make backup directories web-accessible.

Install `aule-restore-check.sh` as `/etc/aule/aule-restore-check.sh`, mode 750,
owned by the existing backup operator. Run it once successfully before enabling
the watch check. Schedule Sundays at 07:10 in the server's current timezone:

```cron
10 7 * * 0 /usr/bin/timeout --kill-after=30s 20m /etc/aule/aule-restore-check.sh >> /home/aule-admin/.local/state/aule/restore.log 2>&1
```

It verifies a primary backup younger than seven hours, then restores every SQL
statement with `ON_ERROR_STOP` into an isolated Postgres using the currently
running image (no pull). The container has no network or published port, a tmpfs
database, 1 GiB memory limit and no container log. It checks table count, pgvector
and successful migration history, then removes the container and volumes.
It never queries production rows. Failure removes the success stamp; the existing
five-minute watch alerts on failure or a stamp older than eight days.
A hard host failure may require removing the container labeled `aule.restore-check`.

The optional `AULE_BACKUP_ROOT`, `AULE_RESTORE_STATE`, and `AULE_POSTGRES_CONTAINER`
environment overrides isolate synthetic CI fixtures; production uses the defaults.
Historical encrypted backups can still be tested with `backup-tests.sh` from the
Mac. Keep its private key; this weekly test does not test old ciphertext or migrate
old schema versions.

Test without real backups or credentials:

```sh
python3 -m unittest discover -s infra/server -p 'test_*.py' -v
```

`aule-admin`'s crontab on the server:

```
SHELL=/bin/sh
PATH=/usr/local/bin:/usr/bin:/bin
25 */6 * * * umask 077; /usr/bin/flock -n /home/aule-admin/.local/state/aule/aule-backup.lock /etc/aule/aule-backup.sh >> /home/aule-admin/.local/state/aule/aule-backup.log 2>&1
*/5 * * * * /usr/bin/flock -n /home/aule-admin/.local/state/aule/watch.lock /etc/aule/aule-watch.sh 2>&1 | /usr/bin/logger -t aule-watch
17 * * * * /opt/aule/infra/scripts/prune-docker-cache.sh 2>&1 | /usr/bin/logger -t aule-docker-cache
```
