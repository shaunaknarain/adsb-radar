#!/usr/bin/env bash
# ADS-B Pi watchdog: run every minute via systemd timer.
# Sends a phone push (ntfy) when something goes wrong AND when it recovers,
# never repeatedly for the same ongoing problem.
set -u

# --- config (override in /etc/default/adsb-watchdog) ---
NTFY_TOPIC=""                # e.g. adsb-pi-<random string>; anyone with the name can read it
HC_PING_URL=""               # Healthchecks.io ping URL, for "whole Pi is down" alerts
AIRCRAFT_URL="http://127.0.0.1:8080/data/aircraft.json"
TEMP_WARN_C=75               # Pi starts throttling around 80-85C
STALE_SECS=60                # aircraft.json older than this = decoder down
STATE_DIR=/var/lib/adsb-watchdog
[ -f /etc/default/adsb-watchdog ] && . /etc/default/adsb-watchdog

mkdir -p "$STATE_DIR"

notify() {  # notify <title> <message> <priority> <tags>
  [ -n "$NTFY_TOPIC" ] || return 0
  curl -fsS -m 10 -H "Title: $1" -H "Priority: $3" -H "Tags: $4" \
    -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
}

# check <name> <is_bad 0/1> <problem msg> <recovered msg>
# Alerts only on state transitions.
check() {
  local f="$STATE_DIR/$1" was_bad=0
  [ -f "$f" ] && was_bad=1
  if [ "$2" = 1 ] && [ "$was_bad" = 0 ]; then
    touch "$f"; notify "ADS-B: $1" "$3" high warning
  elif [ "$2" = 0 ] && [ "$was_bad" = 1 ]; then
    rm -f "$f"; notify "ADS-B: $1 OK" "$4" default white_check_mark
  fi
}

# --- temperature ---
temp_c=$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))
hot=0; [ "$temp_c" -ge "$TEMP_WARN_C" ] && hot=1
check temp "$hot" "CPU at ${temp_c}C (limit ${TEMP_WARN_C}C)" "CPU back to ${temp_c}C"

# --- under-voltage / throttling (current state bits from vcgencmd) ---
if command -v vcgencmd >/dev/null; then
  thr=$(( $(vcgencmd get_throttled | cut -d= -f2) ))
  uv=$(( thr & 0x1 ? 1 : 0 ))
  throttled=$(( thr & 0x6 ? 1 : 0 ))
  check undervoltage "$uv" "Under-voltage detected: check PSU/cable" "Voltage normal"
  check throttled "$throttled" "CPU is throttled/frequency-capped (${temp_c}C)" "No longer throttled"
fi

# --- decoder producing data? ---
now_field=$(curl -fsS -m 5 "$AIRCRAFT_URL" 2>/dev/null | grep -o '"now" *: *[0-9.]*' | grep -o '[0-9.]*$')
dec_bad=1; age="?"
if [ -n "$now_field" ]; then
  age=$(( $(date +%s) - ${now_field%.*} ))
  [ "$age" -le "$STALE_SECS" ] && dec_bad=0
fi
check decoder "$dec_bad" "No fresh aircraft.json (age: ${age}s). SDR unplugged or decoder crashed?" "Decoder producing data again"

# --- heartbeat for "Pi is completely down" detection ---
[ -n "$HC_PING_URL" ] && curl -fsS -m 10 --retry 3 "$HC_PING_URL" >/dev/null || true
