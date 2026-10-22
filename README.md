#**Note: I've been working on this project locally since December 2025**
# ADSB Radar

A Raspberry Pi 4b picks up radio signals from nearby aircraft via an 1090 mhz antenna, and streams their positions live to my personal website, [shaunaknarain.com](https://shaunaknarain.com). Planes drift across the page background in real time.

## How it works

```
1090 MHz antenna ─► RTL-SDR ─► dump1090-fa ─► feed/server.js ─► Cloudflare Tunnel ─► browser (web/)
                               (decoder)       (WebSocket relay)  (no open ports)      (canvas renderer)
```

- **dump1090-fa** decodes ADS-B (Mode S) messages and writes `aircraft.json` locally.
- **`feed/server.js`** polls that file once a second, drops aircraft without a position, trims each one to the fields the page needs (id, callsign, lat/lon, track, altitude, ground speed), and sends the result to every connected WebSocket client. If a poll fails, it sends the last good snapshot again so clients don't freeze.
- **Cloudflare Tunnel** makes the relay reachable.
- **`web/`** is a dependency-free canvas page. ADS-B updates arrive about once a second, so between updates it estimates where each plane is from its track and ground speed. It then eases the drawn position toward that estimate so planes glide smoothly instead of jumping. New planes fade in, and planes that stop reporting fade out and are removed.

The same Pi also feeds FlightAware (PiAware) and Flightradar24.

## Hardware

See [HARDWARE.md](HARDWARE.md) for the full parts list with links.
