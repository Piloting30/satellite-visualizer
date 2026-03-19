/**
 * Satellite Visualizer
 * WebGPU + Real Satellite Metadata + AI Filtering + Simulation Time Controls
 */

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import * as satellite from "satellite.js";
import Papa from "papaparse";

import { currentFilter } from "./search.js";

/* --------------------------------------------------
  Load TLE data
  Also parses NORAD ID from line 1 (chars 3-7) so we can
  join against satcat on a stable numeric key.
-------------------------------------------------- */

async function loadTLE() {
  const response = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle");
  if (!response.ok) throw new Error(`TLE fetch failed: ${response.status}`);

  const text  = await response.text();
  // Normalise line endings and drop blank lines
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const sats  = [];

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name  = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    // Validate TLE line format — line 1 starts with "1 ", line 2 with "2 "
    if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) continue;

    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    try {
      sats.push({ name, noradId, satrec: satellite.twoline2satrec(line1, line2) });
    } catch (e) {
      // Skip malformed TLE entries
    }
  }
  return sats;
}

/* --------------------------------------------------
  Name normalization + alternate-name extraction
  (kept as fallback for satellites missing from satcat)
-------------------------------------------------- */

function normalizeSatName(name) {
  return name
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAllNames(field) {
  const names = new Set();
  if (!field) return names;
  const raw = field.replace(/\u00a0/g, " ").trim();
  const primary = raw.split("(")[0].trim();
  if (primary) names.add(primary);
  const parenRe = /\(([^)]+)\)/g;
  let m;
  while ((m = parenRe.exec(raw)) !== null) {
    m[1].split(",").forEach(part => { const p = part.trim(); if (p) names.add(p); });
  }
  return names;
}

/* --------------------------------------------------
  Load CelesTrak satcat  (primary — keyed by NORAD ID)
  https://celestrak.org/pub/satcat.csv
  Columns we use:
    NORAD_CAT_ID, OBJECT_NAME, COUNTRY, LAUNCH_DATE,
    OBJECT_TYPE, PERIOD, APOGEE, PERIGEE
-------------------------------------------------- */

async function loadSatcat() {
  const response = await fetch("https://celestrak.org/pub/satcat.csv");
  const csv = await response.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  const satcat = {};
  parsed.data.forEach(row => {
    const id = parseInt(row["NORAD_CAT_ID"], 10);
    if (!id) return;

    // Derive orbit class from period (minutes)
    const period = parseFloat(row["PERIOD"]);
    let orbit = "Unknown";
    if (!isNaN(period)) {
      if      (period <  128) orbit = "LEO";
      else if (period < 600)  orbit = "MEO";
      else if (period > 1400 && period < 1500) orbit = "GEO";
      else                    orbit = "HEO";
    }

    satcat[id] = {
      country:  (row["COUNTRY"]      || "").trim(),
      operator: "",                          // satcat has no operator field
      type:     (row["OBJECT_TYPE"]  || "").trim(),
      orbit,
      launchDate: (row["LAUNCH_DATE"] || "").trim(),
      status:     row["DECAY_DATE"] ? "Decayed" : "Active"
    };
  });

  return satcat;
}

/* --------------------------------------------------
  Load UCS catalog  (secondary — adds purpose/type detail)
  Keyed first by NORAD ID via the catalog's own NORAD column,
  then by name as a fallback.
-------------------------------------------------- */

