const http = require("http");
const WebSocket = require("ws");

const AIRCRAFT_URL = process.env.AIRCRAFT_URL || "http://127.0.0.1:8080/data/aircraft.json";
const PORT = parseInt(process.env.PORT || "3001", 10);
const TICK_MS = parseInt(process.env.TICK_MS || "1000", 10);

// Later you can set this to "https://mydomain.com,https://www.mydomain.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

const wss = new WebSocket.Server({
  port: PORT,
  verifyClient: (info, done) => {
    if (ALLOWED_ORIGINS.length === 0) return done(true);
    const origin = info.origin || "";
    return done(ALLOWED_ORIGINS.includes(origin));
  }
});

let lastGood = null;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

setInterval(async () => {
    try {
      const j = await fetchJson(AIRCRAFT_URL);
      const rawAircraft = Array.isArray(j.aircraft) ? j.aircraft : [];
  
      const filteredAircraft = rawAircraft
        .filter(a => a.lat != null && a.lon != null)
        .map(a => ({
          id: a.hex,
          flight: (a.flight || "").trim() || null,
          lat: a.lat,
          lon: a.lon,
          track: a.track ?? null,
          alt: a.alt_baro ?? a.alt_geom ?? null,
          gs: a.gs ?? null
        }));  
      lastGood = {
        t: Date.now(),
        aircraft: filteredAircraft
      };
  
      broadcast(lastGood);
  
    } catch (e) {
      console.error("fetch error:", e.message);
      if (lastGood) broadcast(lastGood);
    }
  }, TICK_MS);
  