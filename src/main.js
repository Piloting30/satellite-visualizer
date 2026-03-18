/**
Satellite Visualizer
WebGPU + Real Satellite Metadata + AI Filtering + Simulation Time Controls
*/

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import * as satellite from "satellite.js";
import Papa from "papaparse";

import { currentFilter } from "./search.js";

/* --------------------------------------------------
Load TLE satellite orbital elements
-------------------------------------------------- */

async function loadTLE() {
  const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.trim().split("\n");
  const sats = [];

  for (let i = 0; i < lines.length; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1].trim();
    const line2 = lines[i + 2].trim();
    sats.push({ name, satrec: satellite.twoline2satrec(line1, line2) });
  }

  return sats;
}

/* --------------------------------------------------
Load UCS Satellite Metadata Catalog
-------------------------------------------------- */

async function loadCatalog() {
  const response = await fetch("/data/ucs_satellite_catalog.csv");
  const csv = await response.text();
  const parsed = Papa.parse(csv, { header: true });
  const catalog = {};

  parsed.data.forEach(row => {
    const name = row["Current Official Name of Satellite"];
    if (!name) return;
    catalog[name.toUpperCase()] = {
      name,
      country: row["Country of Operator/Owner"],
      operator: row["Operator/Owner"],
      type: row["Purpose"],
      orbit: row["Class of Orbit"]
    };
  });

  return catalog;
}

/* --------------------------------------------------
Convert ECI coords -> Three.js coords
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
Simulation Time State — exported so time-controls.js
can read and mutate it directly.
-------------------------------------------------- */

export const simState = {
  time: Date.now(),   // current simulation ms
  speed: 1,           // multiplier (negative = rewind)
  paused: false,
  isLive: true,

  pause()  { this.paused = true;  this.isLive = false; },
  play()   { this.paused = false; },

  jumpToNow() {
    this.time   = Date.now();
    this.paused = false;
    this.isLive = true;
    this.speed  = 1;
  },

  setSpeed(s) {
    this.speed  = s;
    this.isLive = false;
    if (this.paused) this.paused = false;
  },

  // Called once per animation frame with real elapsed wall ms
  step(wallDeltaMs) {
    if (this.paused) return;
    if (this.isLive) {
      this.time = Date.now();
    } else {
      this.time += wallDeltaMs * this.speed;
    }
  }
};

/* --------------------------------------------------
Satellite Trails
-------------------------------------------------- */

const TRAIL_LENGTH = 80;

function createTrailSystem(count) {
  const positions = new Float32Array(count * TRAIL_LENGTH * 3);
  const geometry  = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const indices = [];
  for (let i = 0; i < count; i++) {
    const base = i * TRAIL_LENGTH;
    for (let j = 0; j < TRAIL_LENGTH - 1; j++) {
      indices.push(base + j, base + j + 1);
    }
  }
  geometry.setIndex(indices);

  const material = new THREE.LineBasicMaterial({
    color: 0x00aaff,
    transparent: true,
    opacity: 0.2,
  });

  const lines = new THREE.LineSegments(geometry, material);
  return { lines, positions, geometry };
}

/* --------------------------------------------------
Main App
-------------------------------------------------- */

