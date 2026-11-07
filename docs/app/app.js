// The Smart Tab Saver phone app: shows the tabs open in your laptop's Chrome
// and sends commands to the extension, sealed with the pairing key (link.js).

import { DEFAULT_RELAY, parsePairing, pairingCode, codeChannel, seal, unseal, toLaptop, toPhone, command } from "./link.js";

const $ = (id) => document.getElementById(id);
const STORE = "sts-pairing";
const HELLO_EVERY = 60 * 1000;          // the laptop keeps sending tab lists for 5 minutes after each hello

let pair = null, state = null, stream = null, helloTimer = null;
const open = new Set();                 // tabs whose actions are showing
const busy = new Map();                 // tab id -> what we asked for, until the next tab list
const links = new Map();                // tab id -> its address, once the laptop sent it

function store(code) {
  try { code ? localStorage.setItem(STORE, code) : localStorage.removeItem(STORE); } catch { /* private mode */ }
}

function stored() {
  try { return localStorage.getItem(STORE); } catch { return null; }
}

function toast(text, ms = 2600) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 10 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : "a while ago";
}

// --- talking to the laptop ---------------------------------------------------

async function send(t, extra = {}) {
  const body = await seal(pair.key, command(t, extra));
  const r = await fetch(`${pair.relay}/${toLaptop(pair)}`, { method: "POST", body });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function textOf(m) {               // the relay turns long messages into attachments
  if (m.attachment && m.attachment.url) return (await fetch(m.attachment.url)).text();
  return m.message || "";
}

async function receive(m) {
  if (!m || m.event !== "message") return;
  const msg = await unseal(pair.key, await textOf(m));
  if (!msg) return;
  if (msg.t === "state" && (!state || msg.at >= state.at)) {
    state = msg;
    busy.clear();
    render();
  }
  if (msg.t === "url") {
    links.set(msg.id, msg.url);
    render();
  }
}

function listen() {
  stream = new EventSource(`${pair.relay}/${toPhone(pair)}/sse`);
  stream.onmessage = (e) => { try { receive(JSON.parse(e.data)); } catch { /* keepalive */ } };
}

// The last tab list sent in the past 10 minutes, so there's something to show at once.
async function lastKnown() {
  try {
    const text = await (await fetch(`${pair.relay}/${toPhone(pair)}/json?poll=1&since=10m`)).text();
    for (const line of text.split("\n")) if (line.trim()) await receive(JSON.parse(line));
  } catch { /* wait for the laptop */ }
}

async function hello() {
  if (document.visibilityState !== "visible") return;
  try { await send("hello"); } catch { $("status").textContent = "Can't reach the internet."; }
  const asked = Date.now();
  setTimeout(() => {
    if (!state || state.at < asked - 60 * 1000) showStatus();
  }, 9000);
}

// --- what you see -------------------------------------------------------------

function showStatus() {
  const s = $("status");
  if (!state) { s.textContent = "Waiting for your laptop. Chrome needs to be open on it; this can take up to 30 seconds."; return; }
  const stale = Date.now() - state.at > 90 * 1000;
  s.textContent = `${state.awake} of ${state.limit} websites awake · ${stale ? "last seen " : "updated "}${ago(Date.now() - state.at)}`;
}

function avatar(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 360;
  const el = document.createElement("span");
  el.className = "av";
  el.style.background = `hsl(${h} 45% 42%)`;
  el.textContent = (host.replace(/^www\./, "")[0] || "?").toUpperCase();
  return el;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, act, cls = "") {
  const b = el("button", cls, label);
  b.type = "button";
  b.dataset.act = act;
  return b;
}

function chipFor(tab) {
  if (busy.has(tab.i)) return el("span", "chip", busy.get(tab.i));
  if (tab.s) return el("span", "chip asleep", "Asleep");
  if (tab.p) return el("span", "chip playing", "Playing");
  if (tab.a) return el("span", "chip", "On screen");
  return el("span", "chip", "Awake");
}

function row(tab) {
  const card = el("div", "tab" + (open.has(tab.i) ? " open" : "") + (busy.has(tab.i) ? " busy" : ""));
  card.dataset.id = tab.i;
  const top = el("div", "top");
  const text = el("div");
  text.append(el("div", "title", tab.t), el("div", "host", tab.h));
  top.append(avatar(tab.h), text, chipFor(tab));
  const acts = el("div", "acts");
  if (tab.s) acts.append(button("Wake", "wake", "primary"));
  else if (!tab.a) acts.append(button("Sleep", "sleep", "primary"));
  if (!tab.s && tab.p) acts.append(button("Pause", "pause"));
  else if (!tab.s && tab.v) acts.append(button("Play", "play"));
  if (links.has(tab.i)) {
    const a = el("a", "", "Open now ↗");
    a.href = links.get(tab.i);
    a.target = "_blank";
    a.rel = "noopener";
    acts.append(a);
  } else acts.append(button("Open on phone", "url"));
  acts.append(button("Close", "close", "danger"));
  card.append(top, acts);
  return card;
}

function render() {
  showStatus();
  const box = $("tabs");
  box.replaceChildren();
  if (!state) return;
  const groups = new Map();
  for (const tab of state.tabs) {
    const k = tab.k >= 0 ? tab.k : -1;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(tab);
  }
  const order = [...groups.keys()].sort((a, b) => (a < 0) - (b < 0) || a - b);
  for (const k of order) {
    box.append(el("h3", "", k >= 0 ? state.tasks[k] : order.length > 1 ? "Other tabs" : "Your tabs"));
    for (const tab of groups.get(k)) box.append(row(tab));
  }
  if (!state.tabs.length) box.append(el("p", "sub", "No websites are open on your laptop."));
}

const DOING = { sleep: "Sleeping…", wake: "Waking…", close: "Closing…", pause: "Pausing…", play: "Playing…", url: "Getting link…" };

$("tabs").addEventListener("click", async (e) => {
  const card = e.target.closest(".tab");
  if (!card) return;
  const id = Number(card.dataset.id), b = e.target.closest("button");
  if (!b) {
    if (!e.target.closest("a")) { open.has(id) ? open.delete(id) : open.add(id); render(); }
    return;
  }
  const act = b.dataset.act;
  if (act === "close" && b.textContent !== "Tap again to close") {
    b.textContent = "Tap again to close";
    setTimeout(() => { if (b.isConnected) b.textContent = "Close"; }, 3000);
    return;
  }
  busy.set(id, DOING[act]);
  render();
  try {
    await send(act, { id });
  } catch {
    busy.delete(id);
    render();
    toast("Couldn't send that. Check your connection.");
  }
});

$("pause-all").addEventListener("click", async () => {
  try {
    await send("pauseAll");
    toast("Pausing YouTube on your laptop…");
  } catch {
    toast("Couldn't send that. Check your connection.");
  }
});

$("unpair").addEventListener("click", () => {
  if (!confirm("Disconnect this phone from your laptop?")) return;
  store(null);
  location.reload();
});

$("copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pairingCode(pair, pair.relay));
    toast("Pairing code copied. Now Share → Add to Home Screen.", 4000);
  } catch {
    toast("Couldn't copy. Select the code from the link on your laptop instead.");
  }
});

