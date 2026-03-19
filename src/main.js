/**
 * Satellite Visualizer
 * WebGPU + Real Satellite Metadata + AI Filtering + Simulation Time Controls
 */

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as satellite from "satellite.js";
import Papa from "papaparse";

import { currentFilter } from "./search.js";

/* --------------------------------------------------
  Load TLE data
-------------------------------------------------- */

async function loadTLE() {
  const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.trim().split("\n");
  const sats = [];
  for (let i = 0; i < lines.length; i += 3) {
    sats.push({
      name: lines[i].trim(),
      satrec: satellite.twoline2satrec(lines[i + 1].trim(), lines[i + 2].trim())
    });
  }
  return sats;
}

/* --------------------------------------------------
  Load UCS Catalog
-------------------------------------------------- */

// Normalize a satellite name: lowercase, hyphens → spaces,
// non-breaking spaces → spaces, collapse whitespace.
function normalizeSatName(name) {
  return name
    .toLowerCase()
    .replace(/ /g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract every candidate name from a "Name of Satellite, Alternate Names"
// field (e.g. "AEHF-2 (Advanced EHF-2, USA 235)") or a TLE name
// (e.g. "AEHF-2 (USA-235)").
// Returns a Set of all name strings found.
function extractAllNames(field) {
  const names = new Set();
  if (!field) return names;
  const raw = field.replace(/ /g, " ").trim();

  // Primary = everything before the first "("
  const primary = raw.split("(")[0].trim();
  if (primary) names.add(primary);

  // Everything inside each parenthesis group, split by comma
  const parenRe = /\(([^)]+)\)/g;
  let m;
  while ((m = parenRe.exec(raw)) !== null) {
    m[1].split(",").forEach(part => {
      const p = part.trim();
      if (p) names.add(p);
    });
  }

  return names;
}

async function loadCatalog() {
  const response = await fetch("/data/ucs_satellite_catalog.csv");
  const csv = await response.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  // Three lookup tiers (all map normalized strings → entry objects):
  //   exact  — uppercased official name  (fastest, no normalization)
  //   norm   — normalized official name  (handles hyphen/space mismatches)
  //   alts   — normalized form of every alternate name in column 1
  const exact = {};
  const norm  = {};
  const alts  = {};

  parsed.data.forEach(row => {
    const rawName = row["Current Official Name of Satellite"];
    if (!rawName) return;
    const name = rawName.replace(/ /g, " ").trim();
    if (!name) return;

    const entry = {
      name,
      country:  (row["Country of Operator/Owner"] || "").trim(),
      operator: (row["Operator/Owner"]             || "").trim(),
      type:     (row["Purpose"]                    || "").trim(),
      orbit:    (row["Class of Orbit"]             || "").trim()
    };

    exact[name.toUpperCase()]    = entry;
    norm[normalizeSatName(name)] = entry;

    // Index every alternate name from column 1
    const altField = row["Name of Satellite, Alternate Names"] || "";
    extractAllNames(altField).forEach(n => {
      const key = normalizeSatName(n);
      if (key && !alts[key]) alts[key] = entry; // first-write wins
    });
    // Also index the official name in alts for completeness
    const officialKey = normalizeSatName(name);
    if (officialKey && !alts[officialKey]) alts[officialKey] = entry;
  });

  // lookup(tleName) — tries all three tiers in order, also splitting
  // the TLE name on parentheses (e.g. "AEHF-2 (USA-235)" → try "AEHF-2"
  // and "USA-235" separately).
  function lookup(tleName) {
    // Tier 1: exact uppercase match
    const upper = tleName.trim().toUpperCase();
    if (exact[upper]) return exact[upper];

    // Tier 2: normalized match (hyphen/space tolerance)
    const n = normalizeSatName(tleName);
    if (norm[n]) return norm[n];

    // Tier 3: extract all name variants from the TLE name string and
    // check each one against the alts index.
    // e.g. "AEHF-2 (USA-235)" → try "aehf 2" and "usa 235"
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
  Trail System
-------------------------------------------------- */

const TRAIL_LENGTH = 80;

function createTrailSystem(count) {
  const positions = new Float32Array(count * TRAIL_LENGTH * 3);
  const colors    = new Float32Array(count * TRAIL_LENGTH * 4);
  const geometry  = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color",    new THREE.BufferAttribute(colors,    4));

  const indices = [];
  for (let i = 0; i < count; i++) {
    const base = i * TRAIL_LENGTH;
    for (let j = 0; j < TRAIL_LENGTH - 1; j++) indices.push(base + j, base + j + 1);
  }
  geometry.setIndex(indices);

  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
  return { lines, positions, colors, geometry };
}

function resetAllTrails(trailBuffers, trail, count) {
  for (let i = 0; i < count; i++) {
    const tb = trailBuffers[i];
    tb.head = 0; tb.filled = 0;
    const base = i * TRAIL_LENGTH * 3, cbase = i * TRAIL_LENGTH * 4;
    for (let j = 0; j < TRAIL_LENGTH; j++) {
      trail.positions[base + j*3] = trail.positions[base + j*3+1] = trail.positions[base + j*3+2] = 0;
      trail.colors[cbase + j*4] = trail.colors[cbase + j*4+1] = trail.colors[cbase + j*4+2] = trail.colors[cbase + j*4+3] = 0;
    }
  }
  trail.geometry.attributes.position.needsUpdate = true;
  trail.geometry.attributes.color.needsUpdate    = true;
}

const TRAIL_COLOR = { r: 0.3, g: 0.7, b: 1.0 };
const TRAIL_MAX_ALPHA = 0.55;

function writeTrailColors(colors, base, filled) {
  for (let j = 0; j < TRAIL_LENGTH; j++) {
    const alpha = j < filled ? (j / (filled - 1 || 1)) * TRAIL_MAX_ALPHA : 0;
    colors[base + j*4]   = TRAIL_COLOR.r;
    colors[base + j*4+1] = TRAIL_COLOR.g;
    colors[base + j*4+2] = TRAIL_COLOR.b;
    colors[base + j*4+3] = alpha;
  }
}

/* --------------------------------------------------
  Satellite List Panel
-------------------------------------------------- */

function buildSatelliteList(activeSatellites, visibleMask, onSelect) {
  const panel      = document.getElementById("sat-list-panel");
  const countEl    = document.getElementById("sat-list-count");
  const listEl     = document.getElementById("sat-list-items");

  // Build sorted index of currently visible satellites
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
    row.title       = `${s.metadata.country} · ${s.metadata.type} · ${s.metadata.orbit}`;
    row.addEventListener("click", () => onSelect(i));
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

  /* Starfield */
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(100, 64, 64),
    new THREE.MeshBasicMaterial({ map: stars, side: THREE.BackSide })
  ));

  /* Earth */
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshStandardMaterial({
      map: earthDay, emissiveMap: earthNight,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.6
    })
  );
  scene.add(earth);

  /* Clouds */
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.01, 64, 64),
    new THREE.MeshStandardMaterial({ map: clouds, transparent: true, opacity: 0.8 })
  );
  scene.add(cloudMesh);

  /* Atmosphere */
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 64, 64),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        void main(){
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec3 vNormal;
        void main(){
          float intensity = pow(0.6 - dot(vNormal, vec3(0,0,1.0)), 2.0);
          gl_FragColor = vec4(0.3,0.6,1.0,1.0) * intensity;
        }`,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true
    })
  ));

  /* Load Data */
  const tleSatellites = await loadTLE();
  const lookup = await loadCatalog();
  loadingOverlay.style.display = "none";

  /* Merge metadata */
  const MAX_SATELLITES   = 2000;

  const activeSatellites = tleSatellites.slice(0, MAX_SATELLITES).map(s => {
    const meta = lookup(s.name) || {};
    return {
      name: s.name, satrec: s.satrec,
      metadata: {
        name:     s.name,
        country:  meta.country  || "Unknown",
        operator: meta.operator || "Unknown",
        type:     meta.type     || "Unknown",
        orbit:    meta.orbit    || "Unknown"
      }
    };
  });


  let visibleMask    = new Array(activeSatellites.length).fill(true);
  let selectedSatIdx = -1;

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

  /* Trails */
  const trail        = createTrailSystem(activeSatellites.length);
  scene.add(trail.lines);

  const trailBuffers = Array.from({ length: activeSatellites.length }, () => ({
    buf: Array.from({ length: TRAIL_LENGTH }, () => new THREE.Vector3()),
    head: 0, filled: 0
  }));
  resetAllTrails(trailBuffers, trail, activeSatellites.length);

  window.trailsVisible = true;
  window.addEventListener("toggle-trails", () => {
    window.trailsVisible    = !window.trailsVisible;
    trail.lines.visible     =  window.trailsVisible;
    if (window.trailsVisible) resetAllTrails(trailBuffers, trail, activeSatellites.length);
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
    buildSatelliteList(activeSatellites, visibleMask, selectSatellite);
  }

  function clearFilter() {
    visibleMask.fill(true);
    filterChip.classList.add("hidden");
    buildSatelliteList(activeSatellites, visibleMask, selectSatellite);
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

  /* Build initial list */
  buildSatelliteList(activeSatellites, visibleMask, selectSatellite);

  /* Earth rotation */
  const EARTH_ROT_RATE_MS = (2 * Math.PI) / 86164100;
  const J2000_MS          = Date.UTC(2000, 0, 1, 12, 0, 0);

  let frameCount = 0;
  const TRAIL_SAMPLE_EVERY  = 3;
  const TRAIL_RESET_JUMP_MS = 5 * 60 * 1000;

  let lastWallMs = performance.now();

  const raycaster = new THREE.Raycaster();

  /* Animation loop */
  renderer.setAnimationLoop(() => {
    const wallNow   = performance.now();
    const wallDelta = wallNow - lastWallMs;
    lastWallMs = wallNow;

    controls.update();
    const simDelta = simState.step(wallDelta);

    const isRewind   = simState.speed < 0 && !simState.paused;
    const isJump     = Math.abs(simDelta) > TRAIL_RESET_JUMP_MS;
    const needsReset = simState.needsTrailReset || isJump || isRewind;

    if (needsReset) {
      resetAllTrails(trailBuffers, trail, activeSatellites.length);
      simState.needsTrailReset = false;
    }

    const now        = new Date(simState.time);
    const earthAngle = (simState.time - J2000_MS) * EARTH_ROT_RATE_MS;
    earth.rotation.y     = earthAngle;
    cloudMesh.rotation.y = earthAngle * 1.0008;

    frameCount++;
    const sampleTrail = !isRewind && (frameCount % TRAIL_SAMPLE_EVERY === 0);

    for (let i = 0; i < activeSatellites.length; i++) {
      const pv = satellite.propagate(activeSatellites[i].satrec, now);
      if (!pv.position) continue;

      const pos = satToVector(pv.position);

      /* Trails */
      if (window.trailsVisible && sampleTrail && !needsReset) {
        const tb = trailBuffers[i];
        tb.buf[tb.head].copy(pos);
        tb.head = (tb.head + 1) % TRAIL_LENGTH;
        if (tb.filled < TRAIL_LENGTH) tb.filled++;
      }

      if (window.trailsVisible) {
        const tb    = trailBuffers[i];
        const base  = i * TRAIL_LENGTH * 3;
        const cbase = i * TRAIL_LENGTH * 4;
        const start = (tb.head - tb.filled + TRAIL_LENGTH) % TRAIL_LENGTH;
        for (let j = 0; j < TRAIL_LENGTH; j++) {
          const idx = (start + j) % TRAIL_LENGTH;
          trail.positions[base + j*3]   = tb.buf[idx].x;
          trail.positions[base + j*3+1] = tb.buf[idx].y;
          trail.positions[base + j*3+2] = tb.buf[idx].z;
        }
        writeTrailColors(trail.colors, cbase, tb.filled);
      }

      /* Satellite dot */
      const s = visibleMask[i] ? 1 : 0;
      dummy.scale.set(s, s, s);
      dummy.position.copy(pos);
      dummy.updateMatrix();
      satellitesMesh.setMatrixAt(i, dummy.matrix);

      /* Move highlight to selected satellite */
      if (i === selectedSatIdx) {
        highlightMesh.position.copy(pos);
      }
    }

    satellitesMesh.instanceMatrix.needsUpdate      = true;
    trail.geometry.attributes.position.needsUpdate = true;
    trail.geometry.attributes.color.needsUpdate    = true;

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
