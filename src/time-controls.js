/**
 * time-controls.js
 * Bottom time-control bar UI.
 * Reads / writes simState from main.js.
 */

import { simState } from "./main.js";

/* --------------------------------------------------
  DOM refs
-------------------------------------------------- */

const clockEl       = document.getElementById("sim-clock");
const dateEl        = document.getElementById("sim-date");
const offsetEl      = document.getElementById("sim-offset");
const liveIndicator = document.getElementById("live-indicator");
const playPauseBtn  = document.getElementById("play-pause-btn");
const stepBackBtn   = document.getElementById("step-back-btn");
const stepFwdBtn    = document.getElementById("step-fwd-btn");
const nowBtn        = document.getElementById("now-btn");
const trailToggleBtn= document.getElementById("trail-toggle-btn");
const utcToggle     = document.getElementById("utc-toggle");
const speedBtns     = document.querySelectorAll(".speed-btn");

/* --------------------------------------------------
  Local state
-------------------------------------------------- */

let showUTC = true;
const STEP_MS = 10 * 60 * 1000; // 10 minutes per step button press

/* --------------------------------------------------
  Speed buttons
-------------------------------------------------- */

speedBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const s = parseFloat(btn.dataset.speed);
    simState.setSpeed(s);
    updateSpeedHighlight(s);
  });
});

function updateSpeedHighlight(speed) {
  speedBtns.forEach(btn => {
    btn.classList.toggle("active", parseFloat(btn.dataset.speed) === speed && !simState.paused);
  });
}

/* --------------------------------------------------
  Play / Pause
-------------------------------------------------- */

playPauseBtn.addEventListener("click", togglePlayPause);

function togglePlayPause() {
  if (simState.paused) simState.play();
  else                 simState.pause();
  updatePlayPause();
}

function updatePlayPause() {
  playPauseBtn.textContent = simState.paused ? "▶" : "⏸";
  playPauseBtn.title       = simState.paused ? "Play" : "Pause";
}

/* --------------------------------------------------
  Step buttons (±10 minutes, pauses first)
-------------------------------------------------- */

stepBackBtn.addEventListener("click", () => {
  simState.pause();
  simState.time   -= STEP_MS;
  simState.isLive  = false;
  // Large step backward — flag trail reset in main
  simState.needsTrailReset = true;
  updatePlayPause();
});

stepFwdBtn.addEventListener("click", () => {
  simState.pause();
  simState.time   += STEP_MS;
  simState.isLive  = false;
  simState.needsTrailReset = true;
  updatePlayPause();
});

/* --------------------------------------------------
  Jump to Now
-------------------------------------------------- */

nowBtn.addEventListener("click", () => {
  simState.jumpToNow();
  updatePlayPause();
  updateSpeedHighlight(1);
});

/* --------------------------------------------------
  Trail Toggle
-------------------------------------------------- */

trailToggleBtn.addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("toggle-trails"));
});

/* --------------------------------------------------
  UTC / Local Toggle
-------------------------------------------------- */

utcToggle.addEventListener("click", () => {
  showUTC = !showUTC;
  utcToggle.textContent = showUTC ? "UTC" : "LOCAL";
  utcToggle.title       = showUTC ? "Switch to local time" : "Switch to UTC";
});

/* --------------------------------------------------
  Format helpers
-------------------------------------------------- */

const PAD = n => String(n).padStart(2, "0");

function formatClock(ms) {
  const d = new Date(ms);
  const h = showUTC ? d.getUTCHours()   : d.getHours();
  const m = showUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = showUTC ? d.getUTCSeconds() : d.getSeconds();
  return `${PAD(h)}:${PAD(m)}:${PAD(s)}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  if (showUTC) {
    return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth()+1)}-${PAD(d.getUTCDate())}`;
  }
  return `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;
}

function formatOffset(ms) {
  const diffMs  = ms - Date.now();
  const absDiff = Math.abs(diffMs);
  const past    = diffMs < 0;

  if (absDiff < 60_000) return ""; // within a minute → don't show

  const days  = Math.floor(absDiff / 86_400_000);
  const hours = Math.floor((absDiff % 86_400_000) / 3_600_000);
  const mins  = Math.floor((absDiff % 3_600_000)  / 60_000);

  let parts = [];
  if (days)  parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins && !days) parts.push(`${mins}m`); // skip minutes if days shown

  const label = parts.join(" ");
  return past ? `${label} ago` : `+${label}`;
}

function speedLabel(s) {
  const abs = Math.abs(s);
  const dir = s < 0 ? "−" : "+";
  if (abs >= 1000) return `${dir}${abs / 1000}K×`;
  return `${dir}${abs}×`;
}

/* --------------------------------------------------
  sim-time-update listener (fired by main.js each frame)
-------------------------------------------------- */

window.addEventListener("sim-time-update", e => {
  const { time, speed, paused, isLive, trailsVisible } = e.detail;

  clockEl.textContent = formatClock(time);
  dateEl.textContent  = formatDate(time);

  const offset = formatOffset(time);
  offsetEl.textContent = offset;
  offsetEl.style.display = (!isLive && offset) ? "inline" : "none";

  if (isLive) {
    liveIndicator.classList.add("live");
    liveIndicator.textContent = "● LIVE";
  } else {
    liveIndicator.classList.remove("live");
    liveIndicator.textContent = speedLabel(speed) + (paused ? " PAUSED" : "");
  }

  updatePlayPause();
  updateSpeedHighlight(speed);

  // Trail toggle button label
  trailToggleBtn.textContent = trailsVisible ? "Trails: ON" : "Trails: OFF";
  trailToggleBtn.classList.toggle("trail-off", !trailsVisible);
});

/* --------------------------------------------------
  Keyboard shortcuts
  Space     → play / pause
  ← / →     → step −/+ 10 minutes
  [ / ]     → cycle speed
  N         → jump to now
  U         → toggle UTC / local
  T         → toggle trails
-------------------------------------------------- */

const SPEEDS = [-1000, -100, -10, -1, 1, 10, 100, 1000];

window.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;

  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlayPause();
      break;

    case "ArrowLeft":
      stepBackBtn.click();
      break;

    case "ArrowRight":
      stepFwdBtn.click();
      break;

    case "[": {
      const idx = SPEEDS.indexOf(simState.speed);
      const s   = SPEEDS[Math.max(0, idx - 1)];
      simState.setSpeed(s);
      updateSpeedHighlight(s);
      break;
    }

    case "]": {
      const idx = SPEEDS.indexOf(simState.speed);
      const s   = SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)];
      simState.setSpeed(s);
      updateSpeedHighlight(s);
      break;
    }

    case "n":
    case "N":
      nowBtn.click();
      break;

    case "u":
    case "U":
      utcToggle.click();
      break;

    case "t":
    case "T":
      trailToggleBtn.click();
      break;
  }
});
