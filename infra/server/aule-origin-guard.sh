#!/usr/bin/env bash
# Keeps the ports Cloudflare forwards to behind the origin firewall: the
# playground (8090), LiveKit's signalling (7880) and the team's console (8092).
# Each port gets one jump from raw PREROUTING to the AULE_ORIGIN chain, for
# IPv4 and IPv6; a jump already there is left as it is, so this can run any
# number of times. The chain, with Cloudflare's address ranges (the cf4 and
# cf6 ipsets), is made and refreshed by the store's deploy/origin-firewall.sh,
# and the ranges are never touched here. If the chain is not there yet, as
# early at boot, this makes one that lets in only this machine; the store's
# script lets Cloudflare in when it runs.
#
# Run as root: at boot before Docker (aule-origin-guard.service), and once by
# hand when installed. A failure exits non-zero.
set -euo pipefail

PORTS=(8090 7880 8092)

guard() { # iptables command, this machine's addresses
  local ipt="$1" loopback="$2" port
  if ! "$ipt" -t raw -S AULE_ORIGIN >/dev/null 2>&1; then
    "$ipt" -t raw -N AULE_ORIGIN
    "$ipt" -t raw -A AULE_ORIGIN -s "$loopback" -j RETURN
    "$ipt" -t raw -A AULE_ORIGIN -j DROP
  fi
  for port in "${PORTS[@]}"; do
    "$ipt" -t raw -C PREROUTING -p tcp --dport "$port" -j AULE_ORIGIN 2>/dev/null ||
      "$ipt" -t raw -I PREROUTING -p tcp --dport "$port" -j AULE_ORIGIN
  done
}

guard iptables 127.0.0.0/8
guard ip6tables ::1/128
echo "origin guard: tcp ${PORTS[*]} go through AULE_ORIGIN, for IPv4 and IPv6"
