import { clusterTabs } from "./tasks.js";
import { limits } from "./rules.js";
const SITE = "http://127.0.0.1:8813/";
const post = (o) => fetch("http://127.0.0.1:8812/log", { method: "POST", body: JSON.stringify(o) }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => chrome.runtime.sendMessage(m);
const st = async () => (await chrome.storage.local.get("state")).state;
const out = document.getElementById("out");
const log = (...a) => { out.textContent += a.join(" ") + "\n"; post({ log: a.join(" ") }); };
let fails = 0, passes = 0;
function check(name, cond, detail) {
  cond ? passes++ : fails++;
  log(cond ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}
let win;
const ids = {};
async function waitLoaded(id) {
  for (let i = 0; i < 150; i++) { const t = await chrome.tabs.get(id); if (t.status === "complete" && !t.discarded) return t; await sleep(100); }
  return chrome.tabs.get(id);
}
async function open(name, url) {
  const t = await chrome.tabs.create({ windowId: win, url: url || SITE + name + ".html", active: true });
  ids[name] = t.id;
  await waitLoaded(t.id);
  await sleep(250);
  return t.id;
}
async function activate(name) {
  await chrome.tabs.update(ids[name], { active: true });
  await waitLoaded(ids[name]);
  await sleep(250);
}
async function tabsNow() { return chrome.tabs.query({}); }
const isWeb = (t) => /^https?:/.test(t.url || "");
async function awakeWeb() {
  const s = await st();
  return (await tabsNow()).filter((t) => isWeb(t) && !t.discarded && !t.audible && !(s.calls || {})[String(t.id)]).length;
}
async function discarded(name) { return (await chrome.tabs.get(ids[name])).discarded; }
async function run(fn, ...args) { const [r] = await chrome.scripting.executeScript({ target: { tabId: ids[args[0]] }, world: "MAIN", func: fn, args: args.slice(1) }); return r && r.result; }
async function settings(o) { const r = await send({ type: "settings", settings: o }); await sleep(300); return r; }
async function hashOf(url) {
  const u = new URL(url); let id = u.origin + u.pathname; const v = u.searchParams.get("v"); if (v) id += "?v=" + v;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function phase(name, fn) {
  log("== " + name);
  try { await fn(); } catch (e) { fails++; log("FAIL", name, "threw", String(e && e.stack || e)); }
}

(async () => {
  await sleep(1500);
  await settings({ maxAwake: 4, graceSeconds: 1, taskShiftSeconds: 10, callMode: false, predictiveWake: false, away: false, handoff: false, tabGroups: false, green: true, awayMinutes: 30 });
  const w = await chrome.windows.create({ url: SITE + "flights.html", focused: true, width: 1000, height: 700, left: 420, top: 0 });
  win = w.id; ids.flights = w.tabs[0].id; await waitLoaded(ids.flights);

  await phase("limit and task detection", async () => {
    for (const n of ["hotels", "trip", "course", "notes", "quiz", "python", "cricket"]) await open(n);
    await sleep(1500); await send({ type: "enforce" }); await sleep(500);
    const a = await awakeWeb();
    check("at most 4 websites awake", a <= 4, a);
    const web = (await tabsNow()).filter(isWeb);
    const tasks = clusterTabs(web.map((t) => ({ id: t.id, title: t.title, url: t.url, openerTabId: t.openerTabId })));
    const name = (id) => Object.keys(ids).find((k) => ids[k] === id);
    const named = tasks.map((t) => ({ label: t.label, tabs: t.ids.map(name).sort() }));
    check("travel task found", named.some((t) => JSON.stringify(t.tabs) === JSON.stringify(["flights", "hotels", "trip"])), named);
    check("study task found", named.some((t) => JSON.stringify(t.tabs) === JSON.stringify(["course", "notes", "quiz"])), named);
  });

  await phase("task focus: leaving a task sleeps it together", async () => {
    await settings({ maxAwake: 9 });
    for (const n of ["flights", "hotels", "trip", "flights"]) await activate(n);
    for (const n of ["course", "notes", "quiz", "course"]) await activate(n);
    let s = await st();
    check("leaving travel is noticed", s.task.left && s.task.left.label.startsWith("Travel"), s.task.left);
    await sleep(10500);
    await activate("notes");
    await sleep(1600); await send({ type: "enforce" }); await sleep(500);
    s = await st();
    const asleep = await Promise.all(["flights", "hotels", "trip"].map(discarded));
    check("all three travel tabs asleep", asleep.every(Boolean), asleep);
    const by = ["flights", "hotels", "trip"].map((n) => (s.asleep[String(ids[n])] || {}).by);
    check("put to sleep as a task", by.every((b) => b === "task"), by);
    check("study tabs still awake", !(await discarded("course")) && !(await discarded("notes")) && !(await discarded("quiz")));
    await activate("hotels");
    s = await st();
    check("coming back to the task cancels the shelf", s.task.shelves.length === 0, s.task.shelves);
  });

  await phase("predictive wake", async () => {
    await settings({ maxAwake: 4, predictiveWake: true, taskFocus: false });
    const reg = await chrome.scripting.getRegisteredContentScripts();
    check("intent script registered", reg.some((r) => r.id === "intent"), reg.map((r) => r.id));
    for (let i = 0; i < 3; i++) { await activate("python"); await activate("cricket"); }
    await activate("python");
    await send({ type: "sleep", tabId: ids.cricket }); await sleep(400);
    check("cricket asleep before", await discarded("cricket"));
    await chrome.tabs.reload(ids.python); await waitLoaded(ids.python); await sleep(500);
    const before = (await st()).stats;
    await run(() => {
      for (let i = 0; i < 6; i++) document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 300 - i * 55, bubbles: true }));
      document.documentElement.dispatchEvent(new MouseEvent("mouseout", { clientX: 300, clientY: 0, relatedTarget: null, bubbles: true }));
      return true;
    }, "python");
    await sleep(1500);
    let s = await st();
    check("heading for the tab bar woke cricket", !(await discarded("cricket")), s.prewoke);
    check("prewake counted", s.stats.prewakes === before.prewakes + 1, s.stats);
    await sleep(1200);
    await activate("cricket");
    s = await st();
    check("switch to woken tab is a hit, not a wait", s.stats.prewakeHits === before.prewakeHits + 1 && s.stats.reloads === before.reloads, s.stats);
    // slow mouse: no wake
    await activate("python");
    await send({ type: "sleep", tabId: ids.cricket }); await sleep(9000);
    await run(() => {
      document.documentElement.dispatchEvent(new MouseEvent("mouseout", { clientX: 300, clientY: 0, relatedTarget: null, bubbles: true }));
      return true;
    }, "python");
    await sleep(1200);
    check("no wake without a fast move", await discarded("cricket"));
    // hover in the popup
    const r = await send({ type: "prewake", tabId: ids.cricket }); await sleep(800);
    check("hover wake from the popup", r.ok && !(await discarded("cricket")), r);
  });

  await phase("call mode", async () => {
    await settings({ maxAwake: 4, callMode: true, predictiveWake: false });
    const reg = (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id);
    check("call scripts registered", reg.includes("call-main") && reg.includes("call-relay"), reg);
    for (const n of ["python", "cricket", "course", "notes"]) await activate(n);
    await sleep(1200); await send({ type: "enforce" }); await sleep(300);
    const before = await awakeWeb();
    await open("call");
    const n = await run(() => window.startCall(), "call");
    check("fake mic+camera started", n === 2, n);
    await sleep(1500);
    let s = await st();
    check("call noticed", !!s.calls[String(ids.call)], s.calls);
    check("limit halved during call", limits(s).c === 2, limits(s));
    await activate("python"); await sleep(1500); await send({ type: "enforce" }); await sleep(400);
    const a = await awakeWeb();
    s = await st();
    check("at most 2 other websites awake in a call", a <= 2, { before, after: a });
    check("some tabs slept because of the call", Object.values(s.asleep).some((x) => x.why === "call"), Object.values(s.asleep).map((x) => x.why || x.by));
    check("the call tab itself stays awake", !(await discarded("call")));
    await run(() => window.endCall(), "call"); await sleep(1500);
    s = await st();
    check("call end noticed", Object.keys(s.calls).length === 0, s.calls);
    check("limit back to 4", limits(s).c === 4, limits(s));
    await settings({ callMode: false });
    await chrome.tabs.remove(ids.call); delete ids.call;
  });

  await phase("green mode", async () => {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    check("battery reader running", ctx.length === 1, ctx.map((c) => c.documentUrl));
    let s = await st();
    log("battery reported by the browser:", JSON.stringify(s.power));
    for (const n of ["python", "cricket", "course", "notes"]) await activate(n);
    await sleep(1200);
    await send({ type: "battery", charging: false, level: 0.42 }); await sleep(600);
    s = await st();
    check("unplugged tightens the limit to 3", limits(s).c === 3 && limits(s).modes[0].why.includes("on battery 42%"), limits(s));
    const a = await awakeWeb();
    check("at most 3 awake on battery", a <= 3, a);
    check("a tab slept for green mode", Object.values(s.asleep).some((x) => x.why === "green"), Object.values(s.asleep).map((x) => x.why || x.by));
    await send({ type: "battery", charging: true, level: 0.43 }); await sleep(400);
    s = await st();
    check("plugged in: limit back to 4", limits(s).c === 4, limits(s));
    await send({ type: "refresh" }); await sleep(1200); await send({ type: "refresh" });
    s = await st();
    check("CPU load measured", s.cpu && s.cpu.load >= 0 && s.cpu.load <= 1, s.cpu);
    await settings({ carbonKey: "test-key", carbonZone: "IN-SO" });
    let r = await send({ type: "carbon-test" });
    check("grid carbon read", r.carbon && r.carbon.g === 650, r);
    s = await st();
    check("high-carbon grid turns green mode on", limits(s).modes.some((m) => m.mode === "green" && m.why.includes("650")), limits(s));
    await settings({ carbonKey: "wrong" });
    r = await send({ type: "carbon-test" });
    check("bad key gives a readable error", r.carbon && r.carbon.g === null && /Invalid auth-token/.test(r.carbon.error), r);
    await settings({ carbonKey: "", carbonZone: "" });
  });

  await phase("handoff", async () => {
    await settings({ handoff: true, away: true, pausedMinutes: 60 });
    await open("tv", SITE + "video.html?v=abc123");
    await activate("python");
    const h = await hashOf(SITE + "video.html?v=abc123&t=42");
    await chrome.storage.sync.set({ nowPlaying: { device: (await st()).deviceId, hash: h, at: Date.now() } }); await sleep(1500);
    check("own device's video is ignored", !(await discarded("tv")));
    await chrome.storage.sync.set({ nowPlaying: { device: "another-laptop", hash: h, at: Date.now() } }); await sleep(1500);
    const s = await st();
    check("video playing on another device sleeps here", await discarded("tv") && s.asleep[String(ids.tv)].by === "handoff", s.asleep[String(ids.tv)]);
  });

  await phase("paused video and away", async () => {
    await open("video");
    const played = await run(() => window.play(), "video");
    await sleep(3000);
    let t = await chrome.tabs.get(ids.video);
    log("audio context:", played, "audible:", t.audible);
    if (!t.audible) { log("SKIP this browser has no audio output, so tabs never become audible here"); return; }
    let s = await st();
    check("playing noticed", !!s.playing[String(ids.video)]);
    check("handoff published what's playing", (await chrome.storage.sync.get("nowPlaying")).nowPlaying.device === s.deviceId);
    await activate("python");
    await run(() => window.pausePlayback(), "video"); await sleep(4000);
    s = await st();
    check("pause noticed", !!s.pausedAt[String(ids.video)], s.pausedAt);
    await settings({ pausedMinutes: 1 });
    await sleep(61000); await send({ type: "enforce" }); await sleep(500);
    s = await st();
    check("paused video slept after a minute", await discarded("video") && s.asleep[String(ids.video)].by === "media", s.asleep[String(ids.video)]);
  });

  await phase("tab groups", async () => {
    await settings({ taskFocus: true, tabGroups: true, maxAwake: 9 });
    await sleep(800);
    let groups = await chrome.tabGroups.query({});
    check("tasks shown as tab groups", groups.some((g) => /^Travel/.test(g.title)) && groups.some((g) => /^Study/.test(g.title)), groups.map((g) => g.title));
    await settings({ tabGroups: false }); await sleep(800);
    groups = await chrome.tabGroups.query({});
    check("turning it off removes our groups", groups.length === 0, groups.map((g) => g.title));
  });

  await phase("away (idle) state", async () => {
    const s = await st();
    log("idle state:", s.idle);
    check("idle state is read", ["active", "idle", "locked"].includes(s.idle), s.idle);
  });

  await phase("popup and settings render", async () => {
    await settings({ predictiveWake: true, callMode: true });
    const errs = [];
    for (const [id, url] of [["pop", "popup.html"], ["opt", "options.html"]]) {
      const f = document.getElementById(id);
      await new Promise((res) => { f.onload = res; f.src = url; });
      f.contentWindow.addEventListener("error", (e) => errs.push(url + ": " + e.message));
      f.contentWindow.addEventListener("unhandledrejection", (e) => errs.push(url + ": " + (e.reason && e.reason.message || e.reason)));
    }
    await sleep(2500);
    const d = document.getElementById("pop").contentDocument;
    check("popup shows 5 smart features", d.querySelectorAll("#features .feat").length === 5, d.querySelectorAll("#features .feat").length);
    check("popup lists tasks", d.querySelectorAll("#tasks li").length >= 1, [...d.querySelectorAll("#tasks li .name")].map((e) => e.textContent));
    check("popup status filled", /^\d+$/.test(d.getElementById("awake").textContent), d.getElementById("awake").textContent);
    const o = document.getElementById("opt").contentDocument;
    check("settings page loaded values", o.getElementById("shift").value !== "" && o.getElementById("sites").textContent.includes("meet.google.com"), o.getElementById("sites").textContent);
    check("no errors in popup or settings", errs.length === 0, errs);
    log("popup features:", [...d.querySelectorAll("#features .feat")].map((e) => e.querySelector("b").textContent + " | " + (e.querySelector(".now") || {}).textContent).join(" || "));
    for (const id of ["pop", "opt"]) { const f = document.getElementById(id); f.style.height = f.contentDocument.documentElement.scrollHeight + "px"; }
    const [me] = await chrome.tabs.query({ url: location.href });
    await chrome.windows.update(me.windowId, { focused: true, width: 1050, height: 2300, top: 0, left: 0 });
    await chrome.tabs.update(me.id, { active: true });
    await sleep(1500);
    const png = await chrome.tabs.captureVisibleTab(me.windowId, { format: "png" });
    await post({ png, name: "popup-settings.png" });
    await settings({ predictiveWake: false, callMode: false });
  });

  log(`DONE ${passes} passed, ${fails} failed`);
  post({ done: true, passes, fails });
})();
