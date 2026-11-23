# Restoring Aule's database

Backups are made every six hours by `/etc/aule/aule-backup.sh` and kept in `/var/lib/aule/backups/aule-sw/YYYY-MM-DD/` on the server (14 days) and in `~aule-agent/respaldos/aule-sw/` on the home server (180 days, pulled every night at 04:40). New files are unencrypted `.sql.gz` dumps, mode 600 in private directories. Historical `.sql.gz.gpg` dumps are encrypted to the key "Aule backups (aule-prod)", fingerprint F83F 6EAA 4847 DD58 18EA 5C8D 90DB CEBC A27B DDC5.

The private key is NOT on either server. It is on Gonzalo's Mac: `~/.config/aule/aule-backup-private-key.asc`, and the keyring in `~/.config/aule/backup-gpg`. Keep it to read all historical encrypted backups. New `.sql.gz` files need no key.

## Restore

A backup can be older than the code, and restoring it over newer tables fails (they depend on what it drops). So the schema is emptied first, and the platform brings the restored data up to date by itself when it starts.

1. Check the file: `sha256sum -c aule-STAMP.sql.gz.sha256` (or the `.gpg.sha256` sidecar for an old backup).
2. Stop what writes to the database:
   `ssh aule-prod 'sudo -u aule-admin /etc/aule/aule-compose.sh stop platform worker agent'`
3. Empty the schema:
   `ssh aule-prod "sudo -u aule-admin /etc/aule/aule-compose.sh exec -T postgres psql -U aule -d aule -c 'drop schema public cascade; create schema public;'"`
4. For a new `.sql.gz`, restore on the server without a key:

       sudo -u aule-admin sh -c 'gzip -dc /var/lib/aule/backups/aule-sw/DAY/aule-STAMP.sql.gz | /etc/aule/aule-compose.sh exec -T postgres psql -v ON_ERROR_STOP=1 -U aule -d aule'

   For an old encrypted backup, from the Mac (decrypted SQL only flows through pipes):

       ssh aule-prod 'sudo -u aule-admin cat /var/lib/aule/backups/aule-sw/DAY/aule-STAMP.sql.gz.gpg' \
         | gpg --homedir ~/.config/aule/backup-gpg --batch --decrypt \
         | gunzip \
         | ssh aule-prod 'sudo -u aule-admin /etc/aule/aule-compose.sh exec -T postgres psql -v ON_ERROR_STOP=1 -U aule -d aule'

5. Start them again; the platform applies the migrations newer than the backup:
   `ssh aule-prod 'sudo -u aule-admin /etc/aule/aule-compose.sh up -d platform worker agent'`

### Backups from before the baseline

On 2026-11-20 migrations 0001 to 0016 were collapsed into `0017_baseline.sql`. A backup taken before that records migrations 1 to 16. Restored as above, the platform sees all sixteen, marks the backup as having run the baseline instead (its schema is the same, nothing in it changes), and migrates on from there.

A backup older than migration 16 (some of 1 to 16 missing) is refused at start with an error that says so. Migration 16 went live on 2026-11-20 at 18:05 UTC, so **every backup taken before 2026-11-20 19:02 UTC is in this case**. Restore it in two steps: run the platform image tagged `pre-baseline` (git tag `pre-baseline`) once against it, which brings it to 16, take a backup of that, and restore that backup with the current image. Such backups stop existing once the oldest backup kept (180 days at home) is from after the cutover.

## Test

`infra/server/aule-restore-check.sh` restores the newest unencrypted primary
backup weekly on the server; see README.md for isolation, checks and alerts.

`infra/server/backup-tests.sh` is the manual historical encrypted-backup test,
run from the Mac with both SSH aliases available. It verifies existing
encrypted copies without invoking the new backup writer. It checks every primary and offsite checksum. The newest
offsite copy must be at most 30 hours old and match the original ciphertext.

It restores the newest primary backup twice, the oldest primary backup through
the documented migration path, and the newest offsite backup. Postgres rejects
any SQL error. Row counts from the first restore are compared with a live sample
(concurrent writes can change that sample); the second restore must match the
first exactly. Migration checks use the images currently running in production.

Each run owns a separate database and internal network, without published ports.
The database uses a memory filesystem with swap disabled and container logging
disabled; SQL errors are not printed because they can contain row values. The
private key stays on the Mac and decrypted SQL flows through pipes. Cleanup runs
on success, failure and interrupt. A lost SSH connection or forced kill can still
require an operator to remove the resources named for that run. Production
services and database contents are not changed.