// --- connecting ------------------------------------------------------------------

function connect(code) {
  const p = parsePairing(code);
  if (!p) return false;
  store(code.trim());
  pair = p;
  return true;
}

// The short code from the laptop: it leads to the pairing, sealed under a key
// made from the code, waiting on the relay.
const RELAY = new URLSearchParams(location.search).get("relay") || DEFAULT_RELAY;

async function connectWithCode(text) {
  const ch = await codeChannel(text);
  if (!ch) return "The code has 8 letters and numbers, like K7QM-2XPA.";
  for (let tries = 0; tries < 3; tries++) {
    try {
      const body = await (await fetch(`${RELAY}/${ch.topic}/json?poll=1&since=15m`, { cache: "no-store" })).text();
      for (const line of body.split("\n").reverse()) {
        if (!line.trim()) continue;
        const msg = await unseal(ch.key, JSON.parse(line).message || "");
        if (msg && msg.t === "pair" && msg.exp > Date.now() && connect(msg.code)) return null;
      }
    } catch {
      return "Can't reach the internet. Check your connection and try again.";
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "No laptop is showing that code. Check it, or press New code on the laptop.";
}

$("connect-code").addEventListener("click", async () => {
  const b = $("connect-code");
  b.disabled = true;
  b.textContent = "Connecting…";
  $("short-msg").textContent = "";
  const problem = await connectWithCode($("short").value);
  b.disabled = false;
  b.textContent = "Connect";
  if (problem) $("short-msg").textContent = problem;
  else start();
});

$("short").addEventListener("input", (e) => {         // K7QM2XPA -> K7QM-2XPA as you type
  const c = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  e.target.value = c.length > 4 ? c.slice(0, 4) + "-" + c.slice(4) : c;
});

$("paste").addEventListener("click", async () => {
  try { $("code").value = await navigator.clipboard.readText(); } catch { $("code-msg").textContent = "Paste it into the box instead."; }
});

$("connect").addEventListener("click", () => {
  if (connect($("code").value)) start();
  else $("code-msg").textContent = "That isn't a pairing code. It starts with sts-.";
});

function start() {
  $("unpaired").hidden = true;
  $("paired").hidden = false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("ios").hidden = !ios || standalone;
  showStatus();
  listen();
  lastKnown();
  hello();
  clearInterval(helloTimer);
  helloTimer = setInterval(hello, HELLO_EVERY);
  setInterval(showStatus, 5000);
  document.addEventListener("visibilitychange", hello);
}

// The QR code brings the pairing in the address after "#", which never
// leaves the phone; it's kept on the phone and taken out of the address.
const fromLink = new URLSearchParams(location.hash.slice(1)).get("p");
if (fromLink && connect(fromLink)) history.replaceState(null, "", location.pathname + location.search);
else if (!pair && stored()) pair = parsePairing(stored());

if (pair) start();
else {
  $("status").textContent = "Not connected yet";
  $("unpaired").hidden = false;
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
