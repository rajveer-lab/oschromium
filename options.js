import { DEFAULT_SETTINGS, CALL_SITES, CARBON_ORIGIN, PHONE_RELAY, PHONE_ORIGINS, PHONE_APP_URL } from "./rules.js";
import { pairingCode } from "./docs/app/link.js";

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
  $("phone").checked = s.phoneHandoff;
  $("purl").value = s.phoneTopic ? `${PHONE_RELAY}/${s.phoneTopic}/trigger` : "Turn it on and save to get your link";
  showPhone(state && state.phone && state.phone.last);
  $("remote").checked = s.remote;
  showPairing(s, state && state.phone);
  $("ckey").value = s.carbonKey;
  $("zone").value = s.carbonZone;
  $("high").value = s.carbonHigh;
  $("sites").textContent = CALL_SITES.map((p) => p.replace(/^https:\/\/(\*\.)?/, "").replace(/\/\*$/, "")).join(", ");
  if (state && state.carbon) showCarbon(state.carbon);
}

function showPhone(last) {
  if (!last) { $("pout").textContent = ""; return; }
  const what = last.paused ? `paused ${last.paused} video${last.paused > 1 ? "s" : ""}, ${last.slept} put to sleep` : "nothing was playing";
  $("pout").textContent = `Last signal${last.test ? " (test)" : ""} at ${new Date(last.at).toLocaleTimeString()}: ${what}.`;
}

let appLink = "";

function showPairing(s, phone) {
  $("pair").hidden = !(s.remote && s.remoteKey);
  if ($("pair").hidden) return;
  appLink = PHONE_APP_URL + "#p=" + pairingCode({ id: s.remoteId, key: s.remoteKey }, PHONE_RELAY);
  const q = qrcode(0, "M");
  q.addData(appLink);
  q.make();
  const n = q.getModuleCount(), c = $("qr"), g = c.getContext("2d"), cell = Math.floor(c.width / (n + 8)), off = Math.floor((c.width - cell * n) / 2);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect(off + col * cell, off + r * cell, cell, cell);
  $("rout").textContent = phone && phone.app ? `Phone app last seen at ${new Date(phone.app).toLocaleTimeString()}.` : "";
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
    pausedMinutes: num("paused", 10), awayMinutes: num("away", 5), handoff: $("handoff").checked, phoneHandoff: $("phone").checked, remote: $("remote").checked,
    carbonKey: $("ckey").value.trim(), carbonZone: $("zone").value.trim(), carbonHigh: num("high", 400),
  };
}

// Asking for a permission must happen straight from the click, in one request.
function askPermissions(settings) {
  const origins = [...(settings.carbonKey ? [CARBON_ORIGIN] : []), ...(settings.phoneHandoff || settings.remote ? PHONE_ORIGINS : [])];
  return origins.length ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(true);
}

$("save").addEventListener("click", async () => {
  const settings = collect();
  await askPermissions(settings);
  await send({ type: "settings", settings });
  await load();
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

$("ctest").addEventListener("click", async () => {
  const settings = collect();
  if (!settings.carbonKey || !settings.carbonZone) { $("cout").textContent = "Add your key and zone first."; return; }
  await askPermissions(settings);
  await send({ type: "settings", settings });
  $("cout").textContent = "Checking…";
  const r = await send({ type: "carbon-test" });
  showCarbon(r && r.carbon);
});

$("pcopy").addEventListener("click", async () => {
  if (!$("purl").value.startsWith("http")) return;
  await navigator.clipboard.writeText($("purl").value).catch(() => $("purl").select());
  $("pout").textContent = "Link copied.";
});

$("ptest").addEventListener("click", async () => {
  if (!$("phone").checked) { $("pout").textContent = "Tick the box above first."; return; }
  await chrome.permissions.request({ origins: PHONE_ORIGINS }).catch(() => false);
  await send({ type: "settings", settings: { phoneHandoff: true } });
  await load();
  $("pout").textContent = "Sending…";
  const r = await send({ type: "phone-test" });
  if (!r || !r.ok) { $("pout").textContent = (r && r.error) || "Couldn't send the test signal."; return; }
  $("pout").textContent = "Sent. Any YouTube video playing in this browser pauses within a few seconds.";
  setTimeout(async () => { const { state } = await chrome.storage.local.get("state"); if (state && state.phone && state.phone.last && state.phone.last.test) showPhone(state.phone.last); }, 6000);
});

$("pnew").addEventListener("click", async () => {
  const r = await send({ type: "phone-new-topic" });
  if (r && r.topic) $("purl").value = `${PHONE_RELAY}/${r.topic}/trigger`;
  $("pout").textContent = "New link made: put it in MacroDroid in place of the old one.";
});

$("remote").addEventListener("change", async (e) => {
  if (e.target.checked && !(await chrome.permissions.request({ origins: PHONE_ORIGINS }).catch(() => false))) {
    e.target.checked = false;
    $("rout").textContent = "The phone app needs that permission to reach your phone.";
    return;
  }
  await send({ type: "settings", settings: { remote: e.target.checked } });
  await load();
});

$("rcopy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(appLink).catch(() => {});
  $("rout").textContent = "Link copied. Open it on your phone to connect.";
});

$("runpair").addEventListener("click", async () => {
  if (!confirm("Disconnect every phone? Scan the new QR code to connect again.")) return;
  await send({ type: "remote-unpair" });
  await load();
  $("rout").textContent = "All phones disconnected. Scan the new QR code to connect again.";
});

$("reset-model").addEventListener("click", async () => { await send({ type: "reset-model" }); $("saved").textContent = "Model reset"; });
$("reset-stats").addEventListener("click", async () => { await send({ type: "reset-stats" }); $("saved").textContent = "Counts reset"; });

load();
