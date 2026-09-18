(function () {
  "use strict";

  const config = window.FLIGHT_CONFIG;
  const elements = {
    status: document.querySelector("#data-status"),
    slider: document.querySelector("#time-slider"),
    time: document.querySelector("#selected-time"),
    start: document.querySelector("#range-start"),
    end: document.querySelector("#range-end"),
    summary: document.querySelector("#snapshot-summary"),
    play: document.querySelector("#play-button"),
    playIcon: document.querySelector("#play-icon"),
    playLabel: document.querySelector("#play-label"),
    live: document.querySelector("#live-button"),
    liveLabel: document.querySelector("#live-label"),
    title: document.querySelector("#flight-title"),
    subtitle: document.querySelector("#flight-subtitle"),
    state: document.querySelector("#flight-state"),
    detailRows: [...document.querySelectorAll("#flight-details dd")],
    lastTitle: document.querySelector("#last-overflight-title"),
    lastMeta: document.querySelector("#last-overflight-meta"),
    lastRoute: document.querySelector("#last-overflight-route"),
    nextTitle: document.querySelector("#next-overflight-title"),
    nextMeta: document.querySelector("#next-overflight-meta"),
    nextRoute: document.querySelector("#next-overflight-route"),
    lastUpdate: document.querySelector("#last-update-time"),
    nextUpdate: document.querySelector("#next-update-time")
  };

  const map = L.map("map", { zoomControl: false, preferCanvas: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.fitBounds([[config.bbox.lamin, config.bbox.lomin], [config.bbox.lamax, config.bbox.lomax]], { padding: [18, 18] });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: config.mapAttribution }).addTo(map);

  let data = null;
  let selectedIndex = 0;
  let selectedAircraft = null;
  let timer = null;
  let liveTimer = null;
  let liveMode = true;
  const markerLayer = L.layerGroup().addTo(map);
  const trailLayer = L.layerGroup().addTo(map);
  const markers = new Map();

  const number = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat("et-EE", { maximumFractionDigits: digits }).format(value) : "—";
  const altitude = value => Number.isFinite(value) ? `${number(value)} m / ${number(value * 3.28084)} ft` : "—";
  const speed = value => Number.isFinite(value) ? `${number(value)} m/s / ${number(value * 3.6)} km/h` : "—";
  const verticalSpeed = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${number(value, 1)} m/s` : "—";
  const heading = value => Number.isFinite(value) ? `${number(value)}°` : "—";
  const displayTime = value => new Intl.DateTimeFormat("et-EE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Tallinn" }).format(new Date(value));
  const shortTime = value => new Intl.DateTimeFormat("et-EE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Tallinn" }).format(new Date(value));
  const isValidDate = value => Number.isFinite(Date.parse(value || ""));

  function projectedIslandEntry(snapshot) {
    if (!liveMode || !snapshot || !isValidDate(snapshot.timestamp)) return null;
    const ageMs = Date.now() - Date.parse(snapshot.timestamp);
    if (ageMs < -5 * 60 * 1000 || ageMs > 15 * 60 * 1000) return null;
    const zone = config.overflightZone || { lat: 58.36, lon: 22.55, radiusKm: 34 };
    const latitudeScale = 111.32 * Math.cos(zone.lat * Math.PI / 180);
    const candidates = [];
    for (const aircraft of snapshot.aircraft || []) {
      if (aircraft.on_ground || !Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) continue;
      if (!Number.isFinite(aircraft.velocity_ms) || aircraft.velocity_ms < 35 || !Number.isFinite(aircraft.heading_deg)) continue;
      const x = (aircraft.lon - zone.lon) * latitudeScale;
      const y = (aircraft.lat - zone.lat) * 111.32;
      const speedKmS = aircraft.velocity_ms / 1000;
      const headingRad = aircraft.heading_deg * Math.PI / 180;
      const vx = Math.sin(headingRad) * speedKmS;
      const vy = Math.cos(headingRad) * speedKmS;
      const distance = Math.hypot(x, y);
      if (distance <= zone.radiusKm) continue;
      const a = vx * vx + vy * vy;
      const b = 2 * (x * vx + y * vy);
      const c = x * x + y * y - zone.radiusKm * zone.radiusKm;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;
      const root = Math.sqrt(discriminant);
      const times = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter(value => value >= 0);
      if (!times.length) continue;
      const seconds = Math.min(...times);
      if (seconds > 45 * 60) continue;
      candidates.push({ aircraft, seconds, timestamp: Date.parse(snapshot.timestamp) + seconds * 1000 });
    }
    return candidates.sort((a, b) => a.seconds - b.seconds)[0] || null;
  }

  function planeName(aircraft) {
    return aircraft.callsign || aircraft.flight_icao || aircraft.flight_iata || aircraft.icao24 || "Tundmatu lennuk";
  }

  function formatRemaining(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return `${seconds} sek pärast`;
    return `${Math.ceil(seconds / 60)} min pärast`;
  }

  function updateRefreshInfo() {
    if (!data) return;
    const lastValue = data.updated_at || data.snapshots.at(-1)?.timestamp;
    const lastMs = Date.parse(lastValue || "");
    if (!Number.isFinite(lastMs)) return;
    const intervalMs = (config.snapshotIntervalMinutes || 5) * 60 * 1000;
    const nextMs = lastMs + intervalMs;
    elements.lastUpdate.textContent = displayTime(lastValue);
    elements.nextUpdate.textContent = nextMs > Date.now()
      ? `${shortTime(nextMs)} (${formatRemaining(nextMs - Date.now())})`
      : "oodatud kohe";
  }

  function routeText(aircraft) {
    const origin = aircraft.origin_iata || aircraft.origin;
    const destination = aircraft.destination_iata || aircraft.destination;
    if (origin && destination) return `${origin} → ${destination}`;
    if (origin) return `Algus ${origin}`;
    if (destination) return `Sihtkoht ${destination}`;
    return "Marsruut teadmata";
  }

  function planeIcon(deg) {
    // Leaflet marker points east at 0°. OpenSky true_track is clockwise from north.
    const rotation = Number.isFinite(deg) ? deg - 90 : 0;
    const liveClass = liveMode ? " live-plane" : "";
    return L.divIcon({ className: `plane-icon${liveClass}`, iconSize: [30, 30], iconAnchor: [15, 15], html: `<span class="plane-symbol" style="transform:rotate(${rotation}deg)">✈</span>` });
  }

  function clearDetails() {
    elements.title.textContent = "Vali lennuk";
    elements.subtitle.textContent = "Klõpsa kaardil lennuki ikoonil, et näha andmeid.";
    elements.state.textContent = "—";
    elements.state.className = "state-badge";
    elements.detailRows.forEach((row, index) => row.textContent = index > 4 ? "Teadmata" : "—");
  }

  function showDetails(aircraft) {
    selectedAircraft = aircraft.icao24;
    elements.title.textContent = planeName(aircraft);
    elements.subtitle.textContent = `Viimane valitud asukoht ${displayTime(data.snapshots[selectedIndex].timestamp)}.`;
    elements.state.textContent = aircraft.on_ground ? "Maal" : "Õhus";
    elements.state.className = `state-badge ${aircraft.on_ground ? "ground" : "airborne"}`;
    const values = [
      aircraft.icao24 || "—",
      altitude(aircraft.altitude_m),
      speed(aircraft.velocity_ms),
      heading(aircraft.heading_deg),
      verticalSpeed(aircraft.vertical_rate_ms),
      aircraft.airline_name || aircraft.airline_icao || "Teadmata",
      aircraft.origin || aircraft.origin_iata || "Teadmata",
      aircraft.destination || aircraft.destination_iata || "Teadmata"
    ];
    elements.detailRows.forEach((row, index) => row.textContent = values[index]);
  }

  function allObservations() {
    const observations = [];
    for (const snapshot of data.snapshots || []) {
      for (const aircraft of snapshot.aircraft || []) {
        observations.push({ aircraft, timestamp: snapshot.timestamp });
      }
    }
    return observations;
  }

  function updateOverflightSummary() {
    if (!data) return;
    const observations = allObservations();
    const airborne = observations
      .filter(item => !item.aircraft.on_ground)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const last = airborne.at(-1);

    if (last) {
      elements.lastTitle.textContent = planeName(last.aircraft);
      elements.lastMeta.textContent = `${displayTime(last.timestamp)} · ${last.aircraft.airline_name || last.aircraft.airline_icao || "Lennufirma teadmata"}`;
      elements.lastRoute.textContent = routeText(last.aircraft);
    } else {
      elements.lastTitle.textContent = "Andmed puuduvad";
      elements.lastMeta.textContent = "Ühtegi õhus olevat lennukit pole tuvastatud.";
      elements.lastRoute.textContent = "—";
    }

    const latestSnapshot = data.snapshots.at(-1);
    const projected = projectedIslandEntry(latestSnapshot);
    if (projected) {
      elements.nextTitle.textContent = planeName(projected.aircraft);
      elements.nextMeta.textContent = `Umbes ${Math.max(1, Math.round(projected.seconds / 60))} minuti pärast · ${displayTime(projected.timestamp)}`;
      elements.nextRoute.textContent = `${routeText(projected.aircraft)} · OpenSky trajektoori põhine hinnang`;
      return;
    }

    const now = Date.now();
    const future = [];
    for (const item of observations) {
      const aircraft = item.aircraft;
      for (const [kind, field] of [["väljumine", "departure_scheduled"], ["saabumine", "arrival_scheduled"]]) {
        if (!isValidDate(aircraft[field])) continue;
        const timestamp = Date.parse(aircraft[field]);
        if (timestamp > now) future.push({ aircraft, timestamp, kind });
      }
    }
    future.sort((a, b) => a.timestamp - b.timestamp);
    const next = future[0];
    if (next) {
      elements.nextTitle.textContent = planeName(next.aircraft);
      elements.nextMeta.textContent = `${displayTime(next.timestamp)} · graafiku ${next.kind}`;
      elements.nextRoute.textContent = `${routeText(next.aircraft)} · aeg on eeldatav, mitte täpne ülelennuhetk`;
    } else {
      elements.nextTitle.textContent = "Ootame uut live-andmepunkti";
      elements.nextMeta.textContent = "Tulevast üle Saaremaa lendu pole hetkel graafikuandmetes.";
      elements.nextRoute.textContent = "Live-vaade kontrollib värsket OpenSky trajektoori automaatselt.";
    }
  }

  function getTrails(maxIndex) {
    const tracks = new Map();
    for (let i = 0; i <= maxIndex; i += 1) {
      for (const plane of data.snapshots[i].aircraft || []) {
        if (!Number.isFinite(plane.lat) || !Number.isFinite(plane.lon)) continue;
        if (!tracks.has(plane.icao24)) tracks.set(plane.icao24, []);
        tracks.get(plane.icao24).push([plane.lat, plane.lon]);
      }
    }
    return tracks;
  }

  function animateMarker(marker, from, to) {
    if (!from || !to || !liveMode) {
      marker.setLatLng(to);
      return;
    }
    const duration = Math.min(config.markerAnimationMs || 900, 900);
    const started = performance.now();
    const frame = now => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * (2 - progress);
      marker.setLatLng([
        from[0] + (to[0] - from[0]) * eased,
        from[1] + (to[1] - from[1]) * eased
      ]);
      if (progress < 1) window.requestAnimationFrame(frame);
    };
    window.requestAnimationFrame(frame);
  }

  function render() {
    if (!data) return;
    const snapshot = data.snapshots[selectedIndex];
    const aircraft = (snapshot.aircraft || []).filter(plane => Number.isFinite(plane.lat) && Number.isFinite(plane.lon));
    const visible = new Set();
    const trails = getTrails(selectedIndex);
    trailLayer.clearLayers();
    trails.forEach((points, icao24) => {
      if (points.length > 1) L.polyline(points, { color: icao24 === selectedAircraft ? "#ffe0a8" : "#ffb454", weight: 2, opacity: icao24 === selectedAircraft ? .95 : .55, className: "flight-trail" }).addTo(trailLayer);
    });

    aircraft.forEach(plane => {
      const id = plane.icao24 || plane.callsign;
      if (!id) return;
      const position = [plane.lat, plane.lon];
      let marker = markers.get(id);
      if (!marker) {
        marker = L.marker(position, { icon: planeIcon(plane.heading_deg), keyboard: true, title: planeName(plane) });
        marker.addTo(markerLayer);
        markers.set(id, marker);
      } else {
        animateMarker(marker, [marker.getLatLng().lat, marker.getLatLng().lng], position);
        marker.setIcon(planeIcon(plane.heading_deg));
      }
      marker.options.title = planeName(plane);
      marker.off("click").on("click", () => { showDetails(plane); render(); });
      visible.add(id);
    });

    for (const [id, marker] of markers) {
      if (!visible.has(id)) {
        markerLayer.removeLayer(marker);
        markers.delete(id);
      }
    }

    elements.slider.value = selectedIndex;
    elements.time.dateTime = snapshot.timestamp;
    elements.time.textContent = displayTime(snapshot.timestamp);
    elements.summary.textContent = `${aircraft.length} ${aircraft.length === 1 ? "lennuk" : "lennukit"}`;
    if (selectedAircraft) {
      const current = aircraft.find(plane => plane.icao24 === selectedAircraft);
      if (current) showDetails(current); else clearDetails();
    }
    updateOverflightSummary();
  }

  function stopPlayback() {
    if (timer) window.clearInterval(timer);
    timer = null;
    elements.play.setAttribute("aria-pressed", "false");
    elements.playIcon.textContent = "▶";
    elements.playLabel.textContent = "Esita";
  }

  function togglePlayback() {
    if (timer) return stopPlayback();
    liveMode = false;
    updateLiveButton();
    if (selectedIndex >= data.snapshots.length - 1) selectedIndex = 0;
    timer = window.setInterval(() => {
      if (selectedIndex >= data.snapshots.length - 1) return stopPlayback();
      selectedIndex += 1;
      render();
    }, config.playbackIntervalMs);
    elements.play.setAttribute("aria-pressed", "true");
    elements.playIcon.textContent = "Ⅱ";
    elements.playLabel.textContent = "Paus";
  }

  function updateLiveButton() {
    elements.live.setAttribute("aria-pressed", String(liveMode));
    elements.live.classList.toggle("active", liveMode);
    elements.liveLabel.textContent = liveMode ? "Live sees" : "Live";
  }

  async function loadData() {
    const response = await fetch(`${config.dataUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    if (!raw || !Array.isArray(raw.snapshots) || raw.snapshots.length === 0) throw new Error("Puuduvad kasutatavad snapshots.");
    data = raw;
    selectedIndex = liveMode ? data.snapshots.length - 1 : Math.min(selectedIndex, data.snapshots.length - 1);
    elements.slider.max = data.snapshots.length - 1;
    elements.slider.disabled = false;
    elements.play.disabled = false;
    elements.start.textContent = shortTime(data.snapshots[0].timestamp);
    elements.end.textContent = shortTime(data.snapshots.at(-1).timestamp);
    elements.status.textContent = `${liveMode ? "LIVE · " : ""}Uuendatud ${displayTime(data.updated_at || data.snapshots.at(-1).timestamp)}`;
    elements.status.style.color = "";
    updateRefreshInfo();
    render();
  }

  function setLiveMode(enabled) {
    liveMode = enabled;
    stopPlayback();
    updateLiveButton();
    if (liveMode && data) {
      selectedIndex = data.snapshots.length - 1;
      render();
      loadData().catch(error => setError(`Live-uuendus ebaõnnestus: ${error.message}`));
    }
  }

  function setError(message) {
    elements.status.textContent = message;
    elements.status.style.color = "#ffb454";
  }

  elements.slider.addEventListener("input", event => {
    stopPlayback();
    liveMode = false;
    updateLiveButton();
    selectedIndex = Number(event.target.value);
    render();
  });
  elements.play.addEventListener("click", togglePlayback);
  elements.live.addEventListener("click", () => setLiveMode(!liveMode));
  updateLiveButton();
  loadData().catch(error => { console.error(error); setError("Andmeid ei õnnestunud laadida."); });
  window.setInterval(updateRefreshInfo, 1000);
  liveTimer = window.setInterval(() => {
    if (liveMode) loadData().catch(error => setError(`Live-uuendus ebaõnnestus: ${error.message}`));
  }, config.liveRefreshMs || 60000);
}());
