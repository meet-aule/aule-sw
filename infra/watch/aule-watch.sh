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

ENV=/etc/aule/aule.env
STATE_DIR=/home/aule-admin/.local/state/aule
STATE="$STATE_DIR/watch.failing"
LAST_MAIL="$STATE_DIR/watch.last-mail"
RECIPIENTS=(admin@meetaule.com gonzalo@meetaule.com)
REMIND_SECONDS=$((6 * 3600))
mkdir -p "$STATE_DIR"

# shellcheck source=infra/watch/aule-watch-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/aule-watch-common.sh" || exit 1
# Resolve the helper before changing directory; relative invocations work too.
# find and friends need a working directory this user can read.
cd /

healthy() {
  local status
  status=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)
  case "$status" in
    healthy) return 0 ;;
    unhealthy|starting) CHECK_DETAIL="Docker: $status" ;;
    *) CHECK_DETAIL="Docker: estado de salud no disponible" ;;
  esac
  return 1
}
running() {
  CHECK_DETAIL="Docker: contenedor detenido o no disponible"
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]
}
reports_ok() {
  local overdue
  CHECK_DETAIL="no se pudo consultar la cola de informes"
  overdue=$(docker exec --env 'PGOPTIONS=-c statement_timeout=5000 -c default_transaction_read_only=on' \
    aule-sw-postgres-1 psql -X -qAt -v ON_ERROR_STOP=1 -U aule -d aule -c \
    "select count(*) from jobs where done_at is null
       and (attempts >= 5 or run_at < now() - interval '15 minutes')") || return 1
  [[ "$overdue" =~ ^[0-9]+$ ]] || return 1
  CHECK_DETAIL="$overdue trabajos atrasados o sin reintentos"
  [ "$overdue" = 0 ]
}
# The tutor's model provider, asked once with the agent's own key: one token
# out, about a millionth of a dollar. A lack of credit or a refused key is then
# known before a family's session meets it (on 2026-11-25 the credit ran out
# mid-session and the tutor went silent). Only the outcome is read, and an
# answer that is neither is asked once more before it counts.
MODEL_PROBE='
import anthropic
try:
    anthropic.Anthropic(max_retries=0, timeout=20).messages.create(
        model="claude-haiku-5-5", max_tokens=1, extra_body={"thinking": {"type": "disabled"}},
        messages=[{"role": "user", "content": "ok"}])
    print("ok")
except anthropic.BadRequestError as error:
    print("credit" if "credit balance" in str(error).lower() else "error")
except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
    print("key")
except Exception:
    print("error")
'
model_ok() {
  local outcome try
  for try in 1 2; do
    outcome=$(docker exec aule-sw-agent-1 python -c "$MODEL_PROBE" 2>/dev/null)
    case "$outcome" in
      ok) return 0 ;;
      credit) CHECK_DETAIL="Anthropic: la organización se quedó sin crédito"; return 1 ;;
      key) CHECK_DETAIL="Anthropic: rechazó la clave del tutor"; return 1 ;;
    esac
    [ "$try" = 1 ] && sleep 5
  done
  CHECK_DETAIL="Anthropic no respondió a una pregunta mínima"
  return 1
}
disk_ok() {
  local used
  CHECK_DETAIL="no se pudo medir el disco"
  used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
  [[ "$used" =~ ^[0-9]{1,3}$ ]] || return 1
  used=$((10#$used))
  [ "$used" -le 100 ] || return 1
  CHECK_DETAIL="$used % usado; umbral: 85 %"
  [ "$used" -lt 85 ]
}
# A backup every six hours (aule-backup.sh): one younger than seven.
backup_ok() {
  CHECK_DETAIL="no se encontró una copia .sql.gz de las últimas 7 h"
  [ -n "$(find /var/lib/aule/backups/aule-sw -name '*.sql.gz' -mmin -420 -print -quit)" ]
}
restore_ok() {
  local stamp
  CHECK_DETAIL="falta una prueba de restauración válida de los últimos 8 días"
  stamp=$(cat "$STATE_DIR/restore.ok") || return 1
  [[ "$stamp" =~ ^[1-9][0-9]{9}$ ]] && [ "$stamp" -le "$now" ] && [ $((now - stamp)) -lt $((8 * 86400)) ]
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
    printf 'Date: %s\r\n' "$(date -R)"
    printf 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
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
  mail "Aule: prueba de alertas" "Las alertas de $host están activas ($when). Revisan cada 5 minutos: plataforma, página, consola del equipo, tutor, modelo del tutor (crédito y clave), LiveKit, base de datos, worker, embeddings, página pública, consola pública, tienda, disco y respaldo cada 6 horas. Si algo falla llega un correo, y otro cuando vuelve a funcionar."
  exit $?
fi

check "plataforma (API)" http http://127.0.0.1:8091/healthz
check "página de sesión" http http://127.0.0.1:8090/session/healthz
check "consola del equipo" http http://127.0.0.1:8092/healthz
check "consola pública (admin.meetaule.com)" http https://admin.meetaule.com/healthz
check "tutor (agente de voz)" http http://127.0.0.1:8081/
check "modelo del tutor (Anthropic: crédito o clave)" model_ok
check "LiveKit (audio)" http http://127.0.0.1:7880/
check "base de datos" healthy aule-sw-postgres-1
check "worker (informes y avisos)" running aule-sw-worker-1
check "informes (atrasados más de 15 min o sin reintentos)" reports_ok
check "embeddings (memoria)" running aule-sw-embeddings-1
check "página pública (playground.meetaule.com)" http https://playground.meetaule.com/session/
check "tienda (shop.meetaule.com)" http https://shop.meetaule.com/
check "disco (85 % o más usado)" disk_ok
check "respaldo (ninguno en 7 h)" backup_ok
check "restauración (falló o sin prueba en 8 días)" restore_ok

help="Para comprobar los contenedores:
ssh aule-prod
docker ps
Consulta los logs del contenedor afectado con: docker logs --since 15m --tail 80 <contenedor>"
if [[ " ${failing[*]} " == *"página pública"* && " ${failing[*]} " != *"página de sesión"* ]]; then
  help="La página local respondió. Revisa DNS, TLS y el proxy o la conectividad pública antes de reiniciar la aplicación.
curl -I --max-time 15 https://playground.meetaule.com/session/

$help"
fi
watch_notify "$host" "$help"
