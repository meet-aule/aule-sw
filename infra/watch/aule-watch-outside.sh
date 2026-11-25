#!/usr/bin/env bash
# Watches Aule from outside its server, so the team hears of it when the whole
# server (aule-prod) or its network is down and its own watch cannot run.
# Run by this user's cron every five minutes on the home server:
#
#   ~/bin/aule-watch-outside.sh          check, and mail on a change
#   ~/bin/aule-watch-outside.sh --test   send one test mail
#
# It only fetches public pages, and checks that the team console's port on the
# server answers nobody but Cloudflare. A failure is mailed when it starts and
# then every six hours while it lasts, through Resend's HTTP API with the key in
# ~/.config/aule/resend-key (mode 600). The server's own checks are
# /etc/aule/aule-watch.sh on aule-prod.
set -uo pipefail
umask 077

KEY_FILE="$HOME/.config/aule/resend-key"
# The server's public address, kept on this machine and not in the repository
# (one line, mode 600). Without it, the console's port is not checked.
ORIGIN_FILE="$HOME/.config/aule/origin-host"
STATE_DIR="$HOME/.local/state/aule"
STATE="$STATE_DIR/watch-outside.failing"
LAST_MAIL="$STATE_DIR/watch-outside.last-mail"
FROM="Aule <hola@meetaule.com>"
RECIPIENTS='["admin@meetaule.com", "gonzalo@meetaule.com"]'
REMIND_SECONDS=$((6 * 3600))
mkdir -p "$STATE_DIR"

# shellcheck source=infra/watch/aule-watch-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/aule-watch-common.sh" || exit 1
cd /
backup_ok() {
  CHECK_DETAIL="copia o verificación externa fallida, ausente o demasiado antigua"
  python3 "$HOME/.local/lib/aule/offsite-health.py" check /var/tmp/aule-backup-health/latest.json
}

console_closed() { # the team console's port must not answer from here
  local origin
  origin=$(tr -d '[:space:]' < "$ORIGIN_FILE")
  if [ -z "$origin" ]; then
    CHECK_DETAIL="no hay dirección del servidor en $ORIGIN_FILE"
    return 1
  fi
  CHECK_DETAIL="el puerto 8092 del servidor responde desde fuera de Cloudflare: falta la regla del cortafuegos de origen"
  ! curl -s -o /dev/null --connect-timeout 5 --max-time 8 "http://$origin:8092/healthz"
}

mail() { # subject, body
  [ -r "$KEY_FILE" ] || return 1
  local payload
  payload=$(python3 -c 'import json, sys; print(json.dumps({"from": sys.argv[1], "to": json.loads(sys.argv[2]), "subject": sys.argv[3], "text": sys.argv[4]}))' \
    "$FROM" "$RECIPIENTS" "$1" "$2") || return 1
  # The key goes in through a file descriptor, never on curl's command line,
  # where anyone on the machine could read it with ps.
  curl -fsS --max-time 30 -o /dev/null https://api.resend.com/emails \
    -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$KEY_FILE")") \
    -H "Content-Type: application/json" \
    --data-binary "$payload"
}

when=$(date -u '+%Y-%m-%d %H:%M UTC')

if [ "${1:-}" = "--test" ]; then
  mail "Aule: prueba del vigía externo" "El vigía externo de Aule está activo ($when, desde el servidor de casa). Cada 5 minutos abre la página de sesión, LiveKit y la tienda desde fuera, y comprueba que el puerto de la consola del equipo no responde fuera de Cloudflare; si el servidor entero se cae, llega un correo."
  exit $?
fi

# Keep the outside watch's longer window for transient network failures.
check "página de sesión (playground.meetaule.com)" http https://playground.meetaule.com/session/healthz 15 20
check "audio (livekit.meetaule.com)" http https://livekit.meetaule.com/ 15 20
check "tienda (shop.meetaule.com)" http https://shop.meetaule.com/ 15 20
check "respaldo externo (falló o no se verificó en 26 h)" backup_ok
if [ -r "$ORIGIN_FILE" ]; then check "consola cerrada fuera de Cloudflare (puerto 8092)" console_closed; fi

watch_notify "monitor externo" "Para contrastar desde otra conexión:
curl -I --max-time 15 https://playground.meetaule.com/session/healthz
curl -I --max-time 15 https://livekit.meetaule.com/
Si fallan los tres destinos públicos, comprueba el acceso SSH al servidor y la conectividad del proveedor.
Si solo falla el respaldo externo, revisa la última copia y su verificación.
Si la consola responde desde fuera, revisa aule-origin-guard en el servidor: sudo iptables -t raw -S PREROUTING (infra/server/README.md)."
