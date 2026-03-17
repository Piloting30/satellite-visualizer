/**
 * Satellite Visualizer
 *
 * WebGPU + Three.js
 * Real satellite positions using satellite.js (SGP4)
 */

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
// import { WebGPURenderer } from "three/addons/renderers/WebGPURenderer.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as satellite from "satellite.js";

/* --------------------------------------------------
   Fetch TLE satellite data from CelesTrak
-------------------------------------------------- */

async function loadTLE() {

  const url =
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";

  const response = await fetch(url);

  const text = await response.text();

  const lines = text.trim().split("\n");

  const satellites = [];

  for (let i = 0; i < lines.length; i += 3) {

    const name = lines[i].trim();
    const line1 = lines[i + 1].trim();
    const line2 = lines[i + 2].trim();

    satellites.push({
      name,
      satrec: satellite.twoline2satrec(line1, line2)
    });

  }

  return satellites;

}

/* --------------------------------------------------
   Convert satellite ECI position -> Three.js coords
-------------------------------------------------- */

function satToVector(position) {

  // Earth radius ~6371km
  const scale = 1 / 6371;

  return new THREE.Vector3(
    position.x * scale,
    position.z * scale,
    -position.y * scale
  );

}

/* --------------------------------------------------
   Main Initialization
-------------------------------------------------- */

async function init() {

  if (!navigator.gpu) {
    document.body.innerHTML = "WebGPU not supported in this browser.";
    return;
  }

  /* ---------------- Scene ---------------- */

  const scene = new THREE.Scene();

  /* ---------------- Camera ---------------- */

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  camera.position.set(0, 1.5, 4);

  /* ---------------- Renderer (WebGPU) ---------------- */

  const renderer = new WebGPURenderer({ antialias: true });

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  document.body.appendChild(renderer.domElement);

  await renderer.init();

  /* ---------------- Controls ---------------- */

  const controls = new OrbitControls(camera, renderer.domElement);

  controls.enableDamping = true;
  controls.minDistance = 2;
  controls.maxDistance = 20;

  /* ---------------- Lighting ---------------- */

  const sunLight = new THREE.DirectionalLight(0xffffff, 2);
  sunLight.position.set(5, 2, 5);
  scene.add(sunLight);

  const ambientLight = new THREE.AmbientLight(0x222222);
  scene.add(ambientLight);

  /* ---------------- Textures ---------------- */

  const loader = new THREE.TextureLoader();

  const earthDay = loader.load("/textures/earth_atmos_2048.jpg");
  const earthNight = loader.load("/textures/earth_lights_2048.png");
  const clouds = loader.load("/textures/earth_clouds_1024.png");
  const stars = loader.load("/textures/starfield.jpg");

  /* ---------------- Starfield ---------------- */

  const starGeometry = new THREE.SphereGeometry(100, 64, 64);

  const starMaterial = new THREE.MeshBasicMaterial({
    map: stars,
    side: THREE.BackSide
  });

  const starSphere = new THREE.Mesh(starGeometry, starMaterial);

  scene.add(starSphere);

  /* ---------------- Earth ---------------- */

  const earthGeometry = new THREE.SphereGeometry(1, 64, 64);

  const earthMaterial = new THREE.MeshStandardMaterial({
    map: earthDay,
    emissiveMap: earthNight,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.6
  });

  const earth = new THREE.Mesh(earthGeometry, earthMaterial);

  scene.add(earth);

  /* ---------------- Clouds ---------------- */

  const cloudGeometry = new THREE.SphereGeometry(1.01, 64, 64);

  const cloudMaterial = new THREE.MeshStandardMaterial({
    map: clouds,
    transparent: true,
    opacity: 0.8,
    depthWrite: false
  });

  const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);

  scene.add(cloudMesh);

  /* ---------------- Atmosphere Glow ---------------- */

  const atmosphereGeometry = new THREE.SphereGeometry(1.1, 64, 64);

  const atmosphereMaterial = new THREE.ShaderMaterial({

    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix *
                      modelViewMatrix *
                      vec4(position,1.0);
      }
    `,

    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        float intensity =
          pow(0.6 - dot(vNormal, vec3(0,0,1.0)), 2.0);

        gl_FragColor =
          vec4(0.3,0.6,1.0,1.0) * intensity;
      }
    `,

    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    transparent: true

  });

  const atmosphere = new THREE.Mesh(
    atmosphereGeometry,
    atmosphereMaterial
  );

  scene.add(atmosphere);

  /* ---------------- Load Satellites ---------------- */

  console.log("Loading satellite TLE data...");

  const tleSatellites = await loadTLE();

  console.log("Satellites loaded:", tleSatellites.length);

  // Limit for performance while developing
  const MAX_SATELLITES = 2000;

  const activeSatellites = tleSatellites.slice(0, MAX_SATELLITES);

  /* ---------------- Satellite Mesh ---------------- */

  const satelliteGeometry = new THREE.SphereGeometry(0.015, 6, 6);

  const satelliteMaterial = new THREE.MeshBasicMaterial({
    color: 0xffaa00
  });

  const satellitesMesh = new THREE.InstancedMesh(
    satelliteGeometry,
    satelliteMaterial,
    activeSatellites.length
  );

  scene.add(satellitesMesh);

  const dummy = new THREE.Object3D();

  /* ---------------- Time Control ---------------- */

  let simulationTime = Date.now();

  /* ---------------- Resize Handling ---------------- */

  window.addEventListener("resize", () => {

    camera.aspect =
      window.innerWidth / window.innerHeight;

    camera.updateProjectionMatrix();

    renderer.setSize(
      window.innerWidth,
      window.innerHeight
    );

  });

  /* ---------------- Animation Loop ---------------- */

  renderer.setAnimationLoop(() => {

    controls.update();

    // advance simulation time
    simulationTime += 1000 * 10;

    const now = new Date(simulationTime);

    /* ----- Earth rotation ----- */

    earth.rotation.y += 0.0006;

    cloudMesh.rotation.y += 0.0008;

    /* ----- Update satellite positions ----- */

    for (let i = 0; i < activeSatellites.length; i++) {

      const satrec = activeSatellites[i].satrec;

      const positionAndVelocity =
        satellite.propagate(satrec, now);

      const positionEci =
        positionAndVelocity.position;

      if (!positionEci) continue;

      const pos = satToVector(positionEci);

      dummy.position.copy(pos);

      dummy.updateMatrix();

      satellitesMesh.setMatrixAt(i, dummy.matrix);

    }

    satellitesMesh.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);

  });

}

/* --------------------------------------------------
   Start App
-------------------------------------------------- */

init();