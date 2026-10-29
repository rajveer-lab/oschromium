import { DEFAULT_SETTINGS, CALL_SITES, CARBON_ORIGIN } from "./rules.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const { state } = await chrome.storage.local.get("state");
  const s = { ...DEFAULT_SETTINGS, ...(state && state.settings) };
  $("pinned").checked = s.protectPinned;
  $("typing").checked = s.protectTyping && await chrome.permissions.contains({ origins: ["<all_urls>"] });
  $("thr").value = s.threshold;
  $("thr-out").textContent = Math.round(100 * s.threshold) + "%";
  $("excluded").value = (s.excluded || []).join("\n");
  $("shift").value = Math.round(s.taskShiftSeconds / 6) / 10;
  $("groups").checked = s.tabGroups;
  $("paused").value = s.pausedMinutes;
  $("away").value = s.awayMinutes;
  $("handoff").checked = s.handoff;
  $("ckey").value = s.carbonKey;
  $("zone").value = s.carbonZone;
  $("high").value = s.carbonHigh;
  $("sites").textContent = CALL_SITES.map((p) => p.replace(/^https:\/\/(\*\.)?/, "").replace(/\/\*$/, "")).join(", ");
  if (state && state.carbon) showCarbon(state.carbon);
}

function showCarbon(c) {
  if (!c) { $("cout").textContent = ""; return; }
  $("cout").textContent = c.g != null ? `${c.zone}: ${Math.round(c.g)} g CO₂/kWh right now` : `Couldn't read the grid: ${c.error}`;
}

$("thr").addEventListener("input", (e) => { $("thr-out").textContent = Math.round(100 * e.target.value) + "%"; });

$("typing").addEventListener("change", async (e) => {
  if (e.target.checked) {
    const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
    if (!ok) e.target.checked = false;
  }
});

function collect() {
  const excluded = $("excluded").value.split(/\s+/).map((h) => h.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  const num = (id, fallback) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fallback; };
  return {
    protectPinned: $("pinned").checked, protectTyping: $("typing").checked, threshold: +$("thr").value, excluded,
    taskShiftSeconds: Math.round(60 * num("shift", 2)), tabGroups: $("groups").checked,
    pausedMinutes: num("paused", 10), awayMinutes: num("away", 5), handoff: $("handoff").checked,
    carbonKey: $("ckey").value.trim(), carbonZone: $("zone").value.trim(), carbonHigh: num("high", 400),
  };
}

// Asking for a permission must happen straight from the click.
function askCarbon(settings) {
  return settings.carbonKey ? chrome.permissions.request({ origins: [CARBON_ORIGIN] }).catch(() => false) : Promise.resolve(true);
}

$("save").addEventListener("click", async () => {
  const settings = collect();
  await askCarbon(settings);
  await send({ type: "settings", settings });
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

$("ctest").addEventListener("click", async () => {
  const settings = collect();
  if (!settings.carbonKey || !settings.carbonZone) { $("cout").textContent = "Add your key and zone first."; return; }
  await askCarbon(settings);
  await send({ type: "settings", settings });
  $("cout").textContent = "Checking…";
  const r = await send({ type: "carbon-test" });
  showCarbon(r && r.carbon);
});

$("reset-model").addEventListener("click", async () => { await send({ type: "reset-model" }); $("saved").textContent = "Model reset"; });
$("reset-stats").addEventListener("click", async () => { await send({ type: "reset-stats" }); $("saved").textContent = "Counts reset"; });

load();