async function loadUCS() {
  const response = await fetch("/data/ucs_satellite_catalog.csv");
  const csv = await response.text();
  // transformHeader trims whitespace and deduplicates empty/repeated column
  // names (the UCS sheet has many blank trailing columns and 7 "Source" columns)
  // so Papa.parse never needs to rename them and the warning is suppressed.
  const seenHeaders = {};
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => {
      const clean = h.trim();
      if (!clean) return `__empty_${Object.keys(seenHeaders).length}__`;
      if (seenHeaders[clean]) {
        seenHeaders[clean]++;
        return `${clean}_${seenHeaders[clean]}`;
      }
      seenHeaders[clean] = 1;
      return clean;
    }
  });

  const byNorad = {};   // NORAD ID (int) → entry
  const exact   = {};   // uppercased official name → entry
  const norm    = {};   // normalized name → entry
  const alts    = {};   // normalized alternate name → entry

  parsed.data.forEach(row => {
    const rawName = row["Current Official Name of Satellite"];
    if (!rawName) return;
    const name = rawName.replace(/\u00a0/g, " ").trim();
    if (!name) return;

    const noradRaw = row["NORAD Number"] || row["NORAD_Number"] || row["Norad Number"] || "";
    const noradId  = parseInt(noradRaw, 10);

    const entry = {
      name,
      country:  (row["Country of Operator/Owner"] || "").trim(),
      operator: (row["Operator/Owner"]             || "").trim(),
      type:     (row["Purpose"]                    || "").trim(),
      orbit:    (row["Class of Orbit"]             || "").trim()
    };

    if (noradId) byNorad[noradId] = entry;
    exact[name.toUpperCase()]    = entry;
    norm[normalizeSatName(name)] = entry;

    const altField = row["Name of Satellite, Alternate Names"] || "";
    extractAllNames(altField).forEach(n => {
      const key = normalizeSatName(n);
      if (key && !alts[key]) alts[key] = entry;
    });
    const officialKey = normalizeSatName(name);
    if (officialKey && !alts[officialKey]) alts[officialKey] = entry;
  });

  function lookup(noradId, tleName) {
    if (noradId && byNorad[noradId]) return byNorad[noradId];
    const upper = tleName.trim().toUpperCase();
    if (exact[upper]) return exact[upper];
    const n = normalizeSatName(tleName);
    if (norm[n]) return norm[n];
    for (const variant of extractAllNames(tleName)) {
      const key = normalizeSatName(variant);
      if (alts[key]) return alts[key];
    }
    return null;
  }

  return lookup;
}

/* --------------------------------------------------
  ECI -> Three.js coordinate conversion
-------------------------------------------------- */

function satToVector(position) {
  const scale = 1 / 6371;
  return new THREE.Vector3(
    position.x * scale,
    position.z * scale,
    -position.y * scale
  );
}

/* --------------------------------------------------
  Simulation Time State
-------------------------------------------------- */

export const simState = {
  time:            Date.now(),
  speed:           1,
  paused:          false,
  isLive:          true,
  needsTrailReset: false,

  pause()  { this.paused = true;  this.isLive = false; },
  play()   { this.paused = false; },

  jumpToNow() {
    this.time            = Date.now();
    this.paused          = false;
    this.isLive          = true;
    this.speed           = 1;
    this.needsTrailReset = true;
  },

  setSpeed(s) {
    if ((s < 0) !== (this.speed < 0)) this.needsTrailReset = true;
    this.speed  = s;
    this.isLive = false;
    if (this.paused) this.paused = false;
  },

  step(wallDeltaMs) {
    if (this.paused) return 0;
    if (this.isLive) {
      const prev = this.time;
      this.time  = Date.now();
      return this.time - prev;
    } else {
      const delta = wallDeltaMs * this.speed;
      this.time  += delta;
      return delta;
    }
  }
};

/* --------------------------------------------------
  Trail System — single shared geometry, explicit segment pairs.

  Key insight: instead of a LINE_STRIP with an index buffer (which
  permanently connects consecutive slots and causes streak artifacts),
  we use LINE_SEGMENTS mode (pairs of vertices). For each consecutive
  pair of valid ring-buffer points we emit BOTH vertices explicitly.
  On reset or for unfilled slots we simply emit nothing — the segment
  count drops to zero and nothing is drawn. No index buffer, no
  connectivity artifacts, one draw call.

  Layout: satellite i gets slots [i*MAX_SEGS*2 .. (i+1)*MAX_SEGS*2-1]
  where each pair (2k, 2k+1) is one line segment.
-------------------------------------------------- */

