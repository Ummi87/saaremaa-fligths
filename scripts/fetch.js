#!/usr/bin/env node
/*
 * Downloads one OpenSky snapshot, enriches new callsigns with Aviationstack
 * route/operator data, and retains only the most recent 24 hours.
 */
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "data", "flights_24h.json");
const BBOX = { lamin: 57.85, lomin: 21.5, lamax: 58.75, lomax: 23.6 };
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ROUTE_CACHE_MS = 24 * 60 * 60 * 1000;
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";
const AVIATIONSTACK_URL = "https://api.aviationstack.com/v1/flights";
const ROUTE_KEYS = [
  "airline_name", "airline_iata", "airline_icao", "flight_iata", "flight_icao",
  "flight_status", "origin", "origin_iata", "destination", "destination_iata",
  "departure_scheduled", "arrival_scheduled", "route_source", "route_found",
  "route_checked_at", "route_updated_at"
];

async function fetchToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new Error("OAuth2 token request failed (" + response.status + ")");
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
    icao24,
    callsign: callsign ? callsign.trim() : null,
    lat,
    lon,
    altitude_m,
    velocity_ms,
    heading_deg,
    vertical_rate_ms,
    on_ground: Boolean(on_ground)
  };
}

function cleanCallsign(value) {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, "").trim() : null;
}

function routeFields(aircraft) {
  return ROUTE_KEYS.reduce((result, key) => {
    if (aircraft[key] !== undefined) result[key] = aircraft[key];
    return result;
  }, {});
}

function routeTimestamp(item) {
  const values = [
    item.departure && item.departure.actual,
    item.departure && item.departure.estimated,
    item.departure && item.departure.scheduled,
    item.arrival && item.arrival.actual,
    item.arrival && item.arrival.estimated,
    item.arrival && item.arrival.scheduled
  ];
  return values.map(value => Date.parse(value || "")).filter(Number.isFinite);
}

function routeScore(item, targetMs) {
  const times = routeTimestamp(item);
  return times.length ? Math.min(...times.map(value => Math.abs(value - targetMs))) : Number.MAX_SAFE_INTEGER;
}

async function lookupRoute(callsign, snapshotTimestamp, apiKey) {
  const url = new URL(AVIATIONSTACK_URL);
  url.searchParams.set("access_key", apiKey);
  url.searchParams.set("flight_icao", callsign);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Aviationstack request failed (" + response.status + ")");
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Aviationstack returned an error");
  const flights = Array.isArray(body.data) ? body.data : [];
  const targetMs = Date.parse(snapshotTimestamp);
  const item = flights
    .slice()
    .sort((a, b) => routeScore(a, targetMs) - routeScore(b, targetMs))[0];
  const checkedAt = new Date().toISOString();
  if (!item) {
    return { route_source: "Aviationstack", route_found: false, route_checked_at: checkedAt };
  }

  const departure = item.departure || {};
  const arrival = item.arrival || {};
  const airline = item.airline || {};
  const flight = item.flight || {};
  return {
    airline_name: airline.name || null,
    airline_iata: airline.iata || null,
    airline_icao: airline.icao || null,
    flight_iata: flight.iata || null,
    flight_icao: flight.icao || callsign,
    flight_status: item.flight_status || null,
    origin: departure.airport || departure.iata || departure.icao || null,
    origin_iata: departure.iata || null,
    destination: arrival.airport || arrival.iata || arrival.icao || null,
    destination_iata: arrival.iata || null,
    departure_scheduled: departure.scheduled || null,
    arrival_scheduled: arrival.scheduled || null,
    route_source: "Aviationstack",
    route_found: Boolean(departure.iata || departure.airport || arrival.iata || arrival.airport),
    route_checked_at: checkedAt,
    route_updated_at: checkedAt
  };
}

async function enrichSnapshot(snapshot, existing, apiKey) {
  const cache = new Map();
  for (const oldSnapshot of existing.snapshots || []) {
    for (const aircraft of oldSnapshot.aircraft || []) {
      const callsign = cleanCallsign(aircraft.callsign);
      if (callsign && aircraft.route_checked_at) cache.set(callsign, routeFields(aircraft));
    }
  }

  for (const aircraft of snapshot.aircraft) {
    const callsign = cleanCallsign(aircraft.callsign);
    if (!callsign) continue;
    const cached = cache.get(callsign);
    const cacheAge = cached && Date.now() - Date.parse(cached.route_checked_at || "") < ROUTE_CACHE_MS;
    if (cacheAge) {
      Object.assign(aircraft, cached);
      continue;
    }
    try {
      const route = await lookupRoute(callsign, snapshot.timestamp, apiKey);
      Object.assign(aircraft, route);
      cache.set(callsign, route);
      console.log("Route lookup " + callsign + ": " + (route.route_found ? "found" : "not found"));
    } catch (error) {
      console.warn("Route lookup skipped for " + callsign + ": " + error.message);
      cache.set(callsign, { route_checked_at: new Date().toISOString() });
    }
  }
}

async function main() {
  try {
    const token = await fetchToken();
    const url = new URL(STATES_URL);
    Object.entries(BBOX).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, { headers: token ? { authorization: "Bearer " + token } : {} });
    if (!response.ok) throw new Error("OpenSky states request failed (" + response.status + ")");
    const payload = await response.json();
    const timestamp = new Date((payload.time || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const snapshot = { timestamp, aircraft: (payload.states || []).map(normalise).filter(Boolean) };
    const existing = await loadExisting();
    const aviationstackKey = process.env.AVIATIONSTACK_API_KEY;
    if (aviationstackKey) await enrichSnapshot(snapshot, existing, aviationstackKey);
    else console.log("AVIATIONSTACK_API_KEY puudub; marsruudiandmete rikastamine jäeti vahele.");

    const cutoff = Date.now() - WINDOW_MS;
    const snapshots = [...(existing.snapshots || []), snapshot]
      .filter(item => new Date(item.timestamp).getTime() >= cutoff)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const output = { updated_at: new Date().toISOString(), bbox: BBOX, snapshots };
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, JSON.stringify(output) + "\n", "utf8");
    console.log("Saved " + snapshot.aircraft.length + " aircraft; retained " + snapshots.length + " snapshots (" + (token ? "OAuth2" : "anonymous") + ").");
  } catch (error) {
    console.error("Snapshot skipped: " + error.message);
  }
}

main();
