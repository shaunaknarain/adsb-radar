# adsb-pi-feed

A Raspberry Pi picks up radio signals from nearby aircraft and streams their positions live to my personal site, [shaunaknarain.com](https://shaunaknarain.com). Planes drift across the page background in real time.

## How it works

```
1090 MHz antenna ─► RTL-SDR ─► dump1090-fa ─► feed/server.js ─► Cloudflare Tunnel ─► browser (web/)
                               (decoder)       (WebSocket relay)  (no open ports)      (canvas renderer)
```

- **dump1090-fa** decodes ADS-B (Mode S) messages and writes `aircraft.json` locally.
- **`feed/server.js`** polls that file once a second, drops aircraft without a position, trims each one to the fields the page needs (id, callsign, lat/lon, track, altitude, ground speed), and sends the result to every connected WebSocket client. If a poll fails, it sends the last good snapshot again so clients don't freeze. It accepts connections only from origins listed in `ALLOWED_ORIGINS`.
- **Cloudflare Tunnel** makes the relay reachable at `wss://feed.<domain>` through an outbound-only connection. The home router has no inbound ports open.
- **`web/`** is a dependency-free canvas page. ADS-B updates arrive about once a second, so between updates it estimates where each plane is from its track and ground speed. It then eases the drawn position toward that estimate so planes glide smoothly instead of jumping. New planes fade in, and planes that stop reporting fade out and are removed.

The same Pi also feeds FlightAware (PiAware) and Flightradar24.

## Reliability: `pi/adsb-watchdog`

A systemd timer runs `adsb-watchdog.sh` every minute. It checks:

| Check | Signal |
|---|---|
| CPU temperature | `/sys/class/thermal` vs. a warning threshold |
| Under-voltage / throttling | `vcgencmd get_throttled` bit flags |
| Decoder health | age of the `now` field in `aircraft.json` |
| Whole Pi offline | heartbeat to Healthchecks.io (alerts when pings *stop*) |

Alerts go to my phone through [ntfy](https://ntfy.sh). They fire only when a check changes state (problem found, problem fixed), so an ongoing problem sends one alert, not one per minute. Settings go in `/etc/default/adsb-watchdog`, so the script itself holds no secrets.

## Measuring antenna range: `tools/range.py`

This reads dump1090's rolling history (about the last 60 minutes) and finds the farthest position seen for each aircraft (great-circle distance in nautical miles). It reports the max, p90 and median range, the message rate, and the max range in each of 8 compass sectors, and appends a labeled line to a JSONL log so antenna changes can be compared.

Baseline before the outdoor move (antenna indoors):

| aircraft | max | p90 | median | msg/s |
|---|---|---|---|---|
| 104 | 85.8 nm | 63.8 nm | 31.8 nm | 71 |

The weak S/SW sectors (14–19 nm) showed the building was blocking signals. That's why the receiver is moving to a weatherproofed outdoor mount. Outdoor results coming soon.

## Layout

```
feed/   WebSocket relay (Node + ws) and its systemd unit
web/    browser renderer (vanilla JS, canvas)
pi/     watchdog script + timer, Cloudflare Tunnel unit, example tunnel config
tools/  range measurement script and log
```

## Running it

```bash
# on the Pi, with dump1090-fa running
cd feed && npm ci
PORT=3001 ALLOWED_ORIGINS=https://example.com node server.js

# watchdog
sudo install -m755 pi/adsb-watchdog.sh /usr/local/bin/
sudo cp pi/adsb-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl enable --now adsb-watchdog.timer

# range report
RX_LAT=<lat> RX_LON=<lon> python3 tools/range.py "label for this run"
```

Set `HOME` in `web/main.js` to roughly your receiver's location. The page centers its map there.
