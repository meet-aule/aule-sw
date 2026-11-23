#!/usr/bin/env bash
# Watches Aule from outside its server, so the team hears of it when the whole
# server (aule-prod) or its network is down and its own watch cannot run.
# Run by this user's cron every five minutes on the home server:
#
#   ~/bin/aule-watch-outside.sh          check, and mail on a change
#   ~/bin/aule-watch-outside.sh --test   send one test mail
#
# It only fetches public pages. A failure is mailed when it starts and then
# every six hours while it lasts, through Resend's HTTP API with the key in
# ~/.config/aule/resend-key (mode 600). The server's own checks are
# /etc/aule/aule-watch.sh on aule-prod.
set -uo pipefail
umask 077
cd /

KEY_FILE="$HOME/.config/aule/resend-key"
STATE_DIR="$HOME/.local/state/aule"
STATE="$STATE_DIR/watch-outside.failing"
LAST_MAIL="$STATE_DIR/watch-outside.last-mail"
FROM="Aule <hola@meetaule.com>"
RECIPIENTS='["admin@meetaule.com", "gonzalo@meetaule.com"]'
REMIND_SECONDS=$((6 * 3600))
mkdir -p "$STATE_DIR"

up() { curl -fsS -o /dev/null --max-time 15 "$1"; }
# A blip is not an outage: a page that fails is tried again before it counts.
reachable() { up "$1" || { sleep 20 && up "$1"; }; }

failing=()
check() {
  reachable "$2" >/dev/null 2>&1 || failing+=("$1")
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

now=$(date +%s)
when=$(date -u '+%Y-%m-%d %H:%M UTC')

if [ "${1:-}" = "--test" ]; then
  mail "Aule: prueba del vigía externo" "El vigía externo de Aule está activo ($when, desde el servidor de casa). Cada 5 minutos abre la página de sesión, LiveKit y la tienda desde fuera; si el servidor entero se cae, llega un correo."
  exit $?
fi

check "página de sesión (playground.meetaule.com)" https://playground.meetaule.com/session/healthz
check "audio (livekit.meetaule.com)" https://livekit.meetaule.com/
check "tienda (shop.meetaule.com)" https://shop.meetaule.com/

current=$(printf '%s\n' "${failing[@]+"${failing[@]}"}" | sed '/^$/d' | sort)
previous=$(cat "$STATE" 2>/dev/null || true)
last=$(cat "$LAST_MAIL" 2>/dev/null || echo 0)

subject=""
details=$current
if [ "$current" != "$previous" ] && [ -n "$current" ]; then
  subject="Aule (desde fuera): no responde $(echo "$current" | paste -sd, - | sed 's/,/, /g')"
  body="Desde el servidor de casa, $when, no responde:"
elif [ "$current" != "$previous" ]; then
  subject="Aule (desde fuera): responde de nuevo"
  body="Desde el servidor de casa, $when, volvió a responder:"
  details=$previous
elif [ -n "$current" ] && [ $((now - last)) -ge $REMIND_SECONDS ]; then
  subject="Aule (desde fuera): sigue sin responder $(echo "$current" | paste -sd, - | sed 's/,/, /g')"
  body="Desde el servidor de casa, $when, sigue sin responder:"
fi
[ -n "$subject" ] || exit 0

body="$body
$(echo "$details" | sed 's/^/- /')

Si fallan todas a la vez, lo más probable es que el servidor aule-prod (Contabo) esté caído o sin red: ssh aule-prod; si no entra, el panel de Contabo.
Si falla una sola, mira el correo del vigía del propio servidor, que dice cuál servicio."
# Keep the last delivered state if mail fails, so the next check retries even
# a recovery or a changed incident within the six-hour reminder window.
mail "$subject" "$body" || exit $?
printf '%s\n' "$now" >"$LAST_MAIL" || exit 1
printf '%s\n' "$current" | sed '/^$/d' >"$STATE"
