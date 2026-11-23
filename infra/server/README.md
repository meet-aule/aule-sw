# Server

What runs on aule-prod outside the containers, kept here so a new server can be set up from the repository. The live copies are in `/etc/aule/` (root-owned; the settings file `aule.env` holds the secrets and is not here).

| File | On the server | What it does |
|---|---|---|
| `aule-compose.sh` | `/etc/aule/aule-compose.sh` | `docker compose` for this repository with the server's settings: `sudo -u aule-admin /etc/aule/aule-compose.sh up -d --build <service>` |
| `aule-backup.sh` | `/etc/aule/aule-backup.sh` | Encrypted backup of the database, every six hours |
| `RESTORE.md` | `/etc/aule/RESTORE.md` | How to restore one |
| `backup-tests.sh` | (run from the Mac with the key) | Backup and restore tests |

The alerts are in `infra/watch`.

## Offsite copy health

On the offsite host, install `offsite-health.py` at
`/usr/local/lib/aule/offsite-health.py` (root-owned, mode 755), and
`aule-offsite-backup.sh` in the existing pull user's `~/bin/` (mode 750).
Create `/var/lib/aule/backup-health` owned by that user, mode 755. It holds only
`latest.json`, mode 644: a boolean and two timestamps. Keep the backup directory,
SSH credentials and decryption key permissions unchanged.

Replace the existing nightly cron command with `~/bin/aule-offsite-backup.sh`,
keeping its schedule and log. The wrapper locks concurrent runs, calls the
existing `~/bin/pull-aule-backups.sh`, then verifies the newest encrypted file's
SHA-256 and source age before atomically publishing health. Run the publisher
once after a successful copy before updating the external watch, to avoid a
missing-status alert during installation. No mail is sent by the publisher.

This check proves encrypted-copy integrity and freshness. It does not decrypt
or restore a database; `backup-tests.sh` remains the full restore check.

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
