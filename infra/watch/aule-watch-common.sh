#!/usr/bin/env bash
# Shared probes and mail formatting. Callers supply mail(), state paths and help.

failing=()
diagnostics=()
checks=0
CHECK_DETAIL=""

http() {
  local result rc code elapsed attempt reason
  local timeout=${2:-10} retry_delay=${3:-2}
  for attempt in 1 2; do
    result=$(curl -sS -o /dev/null --connect-timeout 5 --max-time "$timeout" \
      --write-out '%{http_code} %{time_total}' "$1" 2>/dev/null)
    rc=$?
    code=000 elapsed=unknown
    if [[ "$result" =~ ^([0-9]{3})[[:space:]]([0-9]+([.][0-9]+)?)$ ]]; then
      code=${BASH_REMATCH[1]} elapsed=${BASH_REMATCH[2]}
    fi
    if [ "$rc" = 0 ] && [[ "$code" =~ ^[23][0-9]{2}$ ]]; then return 0; fi
    case "$rc" in
      0|22) reason="respuesta HTTP no satisfactoria" ;;
      6) reason="DNS: no se pudo resolver el destino" ;;
      7) reason="no se pudo conectar" ;;
      28) reason="tiempo de espera agotado" ;;
      35|51|60) reason="falló la conexión TLS o el certificado" ;;
      *) reason="falló la solicitud" ;;
    esac
    CHECK_DETAIL="HTTP $code; curl $rc ($reason); $elapsed s; intento $attempt/2"
    if [ "$attempt" = 1 ]; then sleep "$retry_delay"; fi
  done
  return 1
}

check() {
  local name=$1
  shift
  checks=$((checks + 1))
  CHECK_DETAIL="comprobación fallida"
  if ! "$@" >/dev/null 2>&1; then
    failing+=("$name")
    diagnostics+=("- $name: $CHECK_DETAIL")
  fi
}

watch_write() {
  local temporary
  temporary=$(mktemp "$1.XXXXXX") || return 1
  printf '%s\n' "$2" > "$temporary" && mv -f "$temporary" "$1"
}

watch_time() {
  local stamp=$1
  [[ "$stamp" =~ ^[1-9][0-9]{9}$ ]] || { printf 'no registrado'; return; }
  printf '%s / %s' "$(TZ=America/Lima date -d "@$stamp" '+%Y-%m-%d %H:%M:%S Lima')" \
    "$(date -u -d "@$stamp" '+%Y-%m-%d %H:%M:%S UTC')"
}

watch_notify() { # origin, read-only troubleshooting instructions
  local now
  now=$(date +%s)
  local origin=$1 help=$2 current previous observed last first ended
  local kind summary details duration="no registrada" subject body
  local observed_file="$STATE.observed" first_file="$STATE.since" ended_file="$STATE.recovered"
  current=$(printf '%s\n' "${failing[@]+"${failing[@]}"}" | sed '/^$/d' | sort)
  previous=$(cat "$STATE" 2>/dev/null || true)
  # On upgrade, an existing delivered failure has no known start time.
  observed=$(cat "$observed_file" 2>/dev/null || printf '%s' "$previous")
  last=$(cat "$LAST_MAIL" 2>/dev/null || echo 0)
  [[ "$last" =~ ^[1-9][0-9]{9}$ ]] || last=0
  if [ "$last" -gt "$now" ]; then last=0; fi

  if [ -n "$current" ] && [ -z "$observed" ]; then
    watch_write "$first_file" "$now" || return 1
    rm -f "$ended_file"
  elif [ -z "$current" ] && [ -n "$observed" ]; then
    watch_write "$ended_file" "$now" || return 1
  fi
  watch_write "$observed_file" "$current" || return 1
  first=$(cat "$first_file" 2>/dev/null || true)
  if [[ ! "$first" =~ ^[1-9][0-9]{9}$ ]] || [ "$first" -gt "$now" ]; then first=""; fi
  ended=$now
  details=$(printf '%s\n' "${diagnostics[@]+"${diagnostics[@]}"}")

  if [ "$current" != "$previous" ] && [ -n "$current" ]; then
    kind=ALERTA
    summary="Hay comprobaciones fallidas."
  elif [ "$current" != "$previous" ]; then
    kind=RECUPERADO
    summary="Todas las comprobaciones pasan de nuevo."
    details=$(printf '%s\n' "$previous" | sed 's/^/- /')
    ended=$(cat "$ended_file" 2>/dev/null || printf '%s' "$now")
    if [[ ! "$ended" =~ ^[1-9][0-9]{9}$ ]] || [ "$ended" -gt "$now" ]; then ended=""; fi
    help="El monitor seguirá comprobando cada 5 minutos."
  elif [ -n "$current" ] && [ $((now - last)) -ge "$REMIND_SECONDS" ]; then
    kind=RECORDATORIO
    summary="El incidente sigue abierto; estas son las comprobaciones actuales."
  else
    return 0
  fi
  if [[ "$first" =~ ^[1-9][0-9]{9}$ && "$ended" =~ ^[1-9][0-9]{9}$ ]] && [ "$ended" -ge "$first" ]; then
    duration="$(((ended - first) / 60)) min (tiempo observado; revisión cada 5 min)"
  fi
  subject="Aule [$kind] [$origin]"
  if [ -n "$current" ]; then
    subject="$subject: ${failing[0]}"
    if [ "${#failing[@]}" -gt 1 ]; then subject="$subject (+$((${#failing[@]} - 1)))"; fi
  fi
  body="$summary

Origen del monitor: $origin
Comprobado: $(watch_time "$now")
Inicio observado: $(watch_time "$first")
Duración del incidente: $duration
Comprobaciones correctas ahora: $((checks - ${#failing[@]}))/$checks"
  if [ "$kind" = RECUPERADO ]; then body="$body
Recuperación observada: $(watch_time "$ended")"; fi
  body="$body

Detalle:
$details

$help

El estado corresponde a la hora de comprobación; el correo puede llegar después."
  # Observations are independent of delivery: retry the current state after a
  # rejected mail, while keeping the actual incident/recovery times unchanged.
  mail "$subject" "$body" || return $?
  watch_write "$LAST_MAIL" "$now" || return 1
  watch_write "$STATE" "$current"
}
