# Watch

Two scripts that mail the team when Aule stops working, and again when it works again. They hold no secrets: each reads its mail credentials from a file on its own machine.

| Script | Runs on | What it checks | Mails through |
|---|---|---|---|
| `aule-watch.sh` | the server (`/etc/aule/aule-watch.sh`, owned and run by `aule-admin`'s cron every 5 minutes) | the platform, the session page, the team's console (on loopback and at admin.meetaule.com), the voice agent, LiveKit, the database, the worker, embeddings, the public page, the shop, disk use under 85 % and a backup younger than 7 hours (taken every 6 hours) | the platform's own SMTP settings in `/etc/aule/aule.env` |
| `aule-watch-outside.sh` | the home server (`~/bin/aule-watch-outside.sh`, its user's cron every 5 minutes) | the public session page, LiveKit and the shop, from outside: the case where the whole server or its network is down; and that the team console's port (8092) on the server answers nobody but Cloudflare, once the server's address is in `~/.config/aule/origin-host` (one line, mode 600; kept off the repository, and the check is skipped without it) | Resend's HTTP API, with the key in `~/.config/aule/resend-key` (mode 600) |

A failure is mailed when it starts and then every six hours while it lasts; a recovery is mailed once. Subjects distinguish `ALERTA`, `RECORDATORIO` and `RECUPERADO`, name the monitor and keep the first failing check visible on a phone. The body lists every failure, successful-check counts, Lima/UTC times and the observed incident duration. It contains no response bodies, raw stderr, application logs or family data. `--test` sends one real test mail.

Both scripts source `aule-watch-common.sh` from their own directory. HTTP probes
retry once after two seconds on the primary monitor (ten-second total timeout
per attempt). The outside monitor retains its twenty-second retry delay and
fifteen-second total timeout. Both use a five-second connection timeout.
A persistent failure reports the HTTP status, curl error category,
elapsed time and attempt count. The existing success criterion remains HTTP
2xx/3xx; this verifies reachability, not an authenticated tutoring session. Queue
and disk failures include only counts/percentages. Troubleshooting instructions
are read-only; recovery mail does not recommend a restart or deployment.

Only a successful send updates the last notified state and time. If delivery
fails, the next check retries the current change, including a recovery; it does
not wait six hours. A successful send means the mail service accepted it, not
that it reached an inbox. Existing state files are kept on upgrade.

Separate `.observed`, `.since` and `.recovered` files beside each `.failing` file
track observations even when mail delivery fails. Durations describe the whole
incident while at least one check is failing, with five-minute sampling, not
the exact outage length of each component. Retrying a recovery mail preserves
the original observed recovery time. An incident already open during upgrade
has an unknown start time, reported as such. Changing an HTTP diagnostic alone
does not send extra mail; reminders show the newest diagnostic.

The server also checks the review queue, even if its worker container is running.
An unfinished job alerts when it exhausts all five attempts or its scheduled run
is more than 15 minutes overdue. Future retries and completed jobs do not alert.
The database query is read-only, has a five-second statement timeout and returns
only a count; a failed query alerts too. It never retries a job or changes its data.

Run the delivery regression tests without contacting a server or sending mail:

```sh
python3 -m unittest discover -s infra/watch -p 'test_*.py' -v
```

To install or update after deployment review, copy the shared helper first and
install the script under the existing cron lock. Install the version that checks
the team's console only once the console answers on the server and at
admin.meetaule.com, or its two checks alert from the first run. Keep the previous files for
rollback; do not delete state files or change credentials/recipients. On the server:

```sh
scp infra/watch/aule-watch{,-common}.sh aule-prod:/tmp/
ssh aule-prod 'sudo flock /home/aule-admin/.local/state/aule/watch.lock sh -c "install -o aule-admin -g aule-admin -m 640 /tmp/aule-watch-common.sh /etc/aule/aule-watch-common.sh && install -o aule-admin -g aule-admin -m 750 /tmp/aule-watch.sh /etc/aule/aule-watch.sh"'
# cron line, in aule-admin's crontab:
# */5 * * * * /usr/bin/flock -n /home/aule-admin/.local/state/aule/watch.lock /etc/aule/aule-watch.sh 2>&1 | /usr/bin/logger -t aule-watch
```

On the outside host, install the helper in `~/bin/aule-watch-common.sh` (mode
640) and the script in `~/bin/aule-watch-outside.sh` (mode 750), as its cron user,
under the existing `~/.local/state/aule/watch-outside.lock`. Install the helper
before the script there too. Validate with `bash -n` and compare file checksums;
the next scheduled run exercises the unchanged delivery route. Do not run
`--test` without approval to send that message. Rollback restores the previous
script and helper under the same lock; legacy scripts ignore the new state files.

The outside watch also reads `/var/tmp/aule-backup-health/latest.json`. The backup
pull user publishes only a success flag and verification/backup timestamps after
the nightly copy. Failed pulls, missing/corrupt files, a newest backup older than
seven hours at copy time, or a verification older than 26 hours alert. The watch
cannot read the backups or the decryption key. See the offsite installation in
[`infra/server/README.md`](../server/README.md).

The primary watch checks weekly restore completion as well. A missing or failed
restore, or one not completed in eight days, uses the same alert/recovery delivery.
New primary backups must be `.sql.gz`; an old encrypted file cannot mask failure
to create the newly configured format.