const TRAIL_PTS  = 80;            // ring buffer size (positions stored)
const MAX_SEGS   = TRAIL_PTS - 1; // max segments = pts - 1
const TRAIL_R = 0.3, TRAIL_G = 0.7, TRAIL_B = 1.0, TRAIL_MAX_ALPHA = 0.55;

function createTrailSystem(count) {
  // 2 vertices per segment × MAX_SEGS segments × count satellites
  const vertCount = count * MAX_SEGS * 2;
  const positions = new Float32Array(vertCount * 3);
  const colors    = new Float32Array(vertCount * 4);

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors,    4);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("color",    colAttr);
  // No index buffer — LINE_SEGMENTS reads consecutive pairs
  geo.setDrawRange(0, 0); // nothing until we write real data

  const mat   = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  // Per-satellite ring buffers (stored flat for cache efficiency)
  const rbPos  = new Float32Array(count * TRAIL_PTS * 3); // ring buffer positions
  const heads  = new Int32Array(count);  // write head
  const filled = new Int32Array(count);  // how many valid points

  return { lines, geo, positions, colors, rbPos, heads, filled, count };
}

function resetAllTrails(trail) {
  trail.heads.fill(0);
  trail.filled.fill(0);
  trail.rbPos.fill(0);      // clear ring buffer so stale positions don't leak back
  trail.positions.fill(0);  // clear vertex buffer — nothing drawn until new points arrive
  trail.colors.fill(0);
  trail.geo.attributes.position.needsUpdate = true;
  trail.geo.attributes.color.needsUpdate    = true;
}

function flushTrails(trail) {
  const { positions, colors, rbPos, heads, filled, count } = trail;

  for (let i = 0; i < count; i++) {
    const f    = filled[i];
    const vBase = i * MAX_SEGS * 2; // this satellite's vertex block in shared buffer

    if (f < 2) {
      // Reset or not enough points yet — explicitly zero this satellite's
      // entire vertex block so no stale positions survive from a previous frame.
      const vStart = vBase * 3;
      const vEnd   = vStart + MAX_SEGS * 2 * 3;
      positions.fill(0, vStart, vEnd);
      colors.fill(0, vBase * 4, vBase * 4 + MAX_SEGS * 2 * 4);
      continue;
    }

    const h      = heads[i];
    const start  = (h - f + TRAIL_PTS * 2) % TRAIL_PTS;
    const rbBase = i * TRAIL_PTS * 3;
    const segCount = f - 1;

    for (let s = 0; s < segCount; s++) {
      const idxA = (start + s)     % TRAIL_PTS;
      const idxB = (start + s + 1) % TRAIL_PTS;
      const pA   = rbBase + idxA * 3;
      const pB   = rbBase + idxB * 3;
      const vA   = (vBase + s * 2)     * 3;
      const vB   = (vBase + s * 2 + 1) * 3;

      positions[vA]     = rbPos[pA];     positions[vA + 1] = rbPos[pA + 1]; positions[vA + 2] = rbPos[pA + 2];
      positions[vB]     = rbPos[pB];     positions[vB + 1] = rbPos[pB + 1]; positions[vB + 2] = rbPos[pB + 2];

      const alphaA = (s       / (segCount - 1 || 1)) * TRAIL_MAX_ALPHA;
      const alphaB = ((s + 1) / (segCount - 1 || 1)) * TRAIL_MAX_ALPHA;
      const cA = (vBase + s * 2)     * 4;
      const cB = (vBase + s * 2 + 1) * 4;

      colors[cA]     = TRAIL_R; colors[cA + 1] = TRAIL_G; colors[cA + 2] = TRAIL_B; colors[cA + 3] = alphaA;
      colors[cB]     = TRAIL_R; colors[cB + 1] = TRAIL_G; colors[cB + 2] = TRAIL_B; colors[cB + 3] = alphaB;
    }

    // Zero out any leftover segments beyond the current fill
    // (from when this satellite previously had more points)
    if (segCount < MAX_SEGS) {
      const clearStart = (vBase + segCount * 2) * 3;
      const clearEnd   = (vBase + MAX_SEGS * 2) * 3;
      positions.fill(0, clearStart, clearEnd);
    }
  }

  trail.geo.attributes.position.needsUpdate = true;
  trail.geo.attributes.color.needsUpdate    = true;
  trail.geo.setDrawRange(0, count * MAX_SEGS * 2);
}

