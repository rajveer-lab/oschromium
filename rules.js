// Rules shared by the service worker and the popup: which tabs count toward
// the limit, which may sleep, and what the limit is right now.

export const CALL_SITES = [
  "https://meet.google.com/*",
  "https://*.zoom.us/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.webex.com/*",
  "https://app.slack.com/*",
  "https://discord.com/*",
  "https://whereby.com/*",
];
export const CARBON_ORIGIN = "https://api.electricitymap.org/*";

// Phone handoff: the phone's automation app publishes to a private topic on
// this relay (ntfy), and the extension pauses video on these sites.
export const PHONE_RELAY = "https://ntfy.sh";
export const VIDEO_SITES = ["youtube.com"];
export const PHONE_ORIGINS = ["https://ntfy.sh/*", "https://*.youtube.com/*"];
export const PHONE_APP_URL = "https://rajveer-lab.github.io/oschromium/app/";

export const DEFAULT_SETTINGS = {
  maxAwake: 8,
  paused: false,
  protectPinned: true,
  protectTyping: false,
  threshold: 0.5,
  excluded: [],
  graceSeconds: 60,       // a tab opened or switched to this recently never sleeps
  // smart features
  taskFocus: true,        // sleep a whole task when you move on to another one
  taskShiftSeconds: 120,  // ...after this long away from it (and 3 switches)
  tabGroups: false,       // also show tasks as Chrome tab groups
  predictiveWake: false,  // needs the site permission
  away: true,             // stepping away or pausing a video lets tabs sleep sooner
  awayMinutes: 5,
  pausedMinutes: 10,
  handoff: false,         // share what's playing with your other Chrome devices
  phoneHandoff: false,    // pause and sleep YouTube here when it opens on your phone
  phoneTopic: "",         // the private relay topic your phone publishes to
  remote: false,          // the phone app may see and control this browser's tabs
  remoteId: "",           // pairing with the phone app: relay topic id...
  remoteKey: "",          // ...and the encryption key (both in the QR code)
  green: true,
  carbonKey: "",
  carbonZone: "",
  carbonHigh: 400,        // gCO2eq/kWh
  callMode: false,        // needs permission for the call sites
};

export const REASON = {
  model: "learned model", lru: "LRU fallback", you: "you", chrome: "Chrome",
  task: "task finished", media: "paused video", handoff: "playing on another device",
  call: "call mode", green: "green mode", away: "you were away",
  phone: "playing on your phone", remote: "you, from your phone",
};

const key = (id) => String(id);

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

const onSite = (host, sites) => sites.some((h) => host === h || host.endsWith("." + h));

export function isVideoSite(url) {
  return /^https?:/.test(url || "") && onSite(hostOf(url), VIDEO_SITES);
}

// Only ordinary websites count toward the limit. Chrome's own pages, pinned
// and playing tabs, excluded sites, tabs with unsaved typing and tabs in a
// call never sleep, so counting them would push every website to sleep.
export function counts(tab, s) {
  if (!/^https?:/.test(tab.url || "")) return false;
  if (tab.audible) return false;
  if (tab.pinned && s.settings.protectPinned) return false;
  if (s.dirty && s.dirty[key(tab.id)]) return false;
  if (s.calls && s.calls[key(tab.id)]) return false;
  return !isExcluded(tab.url, s);
}

export function isExcluded(url, s) {
  return onSite(hostOf(url), s.settings.excluded);
}

export function sleepable(tab, s, now = Date.now()) {
  if (tab.active || tab.discarded || tab.status !== "complete") return false;
  const m = s.metas && s.metas[key(tab.id)];
  if (m && m.seen && now - m.seen < 1000 * (s.settings.graceSeconds ?? 60)) return false;
  return counts(tab, s);
}

// --- what the limit is right now ------------------------------------------

const MINUTE = 60 * 1000;

export function greenSignals(s, now = Date.now()) {
  const out = [];
  const p = s.power, cpu = s.cpu, co2 = s.carbon;
  if (p && p.charging === false) out.push(`on battery${p.level != null ? ` ${Math.round(100 * p.level)}%` : ""}`);
  if (cpu && now - cpu.at < 5 * MINUTE && cpu.load >= 0.75) out.push(`CPU busy ${Math.round(100 * cpu.load)}%`);
  if (co2 && co2.g != null && now - co2.at < 120 * MINUTE && co2.g >= s.settings.carbonHigh) out.push(`grid ${Math.round(co2.g)} g CO₂/kWh`);
  return out;
}

export function callActive(s) {
  return !!s.calls && Object.keys(s.calls).length > 0;
}

export function isAway(s) {
  return !!s.idle && s.idle !== "active";
}

// The usual limit, tightened by whichever smart modes apply now.
export function limits(s, now = Date.now()) {
  const base = s.settings.maxAwake;
  let c = base, threshold = s.settings.threshold;
  const modes = [];
  const tighten = (factor, mode, why) => {
    const v = Math.max(2, Math.round(base * factor));
    if (v < c) c = v;
    modes.push({ mode, why });
  };
  if (s.settings.callMode && callActive(s)) tighten(0.5, "call", "you're in a call");
  if (s.settings.away && isAway(s)) tighten(0.5, "away", s.idle === "locked" ? "screen locked" : "you're away");
  if (s.settings.green) {
    const g = greenSignals(s, now);
    if (g.length) {
      tighten(0.75, "green", g.join(", "));
      threshold = Math.max(0.3, threshold - 0.1);
    }
  }
  return { c, base, threshold, modes };
}
