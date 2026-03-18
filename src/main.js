/**
Satellite Visualizer
WebGPU + Real Satellite Metadata + AI Filtering
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

  const url =
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";

  const response = await fetch(url);

  const text = await response.text();

  const lines = text.trim().split("\n");

  const sats = [];

  for (let i = 0; i < lines.length; i += 3) {

    const name = lines[i].trim();
    const line1 = lines[i + 1].trim();
    const line2 = lines[i + 2].trim();

    sats.push({
      name,
      satrec: satellite.twoline2satrec(line1, line2)
    });

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

      name: name,
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
Main App
-------------------------------------------------- */

async function init() {

  if (!navigator.gpu) {

    document.body.innerHTML =
      "WebGPU not supported in this browser.";

    return;

  }

  /* Scene */

  const scene = new THREE.Scene();

  const loadingOverlay = document.getElementById("loading-overlay");

  /* Camera */

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

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

  const ambient = new THREE.AmbientLight(0x222222);
  scene.add(ambient);

  /* Textures */

  const loader = new THREE.TextureLoader();

  const earthDay = loader.load("/textures/earth_atmos_2048.jpg");
  const earthNight = loader.load("/textures/earth_lights_2048.png");
  const clouds = loader.load("/textures/earth_clouds_1024.png");
  const stars = loader.load("/textures/starfield.jpg");

  /* Starfield */

  const starSphere = new THREE.Mesh(
    new THREE.SphereGeometry(100, 64, 64),
    new THREE.MeshBasicMaterial({
      map: stars,
      side: THREE.BackSide
    })
  );

  scene.add(starSphere);

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
    new THREE.MeshStandardMaterial({
      map: clouds,
      transparent: true,
      opacity: 0.8
    })
  );

  scene.add(cloudMesh);

  /* Atmosphere */

  const atmosphere = new THREE.Mesh(

    new THREE.SphereGeometry(1.1, 64, 64),

    new THREE.ShaderMaterial({

      vertexShader: `
      varying vec3 vNormal;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        gl_Position =
        projectionMatrix *
        modelViewMatrix *
        vec4(position,1.0);
      }`,

      fragmentShader: `
      varying vec3 vNormal;
      void main(){
        float intensity =
        pow(0.6 - dot(vNormal, vec3(0,0,1.0)),2.0);
        gl_FragColor =
        vec4(0.3,0.6,1.0,1.0) * intensity;
      }`,

      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true

    })

  );

  scene.add(atmosphere);

  /* Load Data */

  console.log("Loading TLE data...");
  const tleSatellites = await loadTLE();

  console.log("Loading satellite catalog...");
  const catalog = await loadCatalog();

  loadingOverlay.style.display = "none";
  
  /* Merge metadata */

  const satellites = tleSatellites.map(s => {

    const meta =
      catalog[s.name.toUpperCase()] || {};

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

  /* Limit for dev */

  const MAX_SATELLITES = 2000;

  const activeSatellites =
    satellites.slice(0, MAX_SATELLITES);

  let visibleMask =
    new Array(activeSatellites.length).fill(true);

  /* Instanced Mesh */

  const satelliteGeometry =
    new THREE.SphereGeometry(0.015, 6, 6);

  const satelliteMaterial =
    new THREE.MeshBasicMaterial({ color: 0xffaa00 });

  const satellitesMesh =
    new THREE.InstancedMesh(
      satelliteGeometry,
      satelliteMaterial,
      activeSatellites.length
    );

  scene.add(satellitesMesh);

  const dummy = new THREE.Object3D();

  /* Raycasting */

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  window.addEventListener("mousemove", e => {

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  });

  /* AI Filter Listener */

  window.addEventListener("satellite-filter", e => {

    const filter = e.detail;

    for (let i = 0; i < activeSatellites.length; i++) {

      const sat = activeSatellites[i];

      let visible = true;

      if (filter.country &&
        sat.metadata.country !== filter.country)
        visible = false;

      if (filter.type &&
        sat.metadata.type !== filter.type)
        visible = false;

      if (filter.nameContains &&
        !sat.name.toLowerCase()
          .includes(filter.nameContains.toLowerCase()))
        visible = false;

      visibleMask[i] = visible;

    }

  });

  /* Time */

  let simulationTime = Date.now();

  /* Animation */

  renderer.setAnimationLoop(() => {

    controls.update();

    simulationTime += 10000;

    const now = new Date(simulationTime);

    earth.rotation.y += 0.0006;
    cloudMesh.rotation.y += 0.0008;

    for (let i = 0; i < activeSatellites.length; i++) {

      const satrec = activeSatellites[i].satrec;

      const pv = satellite.propagate(satrec, now);

      if (!pv.position) continue;

      const pos = satToVector(pv.position);

      if (!visibleMask[i])
        dummy.scale.set(0, 0, 0);
      else
        dummy.scale.set(1, 1, 1);

      dummy.position.copy(pos);

      dummy.updateMatrix();

      satellitesMesh.setMatrixAt(i, dummy.matrix);

    }

    satellitesMesh.instanceMatrix.needsUpdate = true;

    /* Hover detection */

    raycaster.setFromCamera(mouse, camera);

    const intersects =
      raycaster.intersectObject(satellitesMesh);

    const hover =
      document.getElementById("satellite-hover-card");

    if (intersects.length > 0) {

      const id = intersects[0].instanceId;

      if (visibleMask[id]) {

        hover.innerText =
          activeSatellites[id].name;

        hover.style.left =
          event.clientX + 10 + "px";

        hover.style.top =
          event.clientY + 10 + "px";

        hover.classList.remove("hidden");

      }

    } else {

      hover.classList.add("hidden");

    }

    renderer.render(scene, camera);

  });

}

init();