function pushTrailPoint(trail, idx, pos) {
  const head   = trail.heads[idx];
  const rbBase = idx * TRAIL_PTS * 3;

  trail.rbPos[rbBase + head * 3]     = pos.x;
  trail.rbPos[rbBase + head * 3 + 1] = pos.y;
  trail.rbPos[rbBase + head * 3 + 2] = pos.z;

  trail.heads[idx]  = (head + 1) % TRAIL_PTS;
  if (trail.filled[idx] < TRAIL_PTS) trail.filled[idx]++;
}

/* --------------------------------------------------
  Satellite List Panel
-------------------------------------------------- */

function buildSatelliteList(activeSatellites, visibleMask, onSelect, onHover, onHoverEnd) {
  const countEl = document.getElementById("sat-list-count");
  const listEl  = document.getElementById("sat-list-items");

  const visibleIndices = activeSatellites
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => visibleMask[i])
    .sort((a, b) => a.s.name.localeCompare(b.s.name));

  const total   = activeSatellites.length;
  const visible = visibleIndices.length;
  countEl.textContent = `Showing ${visible.toLocaleString()} of ${total.toLocaleString()}`;

  listEl.innerHTML = "";
  listEl.scrollTop = 0;

  for (const { s, i } of visibleIndices) {
    const row = document.createElement("div");
    row.className   = "sat-row";
    row.dataset.idx = i;
    row.textContent = s.name;
    row.addEventListener("click",      () => onSelect(i));
    row.addEventListener("mouseenter", () => onHover(i, row));
    row.addEventListener("mouseleave", () => onHoverEnd());
    listEl.appendChild(row);
  }
}

function setSelectedRow(idx) {
  document.querySelectorAll(".sat-row").forEach(r => {
    r.classList.toggle("selected", parseInt(r.dataset.idx) === idx);
  });
}

/* --------------------------------------------------
  Main App
-------------------------------------------------- */

