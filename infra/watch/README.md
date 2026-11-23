# Watch

Two scripts that mail the team when Aule stops working, and again when it works again. They hold no secrets: each reads its mail credentials from a file on its own machine.

| Script | Runs on | What it checks | Mails through |
|---|---|---|---|
| `aule-watch.sh` | the server (`/etc/aule/aule-watch.sh`, root-owned, run by `aule-admin`'s cron every 5 minutes) | the platform, the session page, the voice agent, LiveKit, the database, the worker, embeddings, the public page, the shop, disk use under 85 % and a backup younger than 7 hours (taken every 6 hours) | the platform's own SMTP settings in `/etc/aule/aule.env` |
| `aule-watch-outside.sh` | the home server (`~/bin/aule-watch-outside.sh`, its user's cron every 5 minutes) | the public session page, LiveKit and the shop, from outside: the case where the whole server or its network is down | Resend's HTTP API, with the key in `~/.config/aule/resend-key` (mode 600) |

A failure is mailed when it starts and then every six hours while it lasts; a recovery is mailed once. The mail says which check failed and nothing about any family or child. `--test` sends one test mail.

Only a successful send updates the last notified state and time. If delivery
fails, the next check retries the current change, including a recovery; it does
not wait six hours. A successful send means the mail service accepted it, not
that it reached an inbox. Existing state files are kept on upgrade.

Run the delivery regression tests without contacting a server or sending mail:

```sh
python3 -m unittest discover -s infra/watch -p 'test_*.py' -v
```

To install or update on the server:

```sh
scp infra/watch/aule-watch.sh aule-prod:/tmp/
ssh aule-prod 'sudo install -o root -g root -m 755 /tmp/aule-watch.sh /etc/aule/aule-watch.sh && rm /tmp/aule-watch.sh'
# cron line, in aule-admin's crontab:
# */5 * * * * /usr/bin/flock -n /home/aule-admin/.local/state/aule/watch.lock /etc/aule/aule-watch.sh 2>&1 | /usr/bin/logger -t aule-watch
```

The outside watch also reads `/var/lib/aule/backup-health/latest.json`. The backup
pull user publishes only a success flag and verification/backup timestamps after
the nightly copy. Failed pulls, missing/corrupt files, a newest backup older than
seven hours at copy time, or a verification older than 26 hours alert. The watch
cannot read the backups or the decryption key. See the offsite installation in
[`infra/server/README.md`](../server/README.md).
