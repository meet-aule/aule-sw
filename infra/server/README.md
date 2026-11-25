# Server

What runs on aule-prod outside the containers, kept here so a new server can be set up from the repository. The live copies are in `/etc/aule/` (root-owned; the settings file `aule.env` holds the secrets and is not here).

| File | On the server | What it does |
|---|---|---|
| `aule-compose.sh` | `/etc/aule/aule-compose.sh` | `docker compose` for this repository with the server's settings: `sudo -u aule-admin /etc/aule/aule-compose.sh up -d --build <service>` |
| `aule-origin-guard.sh`, `aule-origin-guard.service` | `/etc/aule/aule-origin-guard.sh`, `/etc/systemd/system/aule-origin-guard.service` | Keeps the ports Cloudflare forwards to (8090, 7880, 8092) behind the origin firewall, from boot |
| `aule-backup.sh` | `/etc/aule/aule-backup.sh` | Compressed, unencrypted backup of the database, every six hours |
| `RESTORE.md` | `/etc/aule/RESTORE.md` | How to restore one |
| `aule-restore-check.sh` | `/etc/aule/aule-restore-check.sh` | Weekly restore of a new backup into a temporary database |
| `backup-tests.sh` | (run from the Mac with the key) | Backup and restore tests |

Each image carries the commit it is built from ([RELEASING.md](../../RELEASING.md)), so
after any new commit a rebuilt service restarts even when its own code did not change.
Name only the services that changed. Restarting `agent` ends the sessions in progress,
so name it, or no service (which rebuilds them all), only when no session is open.

The alerts are in `infra/watch`.

## Team console

The team's console (`apps/admin`, compose service `admin`) answers at
https://admin.meetaule.com through its Cloudflare Worker (`infra/edge`), on port
8092.

- **Its own env file**, `/etc/aule/admin.env` (owned by root, group
  `aule-admin`, mode 640), holds `ADMIN_EDGE_SECRET=`, the same value as the
  Worker's `EDGE_SECRET` (`openssl rand -hex 32`). No other service reads it,
  and `aule.env` is not touched. Only once it is there does `aule-compose.sh`
  set `AULE_ADMIN_HOST=0.0.0.0` so the Worker can reach the console; until then
  it listens on loopback. With the secret, the console gives every request
  without it the same 404, except `/healthz` from this machine, and it does not
  start on a public address without one.
- **The origin firewall.** `aule-origin-guard.sh` gives each of 8090 (the
  playground), 7880 (LiveKit's signalling) and 8092 one jump from raw
  `PREROUTING` to the `AULE_ORIGIN` chain, for IPv4 and IPv6. The chain and its
  Cloudflare ranges are the store repository's `deploy/origin-firewall.sh`'s;
  the guard never touches the ranges. `aule-origin-guard.service` runs it at
  boot before Docker, so each port is guarded before anything listens there;
  if the chain is not there yet, the guard makes one that lets in only this
  machine, until the store's script lets Cloudflare in. It can run any number
  of times. From outside, `curl -m 5 http://<server>:8092/healthz` must time
  out. A ufw rule for 8092 is needed only if ufw is what lets 8090 in.
- **From Cloudflare to the server the hop is plain http**, as the playground's
  is: the console's cookie, the sign-in codes and the families' data cross the
  network unencrypted between Cloudflare and the server, where anyone on the
  way could read them. The Worker's secret proves the request came through it;
  it hides nothing. A Cloudflare Tunnel, or a certificate at the origin with
  Cloudflare checking it, would close that; neither is set up yet.

```sh
# Once, as root
install -o root -g root -m 750 infra/server/aule-origin-guard.sh /etc/aule/aule-origin-guard.sh
install -o root -g root -m 644 infra/server/aule-origin-guard.service /etc/systemd/system/aule-origin-guard.service
systemctl daemon-reload && systemctl enable --now aule-origin-guard.service
```

It keeps no tutoring state, so it can be rebuilt on its own at any time, with
sessions open (pull and build under `umask 002`, as for every service):

```sh
sudo -u aule-admin bash -c 'umask 002; /etc/aule/aule-compose.sh up -d --build --no-deps admin'
```

A restart signs the team out, and also clears its sign-in limits for a team
member locked out by them. The playground still restarts only when no session
is open (`select count(*) from sessions where status <> 'ended'` is 0): the
console's «En vivo» page says so in one line, «Ninguna sesión abierta: se puede
desplegar.».

**Taking someone off the team.** The team is `AULE_ADMIN_EMAILS` in
`/etc/aule/aule.env`, which the console and the platform each read when they
start. Take the address out, then restart the console alone, with sessions
open:

```sh
sudo -u aule-admin bash -c 'umask 002; /etc/aule/aule-compose.sh up -d --no-deps admin'
```

That alone shuts them out at once: the console sends them no code, refuses
their passkeys even while the platform still counts them as the team (it
checks the address the platform names), and its restart signs the whole team
out, ending every platform session it held. Restart the platform and its
worker at the next moment with no session open, so that the platform's own list
and its Staff check agree; `--no-deps`, since postgres reads the same file and
would otherwise be recreated:

```sh
sudo -u aule-admin bash -c 'umask 002; /etc/aule/aule-compose.sh up -d --no-deps --no-build platform worker'
```

Their passkeys stay stored and open nothing. To delete them, and every session
they opened, at any time:

```sh
docker exec -i aule-sw-postgres-1 sh -c 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
delete from team_passkeys where guardian_id = (select id from guardians where email = '<address>');
SQL
```

The first deploy goes in this order:

1. this `aule-compose.sh` into `/etc/aule/`, the previous copy kept;
2. the platform and its worker, with no session open: the console needs their
   routes for the team, and against an older platform it signs nobody in and
   shows wrong pages;
3. the origin guard, then the console's env file;
4. the console, checked on loopback (`/healthz`);
5. the Worker, with its two secrets (`infra/edge/README.md`);
6. a sign-in with a team address;
7. the watch's new checks (`infra/watch/README.md`);
8. only then, with no session open, the playground without its old panel.

Until step 8, no playground rebuild: built from a checkout with the console in
it, the playground loses the old panel at once. Rolling the platform back takes
the console down with it, since the console needs the platform's routes for
the team.

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
