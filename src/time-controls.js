/**
 * time-controls.js
 * Handles the bottom time-control bar UI.
 * Reads / writes simState imported from main.js.
 */

import { simState } from "./main.js";

/* --------------------------------------------------
  DOM refs
-------------------------------------------------- */

const bar          = document.getElementById("time-bar");
const clockEl      = document.getElementById("sim-clock");
const dateEl       = document.getElementById("sim-date");
const liveIndicator= document.getElementById("live-indicator");
const playPauseBtn = document.getElementById("play-pause-btn");
const nowBtn       = document.getElementById("now-btn");
const scrubber     = document.getElementById("time-scrubber");
const utcToggle    = document.getElementById("utc-toggle");

const speedBtns    = document.querySelectorAll(".speed-btn");

/* --------------------------------------------------
  State
-------------------------------------------------- */

let showUTC = true;               // UTC vs local time display
let scrubbing = false;            // user is dragging the scrubber
const SCRUB_RANGE_MS = 30 * 24 * 60 * 60 * 1000; // ±30 days window

/* --------------------------------------------------
  Speed buttons
-------------------------------------------------- */

// speed multipliers — positive = forward, negative = rewind
// Data stored on each button via data-speed attribute in HTML
speedBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const s = parseFloat(btn.dataset.speed);
    simState.setSpeed(s);
    updateSpeedHighlight(s);
  });
});

function updateSpeedHighlight(speed) {
  speedBtns.forEach(btn => {
    const match = parseFloat(btn.dataset.speed) === speed;
    btn.classList.toggle("active", match && !simState.paused);
  });
}

/* --------------------------------------------------
  Play / Pause
-------------------------------------------------- */

playPauseBtn.addEventListener("click", () => {
  if (simState.paused) {
    simState.play();
  } else {
    simState.pause();
  }
  updatePlayPause();
});

function updatePlayPause() {
  playPauseBtn.textContent = simState.paused ? "▶" : "⏸";
  playPauseBtn.title       = simState.paused ? "Play" : "Pause";
}

/* --------------------------------------------------
  Jump to Now
-------------------------------------------------- */

nowBtn.addEventListener("click", () => {
  simState.jumpToNow();
  scrubber.value = 50; // center = "now"
  updatePlayPause();
  updateSpeedHighlight(1);
});

/* --------------------------------------------------
  Scrubber
  Center (50) = "now" when user starts dragging.
  We capture the start time and offset from there.
-------------------------------------------------- */

let scrubBaseTime = 0;

scrubber.addEventListener("mousedown", () => {
  scrubbing = true;
  scrubBaseTime = simState.time;
  simState.pause();
  updatePlayPause();
});

scrubber.addEventListener("input", () => {
  if (!scrubbing) return;
  // Map 0–100 to ±SCRUB_RANGE_MS around scrubBaseTime
  const frac = (scrubber.value - 50) / 50; // -1 to +1
  simState.time = scrubBaseTime + frac * SCRUB_RANGE_MS;
});

scrubber.addEventListener("mouseup",    endScrub);
scrubber.addEventListener("mouseleave", endScrub);
function endScrub() {
  scrubbing = false;
}

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
  const d = showUTC ? new Date(ms) : new Date(ms);
  const h = showUTC ? d.getUTCHours()   : d.getHours();
  const m = showUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = showUTC ? d.getUTCSeconds() : d.getSeconds();
  return `${PAD(h)}:${PAD(m)}:${PAD(s)}`;
}

function formatDate(ms) {
  const d = showUTC ? new Date(ms) : new Date(ms);
  if (showUTC) {
    return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth()+1)}-${PAD(d.getUTCDate())}`;
  } else {
    return `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;
  }
}

function speedLabel(s) {
  const abs = Math.abs(s);
  const dir = s < 0 ? "−" : "+";
  if (abs >= 1000) return `${dir}${abs/1000}K×`;
  return `${dir}${abs}×`;
}

/* --------------------------------------------------
  sim-time-update listener (fired by main.js each frame)
-------------------------------------------------- */

window.addEventListener("sim-time-update", e => {
  const { time, speed, paused, isLive } = e.detail;

  // Clock & date
  clockEl.textContent = formatClock(time);
  dateEl.textContent  = formatDate(time);

  // LIVE pill
  if (isLive) {
    liveIndicator.classList.add("live");
    liveIndicator.textContent = "● LIVE";
  } else {
    liveIndicator.classList.remove("live");
    liveIndicator.textContent = speedLabel(speed) + (paused ? " PAUSED" : "");
  }

  // Play/pause icon stays in sync
  updatePlayPause();
  updateSpeedHighlight(speed);
});

/* --------------------------------------------------
  Keyboard shortcuts
  Space     → play / pause
  ← / →     → step −/+ 10 minutes
  [ / ]     → cycle speed backward / forward
  N         → jump to now
  U         → toggle UTC / local
-------------------------------------------------- */

const SPEEDS = [-1000, -100, -10, -1, 1, 10, 100, 1000];
const STEP_MS = 10 * 60 * 1000; // 10 min

window.addEventListener("keydown", e => {
  // Don't steal from text inputs
  if (e.target.tagName === "INPUT") return;

  switch (e.key) {
    case " ":
      e.preventDefault();
      if (simState.paused) simState.play();
      else simState.pause();
      updatePlayPause();
      break;

    case "ArrowLeft":
      simState.pause();
      simState.time -= STEP_MS;
      simState.isLive = false;
      updatePlayPause();
      break;

    case "ArrowRight":
      simState.pause();
      simState.time += STEP_MS;
      simState.isLive = false;
      updatePlayPause();
      break;

    case "[": {
      const idx = SPEEDS.indexOf(simState.speed);
      const next = Math.max(0, idx - 1);
      simState.setSpeed(SPEEDS[next]);
      updateSpeedHighlight(SPEEDS[next]);
      break;
    }

    case "]": {
      const idx = SPEEDS.indexOf(simState.speed);
      const next = Math.min(SPEEDS.length - 1, idx + 1);
      simState.setSpeed(SPEEDS[next]);
      updateSpeedHighlight(SPEEDS[next]);
      break;
    }

    case "n":
    case "N":
      simState.jumpToNow();
      scrubber.value = 50;
      updatePlayPause();
      updateSpeedHighlight(1);
      break;

    case "u":
    case "U":
      showUTC = !showUTC;
      utcToggle.textContent = showUTC ? "UTC" : "LOCAL";
      break;
  }
});