async function init() {
  if (!navigator.gpu) {
    document.body.innerHTML = "WebGPU not supported in this browser.";
    return;
  }

  const scene          = new THREE.Scene();
  const loadingOverlay = document.getElementById("loading-overlay");

  /* Camera */
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.5, 4);

  /* Renderer */
  const renderer = new WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  /* Controls */
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  /* Lighting */
  const sunLight = new THREE.DirectionalLight(0xffffff, 2);
  sunLight.position.set(5, 2, 5);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x222222));

  /* Textures */
  const loader     = new THREE.TextureLoader();
  const earthDay   = loader.load("/textures/earth_atmos_2048.jpg");
  const earthNight = loader.load("/textures/earth_lights_2048.png");
  const clouds     = loader.load("/textures/earth_clouds_1024.png");
  const stars      = loader.load("/textures/starfield.jpg");

  /* Starfield — MeshBasicNodeMaterial is WebGPU-compatible */
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(100, 64, 64),
    new MeshBasicNodeMaterial({ map: stars, side: THREE.BackSide })
  ));

  /* Earth — MeshStandardNodeMaterial required by WebGPURenderer.
     Day texture as map; night lights blended in via emissive. */
  const earthMat = new MeshStandardNodeMaterial();
  earthMat.map             = earthDay;
  earthMat.emissiveMap     = earthNight;
  earthMat.emissive        = new THREE.Color(0xffffff);
  earthMat.emissiveIntensity = 0.6;

  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), earthMat);
  scene.add(earth);

  /* Clouds */
  const cloudMat = new MeshStandardNodeMaterial();
  cloudMat.map         = clouds;
  cloudMat.transparent = true;
  cloudMat.opacity     = 0.8;

  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.01, 64, 64), cloudMat);
  scene.add(cloudMesh);

  /* Atmosphere — two-layer physically-inspired glow.
     
     Layer 1 (outer halo, FrontSide): the bright limb glow seen from space.
       - viewDot = dot(normalWorld, cameraDirection) — 1.0 at center, 0.0 at limb
       - rimFactor = 1 - viewDot  →  peaks at the limb edge
       - raised to a high power (~4) for a thin, tight rim
       - deep blue (0.15, 0.5, 1.0) fading to transparent at center
     
     Layer 2 (inner haze, FrontSide): diffuse blue tint over the dayside.
       - softer falloff (pow ~1.5), much lower opacity
       - slightly warmer blue-white (0.3, 0.6, 1.0) to mimic Rayleigh scattering
  */

  // Shared: view-space dot product — how directly the surface faces the camera
  const nWorld  = TSL.normalWorld;
  const camDir  = TSL.normalize(TSL.cameraPosition.sub(TSL.positionWorld));
  const viewDot = TSL.clamp(TSL.dot(nWorld, camDir), 0.0, 1.0);

  // --- Outer halo ---
  const haloMat = new MeshBasicNodeMaterial({
    side:        THREE.FrontSide,
    transparent: true,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
  });

  // rimFactor peaks at limb (viewDot → 0), tight power for a thin bright ring
  const haloRim      = TSL.pow(TSL.oneMinus(viewDot), TSL.float(4.5));
  // Deep electric blue, high opacity at the rim
  const haloColor    = TSL.vec3(0.12, 0.45, 1.0);
  const haloAlpha    = TSL.mul(haloRim, TSL.float(0.9));
  haloMat.colorNode  = TSL.vec4(TSL.mul(haloColor, haloRim), haloAlpha);

  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 64), haloMat));

  // --- Inner diffuse haze ---
  const hazeMat = new MeshBasicNodeMaterial({
    side:        THREE.FrontSide,
    transparent: true,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
  });

  // Softer falloff — covers more of the disc, not just the edge
  const hazeRim     = TSL.pow(TSL.oneMinus(viewDot), TSL.float(1.4));
  const hazeColor   = TSL.vec3(0.25, 0.55, 1.0);
  const hazeAlpha   = TSL.mul(hazeRim, TSL.float(0.18));
  hazeMat.colorNode = TSL.vec4(TSL.mul(hazeColor, hazeRim), hazeAlpha);

  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.025, 64, 64), hazeMat));

  /* Loading UI helpers */
  const loadStatus  = document.getElementById("load-status");
  const loadCounter = document.getElementById("load-counter");

  function setStatus(source, done) {
    const el = document.getElementById(`load-src-${source}`);
    if (el) el.classList.toggle("done", done);
  }

  // Phase 1: globe renders immediately; overlay fades in after renderer is ready
  loadingOverlay.classList.add("visible");

  /* Load Data — fetch in parallel, update status as each resolves */
  const [tleSatellites, satcat, ucsLookup] = await Promise.all([
    loadTLE()    .then(r => { setStatus("tle",    true); return r; }),
    loadSatcat() .then(r => { setStatus("satcat", true); return r; }),
    loadUCS()    .then(r => { setStatus("ucs",    true); return r; }),
  ]);

  /* Merge metadata
     Priority: satcat (NORAD-keyed, always current) provides country/orbit/type.
     UCS lookup fills in operator and a richer purpose/type label where available,
     and overrides orbit class and country if satcat has blanks. */
  const MAX_SATELLITES = 2000;

  const activeSatellites = tleSatellites.slice(0, MAX_SATELLITES).map(s => {
    const sc  = satcat[s.noradId]           || {};
    const ucs = ucsLookup(s.noradId, s.name) || {};

    // Country: prefer UCS (more human-readable, e.g. "USA" vs "US")
    // Fall back to satcat, then Unknown
    const country = ucs.country  || sc.country  || "Unknown";

    // Operator: UCS only (satcat doesn't have this)
    const operator = ucs.operator || "Unknown";

    // Type/purpose: UCS has richer labels ("Communications", "Reconnaissance")
    // satcat has "PAYLOAD" / "ROCKET BODY" / "DEBRIS" — useful when UCS is absent
    const type = ucs.type || sc.type || "Unknown";

    // Orbit: UCS class-of-orbit is authoritative when present; satcat-derived otherwise
    const orbit = ucs.orbit || sc.orbit || "Unknown";

    return {
      name: s.name, satrec: s.satrec, noradId: s.noradId,
      metadata: { name: s.name, country, operator, type, orbit }
    };
  });


  let visibleMask    = new Array(activeSatellites.length).fill(true);
  let selectedSatIdx = -1;
  let hoveredSatIdx  = -1;   // satellite hovered from list panel (not globe mouse)

  // Live world-space positions updated every frame — used to position
  // the hover card when hovering a row in the satellite list.
  const satPositions = new Array(activeSatellites.length);

  /* Instanced mesh */
  const satellitesMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.015, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xffaa00 }),
    activeSatellites.length
  );
  scene.add(satellitesMesh);

  /* Highlight mesh — single sphere that follows selected satellite */
  const highlightMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0 })
  );
  scene.add(highlightMesh);

  /* Trails — single shared geometry, starts hidden */
  const trail = createTrailSystem(activeSatellites.length);
  scene.add(trail.lines);
  trail.lines.visible = false;
  window.trailsVisible = false;

  let trailSampleFrame = 0;
  const TRAIL_SAMPLE_EVERY = 3;

  window.addEventListener("toggle-trails", () => {
    window.trailsVisible    = !window.trailsVisible;
    trail.lines.visible     =  window.trailsVisible;
    if (!window.trailsVisible) resetAllTrails(trail);
  });

  const dummy = new THREE.Object3D();

  /* Mouse */
  const mouse = new THREE.Vector2();
  let lastMouseEvent = null;
  window.addEventListener("mousemove", e => {
    mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    lastMouseEvent = e;
  });

  /* Select a satellite by index — used by list panel clicks and raycaster */
  function selectSatellite(idx) {
    selectedSatIdx = idx;
    setSelectedRow(idx);

    const sat  = activeSatellites[idx];
    const meta = sat.metadata;

    // Detail card
    const card    = document.getElementById("satellite-detail-card");
    const content = document.getElementById("detail-content");
    content.innerHTML = `
      <div class="detail-name">${sat.name}</div>
      <div class="detail-row"><span>Country</span><span>${meta.country}</span></div>
      <div class="detail-row"><span>Operator</span><span>${meta.operator}</span></div>
      <div class="detail-row"><span>Type</span><span>${meta.type}</span></div>
      <div class="detail-row"><span>Orbit</span><span>${meta.orbit}</span></div>
    `;
    card.classList.remove("hidden");

    // Highlight ring
    highlightMesh.material.opacity = 1.0;
  }

  document.getElementById("close-detail").addEventListener("click", () => {
    selectedSatIdx = -1;
    setSelectedRow(-1);
    document.getElementById("satellite-detail-card").classList.add("hidden");
    highlightMesh.material.opacity = 0.0;
  });

  /* AI Filter */
  const matches = (catalogValue, filterValue) => {
    if (!filterValue) return true;
    if (!catalogValue || catalogValue === "Unknown") return false;
    const a = catalogValue.toLowerCase();
    const b = filterValue.toLowerCase();
    return a.includes(b) || b.includes(a);
  };

  // Filter chip UI
  const filterChip    = document.getElementById("filter-chip");
  const filterLabel   = document.getElementById("filter-chip-label");
  const filterClearBtn= document.getElementById("filter-chip-clear");

  function applyFilter(filter) {
    for (let i = 0; i < activeSatellites.length; i++) {
      const sat = activeSatellites[i];
      const m   = sat.metadata;
      let visible = true;
      if (filter.country      && !matches(m.country, filter.country))   visible = false;
      if (filter.type         && !matches(m.type,    filter.type))      visible = false;
      if (filter.orbitType    && !matches(m.orbit,   filter.orbitType)) visible = false;
      if (filter.nameContains && !sat.name.toLowerCase().includes(filter.nameContains.toLowerCase())) visible = false;
      visibleMask[i] = visible;
    }
    buildSatelliteList(activeSatellites, visibleMask, selectSatellite, onListHover, onListHoverEnd);
  }

  function clearFilter() {
    visibleMask.fill(true);
    filterChip.classList.add("hidden");
    buildSatelliteList(activeSatellites, visibleMask, selectSatellite, onListHover, onListHoverEnd);
  }

  filterClearBtn.addEventListener("click", clearFilter);

  window.addEventListener("satellite-filter", e => {
    const { filter, label } = e.detail;

    // Check if all fields null (clear command)
    const isReset = !filter.country && !filter.type && !filter.orbitType && !filter.nameContains;
    if (isReset) {
      clearFilter();
      return;
    }

    applyFilter(filter);

    // Show chip with Claude-provided label
    filterLabel.textContent = label || "Filter active";
    filterChip.classList.remove("hidden");
  });

  /* Panel collapse toggle */
  const panel        = document.getElementById("sat-list-panel");
  const collapseBtn  = document.getElementById("sat-list-collapse");
  collapseBtn.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    collapseBtn.textContent = panel.classList.contains("collapsed") ? "▶" : "◀";
    collapseBtn.title       = panel.classList.contains("collapsed") ? "Expand panel" : "Collapse panel";
  });

  /* List hover — show hover card projected to globe position */
  const hover = document.getElementById("satellite-hover-card");

  function onListHover(idx, rowEl) {
    hoveredSatIdx = idx;
    // If we have a current world position for this satellite, project it to screen
    const pos = satPositions[idx];
    if (pos) {
      const projected = pos.clone().project(camera);
      const x = ( projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
      // Only show if satellite is in front of camera (z < 1)
      if (projected.z < 1) {
        hover.innerText  = activeSatellites[idx].name;
        hover.style.left = (x + 12) + "px";
        hover.style.top  = (y - 10) + "px";
        hover.classList.remove("hidden");
        return;
      }
    }
    hover.classList.add("hidden");
  }

  function onListHoverEnd() {
    hoveredSatIdx = -1;
    // Only hide if not currently shown by globe raycaster
    hover.classList.add("hidden");
    // Restore highlight to selected only
    if (selectedSatIdx === -1) {
      highlightMesh.material.opacity = 0.0;
    }
  }

  /* Gradual satellite reveal — add to scene in batches so they
     appear progressively rather than all popping in at once.
     The loading overlay fades out when the first batch is placed. */
  const BATCH_SIZE = 100;
  const BATCH_DELAY_MS = 20;
  let satellitesReady = false;

  async function revealSatellites() {
    for (let start = 0; start < activeSatellites.length; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, activeSatellites.length);
      for (let i = start; i < end; i++) visibleRevealMask[i] = true;

      const pct = Math.round((end / activeSatellites.length) * 100);
      loadCounter.textContent = `${end.toLocaleString()} / ${activeSatellites.length.toLocaleString()} satellites`;

      // After first batch — fade out overlay, fade in UI
      if (start === 0) {
        loadingOverlay.classList.add("fading");
        setTimeout(() => {
          loadingOverlay.classList.remove("visible", "fading");
          // Fade in all UI panels
          document.getElementById("ui-overlay").classList.remove("ui-hidden");
          document.getElementById("ui-overlay").classList.add("visible");
          document.getElementById("sat-list-panel").classList.remove("ui-hidden");
          document.getElementById("sat-list-panel").classList.add("visible");
          document.getElementById("time-bar").classList.remove("ui-hidden");
          document.getElementById("time-bar").classList.add("visible");
        }, 600);
      }

      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
    satellitesReady = true;
  }

  // Reveal mask — satellites only rendered once revealed
  const visibleRevealMask = new Array(activeSatellites.length).fill(false);
  revealSatellites();

  /* Build initial list */
  buildSatelliteList(activeSatellites, visibleMask, selectSatellite, onListHover, onListHoverEnd);

  /* Earth rotation */
  const EARTH_ROT_RATE_MS = (2 * Math.PI) / 86164100;
  const J2000_MS          = Date.UTC(2000, 0, 1, 12, 0, 0);

  let frameCount = 0;

  let lastWallMs = performance.now();

  const raycaster = new THREE.Raycaster();

  /* Animation loop */
  renderer.setAnimationLoop(() => {
    const wallNow   = performance.now();
    const wallDelta = wallNow - lastWallMs;
    lastWallMs = wallNow;

    controls.update();
    const simDelta = simState.step(wallDelta);

    const isRewind = simState.speed < 0 && !simState.paused;
    if (simState.needsTrailReset || isRewind) {
      resetAllTrails(trail);
      simState.needsTrailReset = false;
    }

    const now        = new Date(simState.time);
    const earthAngle = (simState.time - J2000_MS) * EARTH_ROT_RATE_MS;
    earth.rotation.y     = earthAngle;
    cloudMesh.rotation.y = earthAngle * 1.0008;

    frameCount++;
    trailSampleFrame++;

    for (let i = 0; i < activeSatellites.length; i++) {
      const pv = satellite.propagate(activeSatellites[i].satrec, now);
      if (!pv.position) continue;

      const pos = satToVector(pv.position);

      /* Trail — accumulate position into ring buffer */
      if (window.trailsVisible && !isRewind) {
        if (trailSampleFrame % TRAIL_SAMPLE_EVERY === 0) {
          pushTrailPoint(trail, i, pos);
        }
      }

      /* Store world-space position for list-hover use */
      satPositions[i] = pos.clone();

      /* Satellite dot — only show once revealed during load sequence */
      const s = (visibleMask[i] && visibleRevealMask[i]) ? 1 : 0;
      dummy.scale.set(s, s, s);
      dummy.position.copy(pos);
      dummy.updateMatrix();
      satellitesMesh.setMatrixAt(i, dummy.matrix);

      /* Move highlight to selected or hovered satellite */
      if (i === selectedSatIdx) {
        highlightMesh.position.copy(pos);
        highlightMesh.material.color.setHex(0xffffff);
        highlightMesh.material.opacity = 1.0;
      } else if (i === hoveredSatIdx) {
        highlightMesh.position.copy(pos);
        highlightMesh.material.color.setHex(0x88ccff);
        highlightMesh.material.opacity = 0.7;
      }
    }

    satellitesMesh.instanceMatrix.needsUpdate = true;

    /* Flush trail geometry to GPU once per sample frame */
    if (window.trailsVisible && trailSampleFrame % TRAIL_SAMPLE_EVERY === 0) {
      flushTrails(trail);
    }

    /* Hover card */
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(satellitesMesh);
    const hover = document.getElementById("satellite-hover-card");
    if (intersects.length > 0 && lastMouseEvent) {
      const id = intersects[0].instanceId;
      if (visibleMask[id]) {
        hover.innerText  = activeSatellites[id].name;
        hover.style.left = lastMouseEvent.clientX + 10 + "px";
        hover.style.top  = lastMouseEvent.clientY + 10 + "px";
        hover.classList.remove("hidden");
      } else {
        hover.classList.add("hidden");
      }
    } else {
      hover.classList.add("hidden");
    }

    /* Click to select */
    window.addEventListener("click-select", e => {
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(satellitesMesh);
      if (hits.length > 0 && visibleMask[hits[0].instanceId]) {
        selectSatellite(hits[0].instanceId);
      }
    }, { once: true });

    /* Broadcast sim state */
    window.dispatchEvent(new CustomEvent("sim-time-update", {
      detail: {
        time: simState.time, speed: simState.speed,
        paused: simState.paused, isLive: simState.isLive,
        trailsVisible: window.trailsVisible
      }
    }));

    renderer.render(scene, camera);
  });

  /* Click on globe to select satellite */
  renderer.domElement.addEventListener("click", () => {
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(satellitesMesh);
    if (hits.length > 0 && visibleMask[hits[0].instanceId]) {
      selectSatellite(hits[0].instanceId);
    }
  });

  /* Resize */
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

init();
