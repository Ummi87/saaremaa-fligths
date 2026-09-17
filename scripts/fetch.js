#!/usr/bin/env node
/*
 * Downloads one OpenSky snapshot and retains only the most recent 24 hours.
 * OAuth2 is used when both GitHub Secrets are present; otherwise the request is anonymous.
 */
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "data", "flights_24h.json");
const BBOX = { lamin: 57.85, lomin: 21.5, lamax: 58.75, lomax: 23.6 };
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

async function fetchToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new Error(`OAuth2 token request failed (${response.status})`);
  const body = await response.json();
  if (!body.access_token) throw new Error("OAuth2 token response lacks access_token");
  return body.access_token;
}

async function loadExisting() {
  try { return JSON.parse(await fs.readFile(OUTPUT, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { bbox: BBOX, snapshots: [] };
    throw error;
  }
}

function normalise(state) {
  const [icao24, callsign, , , , lon, lat, altitude_m, on_ground, velocity_ms, heading_deg, vertical_rate_ms] = state;
  if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    icao24, callsign: callsign?.trim() || null, lat, lon, altitude_m, velocity_ms,
    heading_deg, vertical_rate_ms, on_ground: Boolean(on_ground)
  };
}

async function main() {
  try {
    const token = await fetchToken();
    const url = new URL(STATES_URL);
    Object.entries(BBOX).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error(`OpenSky states request failed (${response.status})`);
    const payload = await response.json();
    const timestamp = new Date((payload.time || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const snapshot = { timestamp, aircraft: (payload.states || []).map(normalise).filter(Boolean) };
    const existing = await loadExisting();
    const cutoff = Date.now() - WINDOW_MS;
    const snapshots = [...(existing.snapshots || []), snapshot]
      .filter(item => new Date(item.timestamp).getTime() >= cutoff)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const output = { updated_at: new Date().toISOString(), bbox: BBOX, snapshots };
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(output)}\n`, "utf8");
    console.log(`Saved ${snapshot.aircraft.length} aircraft; retained ${snapshots.length} snapshots (${token ? "OAuth2" : "anonymous"}).`);
  } catch (error) {
    // A failed collection must not stop later scheduled collections.
    console.error(`Snapshot skipped: ${error.message}`);
  }
}

main();
