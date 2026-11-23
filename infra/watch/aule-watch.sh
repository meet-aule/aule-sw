#!/usr/bin/env bash
# Watches Aule's services on this server and mails the team when something
# stops working, and again when everything works again. Run by aule-admin's
# cron every five minutes:
#
#   /etc/aule/aule-watch.sh          check, and mail on a change
#   /etc/aule/aule-watch.sh --test   send one test mail
#
# A failure is mailed when it starts and then every six hours while it lasts.
# The mail goes through the platform's own SMTP settings in /etc/aule/aule.env
# and says only which checks failed: nothing about a family or a child.
# When this whole server is down nothing here runs; aule-watch-outside.sh on
# the home server watches the public pages from outside.
set -uo pipefail
umask 077
# find and friends need a working directory this user can read.
cd /

ENV=/etc/aule/aule.env
STATE_DIR=/home/aule-admin/.local/state/aule
STATE="$STATE_DIR/watch.failing"
LAST_MAIL="$STATE_DIR/watch.last-mail"
RECIPIENTS=(admin@meetaule.com gonzalo@meetaule.com)
REMIND_SECONDS=$((6 * 3600))
mkdir -p "$STATE_DIR"

failing=()
check() { # name, then the command that succeeds when all is well
  local name=$1
  shift
  "$@" >/dev/null 2>&1 || failing+=("$name")
}
http() { curl -fsS -o /dev/null --max-time 10 "$1"; }
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
disk_ok() { [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 85 ]; }
# A backup every six hours (aule-backup.sh): one younger than seven.
backup_ok() { [ -n "$(find /var/lib/aule/backups/aule-sw -name '*.sql.gz' -mmin -420 -print -quit)" ]; }
restore_ok() {
  local stamp
  stamp=$(cat "$STATE_DIR/restore.ok") || return 1
  [[ "$stamp" =~ ^[0-9]{10}$ ]] && [ "$stamp" -le "$now" ] && [ $((now - stamp)) -lt $((8 * 86400)) ]
}

mail() { # subject, body
  local url from msg rcpt=()
  url=$(grep -m1 '^AULE_SMTP_URL=' "$ENV" | cut -d= -f2-)
  from=$(grep -m1 '^AULE_MAIL_FROM=' "$ENV" | cut -d= -f2- | grep -o '[^<> ]*@[^<> ]*')
  [ -n "$url" ] && [ -n "$from" ] || return 1
  for to in "${RECIPIENTS[@]}"; do rcpt+=(--mail-rcpt "$to"); done
  msg=$(mktemp)
  {
    printf 'From: Aule <%s>\r\n' "$from"
    printf 'To: %s\r\n' "$(IFS=,; echo "${RECIPIENTS[*]}")"
    # The subject may have accents: encoded as the mail standard asks.
    printf 'Subject: =?UTF-8?B?%s?=\r\n' "$(printf '%s' "$1" | base64 -w0)"
    printf 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    printf '%s\r\n' "$2"
  } >"$msg"
  # The address may hold the mail password: it goes to curl as a config line on
  # its standard input, never on the command line, where ps would show it.
  local quoted=${url//\\/\\\\}
  printf 'url = "%s"\n' "${quoted//\"/\\\"}" | curl -fsS --max-time 30 --ssl-reqd --config - --mail-from "$from" "${rcpt[@]}" --upload-file "$msg" >/dev/null
  local sent=$?
  rm -f "$msg"
  return $sent
}

host=$(hostname)
now=$(date +%s)
when=$(date -u '+%Y-%m-%d %H:%M UTC')

if [ "${1:-}" = "--test" ]; then
  mail "Aule: prueba de alertas" "Las alertas de $host están activas ($when). Revisan cada 5 minutos: plataforma, página, tutor, LiveKit, base de datos, worker, embeddings, página pública, tienda, disco y respaldo cada 6 horas. Si algo falla llega un correo, y otro cuando vuelve a funcionar."
  exit $?
fi

check "plataforma (API)" http http://127.0.0.1:8091/healthz
check "página de sesión" http http://127.0.0.1:8090/session/healthz
check "tutor (agente de voz)" http http://127.0.0.1:8081/
check "LiveKit (audio)" http http://127.0.0.1:7880/
check "base de datos" healthy aule-sw-postgres-1
check "worker (informes y avisos)" running aule-sw-worker-1
check "embeddings (memoria)" running aule-sw-embeddings-1
check "página pública (playground.meetaule.com)" http https://playground.meetaule.com/session/
check "tienda (shop.meetaule.com)" http https://shop.meetaule.com/
check "disco (más de 85 % usado)" disk_ok
check "respaldo (ninguno en 7 h)" backup_ok
check "restauración (falló o sin prueba en 8 días)" restore_ok

current=$(printf '%s\n' "${failing[@]+"${failing[@]}"}" | sed '/^$/d' | sort)
previous=$(cat "$STATE" 2>/dev/null || true)
last=$(cat "$LAST_MAIL" 2>/dev/null || echo 0)

subject=""
details=$current
if [ "$current" != "$previous" ] && [ -n "$current" ]; then
  subject="Aule: falla $(echo "$current" | paste -sd, - | sed 's/,/, /g')"
  body="En $host, $when, falla:"
elif [ "$current" != "$previous" ]; then
  subject="Aule: todo funciona de nuevo"
  body="En $host, $when, volvió a funcionar lo que fallaba:"
  details=$previous
elif [ -n "$current" ] && [ $((now - last)) -ge $REMIND_SECONDS ]; then
  subject="Aule: sigue fallando $(echo "$current" | paste -sd, - | sed 's/,/, /g')"
  body="En $host, $when, sigue fallando:"
fi
[ -n "$subject" ] || exit 0

body="$body
$(echo "$details" | sed 's/^/- /')

Para mirar: ssh aule-prod, luego docker ps y docker logs <contenedor>.
Desplegar de nuevo: sudo -u aule-admin /etc/aule/aule-compose.sh up -d --build <servicio>."
# Keep the last delivered state if mail fails, so the next check retries even
# a recovery or a changed incident within the six-hour reminder window.
mail "$subject" "$body" || exit $?
printf '%s\n' "$now" >"$LAST_MAIL" || exit 1
printf '%s\n' "$current" | sed '/^$/d' >"$STATE"
