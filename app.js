(function () {
  "use strict";

  const config = window.FLIGHT_CONFIG;
  const elements = {
    status: document.querySelector("#data-status"), slider: document.querySelector("#time-slider"),
    time: document.querySelector("#selected-time"), start: document.querySelector("#range-start"),
    end: document.querySelector("#range-end"), summary: document.querySelector("#snapshot-summary"),
    play: document.querySelector("#play-button"), playIcon: document.querySelector("#play-icon"), playLabel: document.querySelector("#play-label"),
    title: document.querySelector("#flight-title"), subtitle: document.querySelector("#flight-subtitle"),
    state: document.querySelector("#flight-state"), detailRows: [...document.querySelectorAll("#flight-details dd")]
  };

  const map = L.map("map", { zoomControl: false, preferCanvas: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.fitBounds([[config.bbox.lamin, config.bbox.lomin], [config.bbox.lamax, config.bbox.lomax]], { padding: [18, 18] });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: config.mapAttribution }).addTo(map);

  let data = null;
  let selectedIndex = 0;
  let selectedAircraft = null;
  let timer = null;
  let markerLayer = L.layerGroup().addTo(map);
  let trailLayer = L.layerGroup().addTo(map);

  const number = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat("et-EE", { maximumFractionDigits: digits }).format(value) : "—";
  const altitude = value => Number.isFinite(value) ? `${number(value)} m / ${number(value * 3.28084)} ft` : "—";
  const speed = value => Number.isFinite(value) ? `${number(value)} m/s / ${number(value * 3.6)} km/h` : "—";
  const verticalSpeed = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${number(value, 1)} m/s` : "—";
  const heading = value => Number.isFinite(value) ? `${number(value)}°` : "—";
  const displayTime = value => new Intl.DateTimeFormat("et-EE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Tallinn" }).format(new Date(value));
  const shortTime = value => new Intl.DateTimeFormat("et-EE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Tallinn" }).format(new Date(value));

  function planeIcon(deg) {
    // The ✈ glyph points east at 0°. OpenSky true_track is measured clockwise from north.
    const rotation = Number.isFinite(deg) ? deg - 90 : 0;
    return L.divIcon({ className: "plane-icon", iconSize: [30, 30], iconAnchor: [15, 15], html: `<span class="plane-symbol" style="transform:rotate(${rotation}deg)">✈</span>` });
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
    elements.title.textContent = aircraft.callsign || "Tundmatu kutsung";
    elements.subtitle.textContent = `Viimane valitud asukoht ${displayTime(data.snapshots[selectedIndex].timestamp)}.`;
    elements.state.textContent = aircraft.on_ground ? "Maal" : "Õhus";
    elements.state.className = `state-badge ${aircraft.on_ground ? "ground" : "airborne"}`;
    const values = [aircraft.icao24 || "—", altitude(aircraft.altitude_m), speed(aircraft.velocity_ms), heading(aircraft.heading_deg), verticalSpeed(aircraft.vertical_rate_ms), aircraft.origin || "Teadmata", aircraft.destination || "Teadmata"];
    elements.detailRows.forEach((row, index) => row.textContent = values[index]);
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

  function render() {
    if (!data) return;
    const snapshot = data.snapshots[selectedIndex];
    const aircraft = (snapshot.aircraft || []).filter(plane => Number.isFinite(plane.lat) && Number.isFinite(plane.lon));
    markerLayer.clearLayers(); trailLayer.clearLayers();
    const trails = getTrails(selectedIndex);
    trails.forEach((points, icao24) => {
      if (points.length > 1) L.polyline(points, { color: icao24 === selectedAircraft ? "#ffe0a8" : "#ffb454", weight: 2, opacity: icao24 === selectedAircraft ? .95 : .55 }).addTo(trailLayer);
    });
    aircraft.forEach(plane => {
      const marker = L.marker([plane.lat, plane.lon], { icon: planeIcon(plane.heading_deg), keyboard: true, title: plane.callsign || plane.icao24 });
      marker.on("click", () => { showDetails(plane); render(); });
      marker.addTo(markerLayer);
    });
    elements.slider.value = selectedIndex;
    elements.time.dateTime = snapshot.timestamp;
    elements.time.textContent = displayTime(snapshot.timestamp);
    elements.summary.textContent = `${aircraft.length} ${aircraft.length === 1 ? "lennuk" : "lennukit"}`;
    if (selectedAircraft) {
      const current = aircraft.find(plane => plane.icao24 === selectedAircraft);
      if (current) showDetails(current); else clearDetails();
    }
  }

  function stopPlayback() {
    if (timer) window.clearInterval(timer);
    timer = null; elements.play.setAttribute("aria-pressed", "false"); elements.playIcon.textContent = "▶"; elements.playLabel.textContent = "Esita";
  }
  function togglePlayback() {
    if (timer) return stopPlayback();
    if (selectedIndex >= data.snapshots.length - 1) selectedIndex = 0;
    timer = window.setInterval(() => { if (selectedIndex >= data.snapshots.length - 1) return stopPlayback(); selectedIndex += 1; render(); }, config.playbackIntervalMs);
    elements.play.setAttribute("aria-pressed", "true"); elements.playIcon.textContent = "Ⅱ"; elements.playLabel.textContent = "Paus";
  }
  function setError(message) {
    elements.status.textContent = message;
    elements.status.style.color = "#ffb454";
  }
  function initialise(raw) {
    if (!raw || !Array.isArray(raw.snapshots) || raw.snapshots.length === 0) throw new Error("Puuduvad kasutatavad snapshots.");
    data = raw;
    selectedIndex = data.snapshots.length - 1;
    elements.slider.max = data.snapshots.length - 1;
    elements.slider.disabled = false; elements.play.disabled = false;
    elements.start.textContent = shortTime(data.snapshots[0].timestamp);
    elements.end.textContent = shortTime(data.snapshots.at(-1).timestamp);
    elements.status.textContent = `Uuendatud ${displayTime(data.updated_at || data.snapshots.at(-1).timestamp)}`;
    render();
  }

  elements.slider.addEventListener("input", event => { stopPlayback(); selectedIndex = Number(event.target.value); render(); });
  elements.play.addEventListener("click", togglePlayback);
  fetch(config.dataUrl, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then(initialise).catch(error => { console.error(error); setError("Andmeid ei õnnestunud laadida."); });
}());
