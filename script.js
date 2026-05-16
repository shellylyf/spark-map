const MAPBOX_ACCESS_TOKEN = "pk.eyJ1Ijoic2hlbGx5bCIsImEiOiJjbW82aWllb3oxYW84M3dwa3phdHlkeGN0In0.9juZvRwEEuAwDKBEHIuDCw";
const PROVIDENCE_CENTER = [-71.4128, 41.8238];
const FIREBASE_DATABASE_URL = "https://emotional-weather-meter-default-rtdb.firebaseio.com";
const FIREBASE_FORTUNES_PATH = "fortunes";
const LIVE_METER_LOCATION_ID = "waterplace-steps";
const LIVE_METER_LOCATION_NAME = "161 S Main St";
const LIVE_METER_COORDINATES = {
  latitude: 41.822691,
  longitude: -71.405362
};
const PIN_ICON_WIDTH = 54;
const PIN_ICON_HEIGHT = 78;

const WEATHER_STYLES = {
  Clear: { color: "#aab0ab", icon: "Sun" },
  Overcast: { color: "#b9b0a9", icon: "Cloud" },
  Drizzle: { color: "#97a6a7", icon: "Mist" },
  Windy: { color: "#c4b29e", icon: "Breeze" },
  Stormy: { color: "#93858f", icon: "Static" },
  Warming: { color: "#d59691", icon: "Glow" }
};

const state = {
  map: null,
  locations: [],
  firebaseFortunes: {},
  liveMeterData: null,
  liveMeterReadingVersion: null,
  activePopupId: null,
  activePopup: null,
  firebaseStream: null,
  firebasePoller: null
};

const currentTime = document.getElementById("current-time");
const currentDate = document.getElementById("current-date");
const currentLocation = document.getElementById("current-location");
const liveMeterName = document.getElementById("live-meter-name");
const liveMeterFortune = document.getElementById("live-meter-fortune");
const liveMeterVoices = document.getElementById("live-meter-voices");
const liveMeterSync = document.getElementById("live-meter-sync");

init();

async function init() {
  startClock();

  try {
    state.locations = await loadLocations();
    markLiveMeterLocation();
    connectToFirebase();

    if (!hasUsableToken()) {
      renderTokenState();
      return;
    }

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
    state.map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/light-v11",
      center: PROVIDENCE_CENTER,
      zoom: 14.1,
      pitch: 0,
      attributionControl: false
    });

    state.map.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right"
    );

    state.map.on("load", async () => {
      await addLocationPins(state.locations);
      locateUser();
    });
  } catch (error) {
    renderErrorState();
    console.error(error);
  }
}

async function loadLocations() {
  const response = await fetch("./data/locations.json");

  if (!response.ok) {
    throw new Error("Unable to load location data.");
  }

  return response.json();
}

async function addLocationPins(locations) {
  const pinImage = await loadMapImage("./assets/pin-1.png");
  const demoPinImage = createPinImage(pinImage);
  const livePinImage = createPinImage(pinImage, {
    red: 156,
    green: 72,
    blue: 82
  });

  state.map.addImage("pin-demo", demoPinImage);
  state.map.addImage("pin-live", livePinImage);
  state.map.addSource("location-pins", {
    type: "geojson",
    data: createLocationFeatureCollection(locations)
  });

  state.map.addLayer({
    id: "demo-pin-symbols",
    type: "symbol",
    source: "location-pins",
    filter: ["!=", ["get", "isLiveMeter"], true],
    layout: {
      "icon-image": "pin-demo",
      "icon-size": 1,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    }
  });

  state.map.addLayer({
    id: "live-pin-symbol",
    type: "symbol",
    source: "location-pins",
    filter: ["==", ["get", "isLiveMeter"], true],
    layout: {
      "icon-image": "pin-live",
      "icon-size": 1,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": 1
    }
  });

  ["demo-pin-symbols", "live-pin-symbol"].forEach((layerId) => {
    state.map.on("click", layerId, (event) => {
      const feature = event.features?.[0];
      const location = getLocationById(feature?.properties?.id);

      if (location) {
        focusLocation(location);
      }
    });

    state.map.on("mouseenter", layerId, () => {
      state.map.getCanvas().style.cursor = "pointer";
    });

    state.map.on("mouseleave", layerId, () => {
      state.map.getCanvas().style.cursor = "";
    });
  });

  animateLivePinPulse();
}