async function init() {
  if (!navigator.gpu) {
    document.body.innerHTML = "WebGPU not supported in this browser.";
    return;
  }

  const scene = new THREE.Scene();
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
  const loader = new THREE.TextureLoader();
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
      map: earthDay,
      emissiveMap: earthNight,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.6
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
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true
    })
  ));

  /* Load Data */
  console.log("Loading TLE data...");
  const tleSatellites = await loadTLE();

  console.log("Loading satellite catalog...");
  const catalog = await loadCatalog();

  loadingOverlay.style.display = "none";

  /* Merge metadata */
  const satellites = tleSatellites.map(s => {
    const meta = catalog[s.name.toUpperCase()] || {};
    return {
      name: s.name,
      satrec: s.satrec,
      metadata: {
        name: s.name,
        country: meta.country || "Unknown",
        operator: meta.operator || "Unknown",
        type: meta.type || "Unknown",
        orbit: meta.orbit || "Unknown"
      }
    };
  });

  const MAX_SATELLITES = 2000;
  const activeSatellites = satellites.slice(0, MAX_SATELLITES);
  let visibleMask = new Array(activeSatellites.length).fill(true);

  /* Instanced Mesh */
  const satelliteGeometry = new THREE.SphereGeometry(0.015, 6, 6);
  const satelliteMaterial = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  const satellitesMesh = new THREE.InstancedMesh(satelliteGeometry, satelliteMaterial, activeSatellites.length);
  scene.add(satellitesMesh);

  /* Trails */
  const trail = createTrailSystem(activeSatellites.length);
  scene.add(trail.lines);

  // Per-satellite ring buffers
  const trailBuffers = Array.from({ length: activeSatellites.length }, () => ({
    buf: Array.from({ length: TRAIL_LENGTH }, () => new THREE.Vector3()),
    head: 0,
    filled: 0
  }));

  const dummy = new THREE.Object3D();

  /* Mouse */
  const mouse = new THREE.Vector2();
  let lastMouseEvent = null;
  window.addEventListener("mousemove", e => {
    mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    lastMouseEvent = e;
  });

  /* AI Filter */
  window.addEventListener("satellite-filter", e => {
    const filter = e.detail;
    for (let i = 0; i < activeSatellites.length; i++) {
      const sat = activeSatellites[i];
      let visible = true;
      if (filter.country      && sat.metadata.country !== filter.country) visible = false;
      if (filter.type         && sat.metadata.type    !== filter.type)    visible = false;
      if (filter.nameContains && !sat.name.toLowerCase().includes(filter.nameContains.toLowerCase())) visible = false;
      visibleMask[i] = visible;
    }
  });

  /* Earth rotation constants (GMST-based approximation) */
  // Earth rotates 360° every sidereal day (86164.1 s)
  const EARTH_ROT_RATE_MS = (2 * Math.PI) / (86164100); // rad/ms
  const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);      // reference epoch

  /* Trail sampling — every N frames */
  let frameCount = 0;
  const TRAIL_SAMPLE_EVERY = 3;

  /* Wall clock */
  let lastWallMs = performance.now();

  /* Raycaster */
  const raycaster = new THREE.Raycaster();

  /* Animation loop */
  renderer.setAnimationLoop(() => {
    const wallNow = performance.now();
    const wallDelta = wallNow - lastWallMs;
    lastWallMs = wallNow;

    controls.update();
    simState.step(wallDelta);

    const now = new Date(simState.time);

    // Earth rotation driven entirely by simulation time
    const earthAngle = (simState.time - J2000_MS) * EARTH_ROT_RATE_MS;
    earth.rotation.y     = earthAngle;
    cloudMesh.rotation.y = earthAngle * 1.0008; // clouds drift slightly

    frameCount++;
    const sampleTrail = frameCount % TRAIL_SAMPLE_EVERY === 0;

    for (let i = 0; i < activeSatellites.length; i++) {
      const pv = satellite.propagate(activeSatellites[i].satrec, now);
      if (!pv.position) continue;

      const pos = satToVector(pv.position);

      // Trail sample
      if (sampleTrail) {
        const tb = trailBuffers[i];
        tb.buf[tb.head].copy(pos);
        tb.head = (tb.head + 1) % TRAIL_LENGTH;
        if (tb.filled < TRAIL_LENGTH) tb.filled++;
      }

      // Write trail to geometry buffer in chronological order
      {
        const tb = trailBuffers[i];
        const base  = i * TRAIL_LENGTH * 3;
        const start = (tb.head - tb.filled + TRAIL_LENGTH) % TRAIL_LENGTH;
        for (let j = 0; j < TRAIL_LENGTH; j++) {
          const idx = (start + j) % TRAIL_LENGTH;
          trail.positions[base + j * 3]     = tb.buf[idx].x;
          trail.positions[base + j * 3 + 1] = tb.buf[idx].y;
          trail.positions[base + j * 3 + 2] = tb.buf[idx].z;
        }
      }

      // Satellite dot
      dummy.scale.set(visibleMask[i] ? 1 : 0, visibleMask[i] ? 1 : 0, visibleMask[i] ? 1 : 0);
      dummy.position.copy(pos);
      dummy.updateMatrix();
      satellitesMesh.setMatrixAt(i, dummy.matrix);
    }

    satellitesMesh.instanceMatrix.needsUpdate = true;
    trail.geometry.attributes.position.needsUpdate = true;

    /* Hover card */
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(satellitesMesh);
    const hover = document.getElementById("satellite-hover-card");

    if (intersects.length > 0 && lastMouseEvent) {
      const id = intersects[0].instanceId;
      if (visibleMask[id]) {
        hover.innerText      = activeSatellites[id].name;
        hover.style.left     = lastMouseEvent.clientX + 10 + "px";
        hover.style.top      = lastMouseEvent.clientY + 10 + "px";
        hover.classList.remove("hidden");
      }
    } else {
      hover.classList.add("hidden");
    }

    /* Broadcast sim time for time controls UI */
    window.dispatchEvent(new CustomEvent("sim-time-update", {
      detail: {
        time:    simState.time,
        speed:   simState.speed,
        paused:  simState.paused,
        isLive:  simState.isLive
      }
    }));

    renderer.render(scene, camera);
  });

  /* Resize */
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

init();