function loadMapImage(url) {
  return new Promise((resolve, reject) => {
    state.map.loadImage(url, (error, image) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(image);
    });
  });
}

function createPinImage(image, tintColor = null) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = PIN_ICON_WIDTH;
  canvas.height = PIN_ICON_HEIGHT;
  context.drawImage(image, 0, 0, PIN_ICON_WIDTH, PIN_ICON_HEIGHT);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  if (!tintColor) {
    return imageData;
  }

  const pixels = imageData.data;

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) {
      continue;
    }

    pixels[index] = Math.round(pixels[index] * 0.72 + tintColor.red * 0.28);
    pixels[index + 1] = Math.round(pixels[index + 1] * 0.58 + tintColor.green * 0.42);
    pixels[index + 2] = Math.round(pixels[index + 2] * 0.62 + tintColor.blue * 0.38);
  }

  return imageData;
}

function createLocationFeatureCollection(locations) {
  return {
    type: "FeatureCollection",
    features: locations.map((location) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [location.longitude, location.latitude]
      },
      properties: {
        id: location.id,
        isLiveMeter: isLiveMeterLocation(location)
      }
    }))
  };
}

function animateLivePinPulse() {
  if (!state.map.getLayer("live-pin-symbol")) {
    return;
  }

  const elapsed = performance.now() / 1800;
  const phase = (Math.sin(elapsed * Math.PI * 2) + 1) / 2;

  state.map.setLayoutProperty("live-pin-symbol", "icon-size", 0.96 + phase * 0.08);
  state.map.setPaintProperty("live-pin-symbol", "icon-opacity", 0.78 + phase * 0.22);

  window.requestAnimationFrame(animateLivePinPulse);
}

function markLiveMeterLocation() {
  const liveLocation = getLiveMeterLocation();

  if (!liveLocation) {
    return;
  }

  liveLocation.isLiveMeter = true;
  liveLocation.name = LIVE_METER_LOCATION_NAME;
  liveLocation.latitude = LIVE_METER_COORDINATES.latitude;
  liveLocation.longitude = LIVE_METER_COORDINATES.longitude;
  liveMeterName.textContent = liveLocation.name;
  updateLiveMeterDisplay();
}

function getLiveMeterLocation() {
  return state.locations.find((location) => location.id === LIVE_METER_LOCATION_ID);
}

function getLocationById(id) {
  return state.locations.find((location) => location.id === id);
}

function isLiveMeterLocation(location) {
  return location.id === LIVE_METER_LOCATION_ID;
}

function connectToFirebase() {
  fetchLatestFirebaseState();
  openFirebaseStream();
  startFirebasePollingBackup();
}

async function fetchLatestFirebaseState() {
  try {
    setFirebaseStatus("Checking Firebase");
    const response = await fetch(`${FIREBASE_DATABASE_URL}/${FIREBASE_FORTUNES_PATH}.json`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Firebase read failed.");
    }

    state.firebaseFortunes = normalizeFortunes(await response.json());
    updateLiveMeterFromFirebase();
    setFirebaseStatus(`Synced ${formatSyncTime()}`);
  } catch (error) {
    setFirebaseStatus("Firebase unavailable");
    console.error(error);
  }
}

function startFirebasePollingBackup() {
  if (state.firebasePoller) {
    window.clearInterval(state.firebasePoller);
  }

  state.firebasePoller = window.setInterval(fetchLatestFirebaseState, 5000);
}

function openFirebaseStream() {
  if (!("EventSource" in window)) {
    setFirebaseStatus("Realtime stream unavailable");
    return;
  }

  state.firebaseStream?.close();
  state.firebaseStream = new EventSource(`${FIREBASE_DATABASE_URL}/${FIREBASE_FORTUNES_PATH}.json`);

  state.firebaseStream.addEventListener("open", () => {
    setFirebaseStatus("Live from Firebase");
  });

  state.firebaseStream.addEventListener("put", handleFirebaseStreamEvent);
  state.firebaseStream.addEventListener("patch", handleFirebaseStreamEvent);

  state.firebaseStream.addEventListener("error", () => {
    setFirebaseStatus("Reconnecting to Firebase");
  });
}

function handleFirebaseStreamEvent(event) {
  try {
    const message = JSON.parse(event.data);
    applyFirebaseUpdate(message.path, message.data);
    updateLiveMeterFromFirebase();
    setFirebaseStatus(`Live ${formatSyncTime()}`);
  } catch (error) {
    console.error(error);
    fetchLatestFirebaseState();
  }
}

function applyFirebaseUpdate(path, data) {
  if (path === "/") {
    state.firebaseFortunes = normalizeFortunes(data);
    return;
  }

  const parts = path.split("/").filter(Boolean);
  const fortuneId = parts[0];

  if (!fortuneId) {
    return;
  }

  if (parts.length === 1) {
    if (data === null) {
      delete state.firebaseFortunes[fortuneId];
    } else {
      state.firebaseFortunes[fortuneId] = data;
    }

    return;
  }

  if (!state.firebaseFortunes[fortuneId]) {
    state.firebaseFortunes[fortuneId] = {};
  }

  if (data === null) {
    delete state.firebaseFortunes[fortuneId][parts[1]];
  } else {
    state.firebaseFortunes[fortuneId][parts[1]] = data;
  }
}

function normalizeFortunes(data) {
  if (!data || typeof data !== "object") {
    return {};
  }

  return data;
}

function updateLiveMeterFromFirebase() {
  const latestReading = getLatestFirebaseReading();

  if (!latestReading) {
    updateLiveMeterDisplay();
    return;
  }

  const latestVersion = getReadingVersion(latestReading);

  if (
    state.liveMeterReadingVersion &&
    compareReadingVersions(latestVersion, state.liveMeterReadingVersion) < 0
  ) {
    return;
  }

  state.liveMeterReadingVersion = latestVersion;
  state.liveMeterData = {
    id: latestReading.id,
    fortune: latestReading.fortune || "",
    voicesCollected: Number(latestReading.voices_collected),
    timestamp: latestReading.timestamp || null
  };

  const liveLocation = getLiveMeterLocation();

  if (liveLocation) {
    liveLocation.forecast = state.liveMeterData.fortune || liveLocation.forecast;
    liveLocation.voiceCount = Number.isFinite(state.liveMeterData.voicesCollected)
      ? state.liveMeterData.voicesCollected
      : liveLocation.voiceCount;
  }

  updateLiveMeterDisplay();
  refreshLiveMeterPopup();
}

function getLatestFirebaseReading() {
  const readings = Object.entries(state.firebaseFortunes)
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => ({ id, ...value }))
    .filter((value) => "fortune" in value || "voices_collected" in value)
    .sort(compareFirebaseReadingOrder);

  return readings[readings.length - 1];
}

function compareFirebaseReadingOrder(a, b) {
  return compareReadingVersions(getReadingVersion(a), getReadingVersion(b));
}

function getReadingVersion(reading) {
  const timestamp = Number(reading.timestamp);

  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    id: reading.id || ""
  };
}

function compareReadingVersions(a, b) {
  if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }

  if (a.timestamp !== null && b.timestamp === null) {
    return 1;
  }

  if (a.timestamp === null && b.timestamp !== null) {
    return -1;
  }

  const keyComparison = a.id.localeCompare(b.id);

  if (keyComparison !== 0) {
    return keyComparison;
  }

  return getReadingSortValue(a) - getReadingSortValue(b);
}

function getReadingSortValue(reading) {
  const timestamp = Number(reading.timestamp);

  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  return reading.id ? reading.id.charCodeAt(reading.id.length - 1) : 0;
}

function updateLiveMeterDisplay() {
  const fortune = state.liveMeterData?.fortune || "Waiting for the Pi to publish a fortune.";
  const voicesCollected = Number.isFinite(state.liveMeterData?.voicesCollected)
    ? state.liveMeterData.voicesCollected
    : 0;

  liveMeterFortune.textContent = fortune;
  liveMeterVoices.textContent = formatVoiceCount(voicesCollected);
}

function refreshLiveMeterPopup() {
  if (state.activePopupId !== LIVE_METER_LOCATION_ID || !state.activePopup) {
    return;
  }

  const liveLocation = getLiveMeterLocation();
  state.activePopup.setHTML(renderPopupMarkup(liveLocation));
}

function setFirebaseStatus(message) {
  liveMeterSync.textContent = message;
}

function formatSyncTime() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderPopupMarkup(location) {
  const weatherStyle = getWeatherStyle(location.weatherCategory);
  const isLiveMeter = isLiveMeterLocation(location);
  const displayForecast = isLiveMeter && !state.liveMeterData
    ? "Waiting for the Pi to publish a fortune."
    : location.forecast;
  const displayVoiceCount = isLiveMeter && !state.liveMeterData ? 0 : location.voiceCount;
  const liveBadge = isLiveMeter
    ? `<span class="popup-live-badge">Connected</span>`
    : `<span class="popup-live-badge popup-live-badge-demo">Demo point</span>`;

  return `
    <article class="popup-card">
      <div class="popup-meta">
        <div class="popup-category">
          <span class="popup-icon" aria-hidden="true">${getWeatherIconMarkup(location.weatherCategory, weatherStyle.color)}</span>
          <span>${location.weatherCategory}</span>
        </div>
        <div class="popup-chip-row">
          ${liveBadge}
        </div>
      </div>
      <p class="popup-forecast">${escapeHtml(displayForecast)}</p>
      <div class="popup-voices">${formatVoiceCount(displayVoiceCount)}</div>
    </article>
  `;
}

function focusLocation(location) {
  if (!state.map) {
    return;
  }

  closeAllPopups();

  state.map.flyTo({
    center: [location.longitude, location.latitude],
    zoom: 15.15,
    speed: 0.72,
    curve: 1.15,
    essential: true
  });

  state.activePopupId = location.id;
  state.activePopup = new mapboxgl.Popup({
    offset: 28,
    closeButton: true,
    closeOnClick: false,
    anchor: "bottom"
  })
    .setLngLat([location.longitude, location.latitude])
    .setHTML(renderPopupMarkup(location))
    .addTo(state.map);

  state.activePopup.on("close", () => {
    if (state.activePopupId === location.id) {
      state.activePopupId = null;
      state.activePopup = null;
    }
  });
}

function closeAllPopups() {
  state.activePopup?.remove();
  state.activePopup = null;
  state.activePopupId = null;
}

function locateUser() {
  if (!navigator.geolocation || !state.map) {
    currentLocation.textContent = "Providence, RI";
    return;
  }

  currentLocation.textContent = "Locating...";

  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      const lngLat = [coords.longitude, coords.latitude];

      currentLocation.textContent = await getLocationLabel(lngLat);

      const bounds = state.map.getBounds();

      if (!bounds.contains(lngLat)) {
        state.map.fitBounds([PROVIDENCE_CENTER, lngLat], {
          padding: 80,
          duration: 900
        });
      }
    },
    () => {
      currentLocation.textContent = "Providence, RI";
    },
    {
      enableHighAccuracy: true,
      timeout: 10000
    }
  );
}

async function getLocationLabel([longitude, latitude]) {
  try {
    const params = new URLSearchParams({
      access_token: MAPBOX_ACCESS_TOKEN,
      types: "place,postcode"
    });
    const response = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${longitude},${latitude}.json?${params}`
    );

    if (!response.ok) {
      throw new Error("Unable to look up current location.");
    }

    const data = await response.json();
    return formatLocationLabel(data.features) || formatCoordinates(longitude, latitude);
  } catch (error) {
    console.error(error);
    return formatCoordinates(longitude, latitude);
  }
}

function formatLocationLabel(features) {
  if (!Array.isArray(features)) {
    return "";
  }

  const place = features.find((feature) => feature.place_type?.includes("place"));
  const postcode = features.find((feature) => feature.place_type?.includes("postcode"));
  const city = place?.text;
  const stateCode = place?.context
    ?.find((item) => item.id?.startsWith("region."))
    ?.short_code
    ?.split("-")
    .pop()
    ?.toUpperCase();
  const zipCode = postcode?.text;

  const cityRegion = [city, stateCode].filter(Boolean).join(", ");

  return [cityRegion, zipCode].filter(Boolean).join(" ");
}

function formatCoordinates(longitude, latitude) {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function renderTokenState() {
  const mapElement = document.getElementById("map");
  mapElement.innerHTML = `
    <div class="token-note">
      <p>
        The map canvas is ready, but Mapbox needs a public access token before the basemap can load.
        Open <code>script.js</code> and replace <code>YOUR_MAPBOX_ACCESS_TOKEN</code> with your token from
        <a href="https://account.mapbox.com/" target="_blank" rel="noreferrer">Mapbox</a>.
      </p>
    </div>
  `;
  currentLocation.textContent = "Providence, RI";
}

function renderErrorState() {
  const mapElement = document.getElementById("map");
  mapElement.innerHTML = `
    <div class="token-note">
      <p>
        The location dataset could not be loaded. Make sure <code>data/locations.json</code> is present
        and the page is being served through Live Server or another local server.
      </p>
    </div>
  `;
  currentLocation.textContent = "Providence, RI";
}

function hasUsableToken() {
  return MAPBOX_ACCESS_TOKEN && !MAPBOX_ACCESS_TOKEN.includes("YOUR_MAPBOX_ACCESS_TOKEN");
}

function getWeatherStyle(category) {
  return WEATHER_STYLES[category] || WEATHER_STYLES.Overcast;
}

function startClock() {
  updateClock();
  window.setInterval(updateClock, 60000);
}

function updateClock() {
  const now = new Date();
  currentDate.textContent = now.toLocaleDateString([], {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  currentTime.textContent = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatVoiceCount(count) {
  const numericCount = Number(count);
  const safeCount = Number.isFinite(numericCount) ? numericCount : 0;
  const label = safeCount === 1 ? "voice" : "voices";
  return `${safeCount} ${label} collected`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getWeatherIconMarkup(category, color) {
  const soft = hexToRgba(color, 0.22);
  const warmWhite = "#f7f2f1";
  const coolWhite = "#e9edf6";

  const icons = {
    Clear: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <radialGradient id="sunGloss" cx="42%" cy="38%" r="70%">
            <stop offset="0%" stop-color="#fff4ae" />
            <stop offset="55%" stop-color="#ffd76a" />
            <stop offset="100%" stop-color="#ffbf4d" />
          </radialGradient>
          <linearGradient id="cloudGlossWarm" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#fffdfd" />
            <stop offset="42%" stop-color="${warmWhite}" />
            <stop offset="100%" stop-color="#ddd6d5" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="12" r="6.2" fill="url(#sunGloss)" />
        <ellipse cx="18.4" cy="10.4" rx="3.1" ry="2" fill="rgba(255,255,255,0.34)" />
        <g stroke="#ffd15d" stroke-linecap="round" stroke-width="1.8">
          <line x1="20" y1="1.8" x2="20" y2="5.2" />
          <line x1="20" y1="19.2" x2="20" y2="22.4" />
          <line x1="9.6" y1="12" x2="12.8" y2="12" />
          <line x1="27.2" y1="12" x2="30.2" y2="12" />
          <line x1="12.5" y1="4.7" x2="14.8" y2="7" />
          <line x1="25.2" y1="17.4" x2="27.4" y2="19.6" />
          <line x1="12.5" y1="19.4" x2="14.8" y2="17.2" />
          <line x1="25.2" y1="6.8" x2="27.4" y2="4.5" />
        </g>
        <path d="M8.8 24.9h13.1c3.1 0 5.6-2 5.6-4.8 0-2.6-1.9-4.6-4.6-4.8-.7-3.7-4-6.3-7.8-6.3-4.2 0-7.6 3-8.1 7.1-2.6.4-4.4 2.4-4.4 4.9 0 2.2 1.5 3.9 4 3.9Z" fill="url(#cloudGlossWarm)" stroke="#d8cfcd" stroke-width="1.25" />
        <path d="M8.8 24.9h13.1c3.1 0 5.6-2 5.6-4.8 0-2.6-1.9-4.6-4.6-4.8-.7-3.7-4-6.3-7.8-6.3-4.2 0-7.6 3-8.1 7.1-2.6.4-4.4 2.4-4.4 4.9 0 2.2 1.5 3.9 4 3.9Z" fill="none" stroke="rgba(255,255,255,0.66)" stroke-width="0.9" transform="translate(0 -0.5)" />
      </svg>
    `,
    Overcast: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <linearGradient id="cloudGlossGray" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#f1eef2" />
            <stop offset="52%" stop-color="#cbc8d0" />
            <stop offset="100%" stop-color="#9e9ba4" />
          </linearGradient>
        </defs>
        <path d="M8.4 24.6h14.9c3 0 5.3-1.9 5.3-4.6 0-2.5-1.9-4.4-4.4-4.6-.7-4-4-6.5-7.9-6.5-4.2 0-7.7 3.1-8.2 7.2-2.8.4-4.8 2.4-4.8 5 0 2.2 1.5 3.5 5.1 3.5Z" fill="url(#cloudGlossGray)" stroke="#b1adb6" stroke-width="1.35" />
        <path d="M8.8 16.2c2.1-2 5.5-2.8 8.9-2.4 3 .3 5.2 1.5 6.6 3.4" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    `,
    Drizzle: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <linearGradient id="cloudGlossCool" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#f9fbff" />
            <stop offset="55%" stop-color="${coolWhite}" />
            <stop offset="100%" stop-color="#c5d0dc" />
          </linearGradient>
        </defs>
        <path d="M8.5 20.8h14.8c3 0 5.2-1.9 5.2-4.6 0-2.5-1.8-4.3-4.4-4.6-.8-4-4-6.4-7.8-6.4-4.3 0-7.8 3.1-8.2 7.2-2.8.3-4.8 2.4-4.8 5 0 2.2 1.6 3.4 5.2 3.4Z" fill="url(#cloudGlossCool)" stroke="#cad1d8" stroke-width="1.3" />
        <g stroke="${color}" stroke-linecap="round" stroke-width="1.8">
          <line x1="11.7" y1="23.4" x2="10.3" y2="27.1" />
          <line x1="17" y1="23.8" x2="15.6" y2="27.5" />
          <line x1="22.3" y1="23.4" x2="20.9" y2="27.1" />
        </g>
        <g fill="#ffffff" opacity="0.7">
          <circle cx="11.1" cy="27.8" r="0.7" />
          <circle cx="16.4" cy="28.2" r="0.7" />
          <circle cx="21.7" cy="27.8" r="0.7" />
        </g>
      </svg>
    `,
    Windy: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <linearGradient id="cloudGlossWind" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#fffdfb" />
            <stop offset="50%" stop-color="#eee7e2" />
            <stop offset="100%" stop-color="#d6cbc1" />
          </linearGradient>
        </defs>
        <path d="M7.8 17.8h13.4c2.6 0 4.4-1.5 4.4-3.7 0-2-1.5-3.5-3.6-3.7-.6-3.2-3.2-5.3-6.6-5.3-3.5 0-6.4 2.5-6.8 5.9-2.3.2-4 1.9-4 4 0 1.8 1.4 2.8 3.2 2.8Z" fill="url(#cloudGlossWind)" stroke="#d6cbc1" stroke-width="1.3" />
        <g fill="none" stroke="${color}" stroke-linecap="round" stroke-width="1.8">
          <path d="M3.8 22.4c1.8-1.1 3.8-1.3 5.8-.8 1.8.4 3.5.1 5-.9" />
          <path d="M12.4 25.5c1.6-.8 3.3-.9 4.9-.5 1.3.3 2.8-.1 4.4-1.1" />
        </g>
        <path d="M21 23.1c1.4-.9 2.6-.9 3.6-.2 1 .6 2.1.7 3.4-.2" fill="none" stroke="${soft}" stroke-linecap="round" stroke-width="1.3" />
      </svg>
    `,
    Stormy: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <linearGradient id="stormCloud" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#8f93a1" />
            <stop offset="58%" stop-color="#6e7281" />
            <stop offset="100%" stop-color="#575a67" />
          </linearGradient>
          <linearGradient id="stormBolt" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#b79cff" />
            <stop offset="100%" stop-color="#755ef4" />
          </linearGradient>
        </defs>
        <path d="M8.5 19.8h14.8c3 0 5.2-1.9 5.2-4.6 0-2.5-1.8-4.3-4.4-4.6-.8-4-4-6.4-7.8-6.4-4.3 0-7.8 3.1-8.2 7.2-2.8.3-4.8 2.4-4.8 5 0 2.2 1.6 3.4 5.2 3.4Z" fill="url(#stormCloud)" stroke="#777b88" stroke-width="1.3" />
        <path d="M16.2 21.1h4.1l-2.5 4.2h2.5L15.2 31l1.6-4.7h-2.7Z" fill="url(#stormBolt)" stroke="#7b67f6" stroke-width="0.75" />
        <g fill="#f7f3ff" opacity="0.8">
          <circle cx="24.8" cy="23.6" r="0.8" />
          <circle cx="27.2" cy="24.8" r="0.55" />
        </g>
      </svg>
    `,
    Warming: `
      <svg viewBox="0 0 32 32" role="presentation" focusable="false">
        <defs>
          <linearGradient id="cloudGlossWarm2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#fffdfd" />
            <stop offset="45%" stop-color="${warmWhite}" />
            <stop offset="100%" stop-color="#d9d5d7" />
          </linearGradient>
        </defs>
        <path d="M8.5 22h14.8c3 0 5.2-1.9 5.2-4.6 0-2.5-1.8-4.3-4.4-4.6-.8-4-4-6.4-7.8-6.4-4.3 0-7.8 3.1-8.2 7.2-2.8.3-4.8 2.4-4.8 5 0 2.2 1.6 3.4 5.2 3.4Z" fill="url(#cloudGlossWarm2)" stroke="#d9d0cf" stroke-width="1.3" />
        <path d="M20.5 10.6c2.7-.2 5.1 1 7 3" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" />
        <path d="M20.8 13.9c2.1-.1 4 .7 5.4 2.1" fill="none" stroke="${soft}" stroke-width="2.2" stroke-linecap="round" />
        <path d="M21 17.1c1.4-.1 2.8.4 4 1.4" fill="none" stroke="#f2c772" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    `
  };

  return icons[category] || icons.Overcast;
}
