// Smart Tab Saver service worker.
//
// Keeps at most `maxAwake` tabs loaded. When there are too many, it puts one
// to sleep (chrome.tabs.discard) chosen by the learned policy:
//   1. score every tab that may sleep with P(not needed soon);
//   2. if even the best score is below the threshold, use LRU instead;
//   3. a regret guard weighs the model against LRU: a sleeping tab you come
//      back to soon counts against whichever of the two put it to sleep.
//
// Smart features on top (each can be switched off in the popup):
//   - Task focus: open tabs are grouped into tasks (tasks.js). When you move
//     on from a task for good, its tabs sleep together.
//   - Predictive wake: heading for the tab bar wakes the sleeping tab you
//     are most likely to open next, before you click it.
//   - Away and handoff: a video you paused and left, stepping away from the
//     computer, or the same video playing on another of your Chrome devices
//     lets tabs sleep sooner.
//   - Green mode: on battery, with a busy CPU or a high-carbon power grid,
//     fewer tabs stay awake.
//   - Call mode: during a video call in the browser, fewer tabs stay awake.

import { PRETRAINED, newMeta, touch, features, score, optDataset, fitLogReg, replay } from "./policy.js";
import { DEFAULT_SETTINGS, CALL_SITES, CARBON_ORIGIN, counts, sleepable, limits, isAway } from "./rules.js";
import { clusterTabs } from "./tasks.js";

const LOG_CAP = 5000;
const LEARNING_RATE = 0.45;
const MINUTE = 60 * 1000;
const PER_TAB = ["metas", "asleep", "hModel", "hLRU", "shadow", "dirty", "calls", "prewoke", "playing", "pausedAt"];

let state = null;
let queue = Promise.resolve();
let lastIntent = 0;
let lastPublished = { hash: "", at: 0 };

// Run state-changing work one task at a time so events never interleave.
function serial(fn) {
  queue = queue.then(fn).catch((e) => console.error("Smart Tab Saver:", e));
  return queue;
}

function freshStats() {
  return { reloads: 0, lruReloads: 0, sleeps: 0, modelSleeps: 0, lruSleeps: 0,
    prewakes: 0, prewakeHits: 0, taskSleeps: 0, since: Date.now() };
}

async function load() {
  if (state) return state;
  const got = await chrome.storage.local.get("state");
  state = got.state || {
    clock: 0,
    metas: {},          // tabId -> history of switches to it
    asleep: {},         // tabId -> { by, why, at, title, url }
    hModel: {},         // tabId -> time the model put it to sleep (regret history)
    hLRU: {},           // tabId -> time LRU put it to sleep
    wModel: 0.5,
    shadow: {},         // tabs plain LRU would keep awake -> their last switch time
    dirty: {},          // tabId -> true while the user has typed unsaved text
    log: [],            // tab switch history, for learning
    stats: freshStats(),
    model: PRETRAINED,
    settings: DEFAULT_SETTINGS,
    lastLearn: null,
  };
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  state.stats = { ...freshStats(), ...state.stats };
  for (const k of PER_TAB) if (!state[k] || Array.isArray(state[k])) state[k] = {};
  if (!state.task || !Array.isArray(state.task.shelves)) state.task = { left: null, shelves: [] };
  if (!state.groups) state.groups = {};        // tab group id -> label, for groups we made
  if (!state.deviceId) state.deviceId = crypto.randomUUID();
  return state;
}

async function save() {
  await chrome.storage.local.set({ state });
}

const key = (id) => String(id);
const isWeb = (tb) => /^https?:/.test(tb.url || "");

// --- references: a tab is opened or switched to ---------------------------

function reference(tabId, isNew) {
  const s = state, k = key(tabId), now = Date.now();
  if (s.log.length && s.log[s.log.length - 1] === tabId) {    // same tab again (created, then activated)
    if (s.metas[k]) s.metas[k].seen = now;
    return false;
  }
  s.clock += 1;
  const t = s.clock;

  // A switch to a tab we put to sleep is a reload: the "page fault".
  if (s.asleep[k] && !isNew) {
    s.stats.reloads += 1;
    regret(k, t);
    delete s.asleep[k];
  }
  // A tab we woke early because you were heading for it: no wait for you,
  // but putting it to sleep was still a mistake for the regret guard.
  if (s.prewoke[k]) {
    if (now - s.prewoke[k].at < 10 * MINUTE) s.stats.prewakeHits += 1;
    regret(k, t);
    delete s.prewoke[k];
  }
  // Shadow LRU: the same switches, the same limit and protections, but LRU
  // chooses. A switch to a tab it would have put to sleep counts as its reload.
  if (s.shadow[k] === undefined && !isNew && s.metas[k]) s.stats.lruReloads += 1;
  s.shadow[k] = t;

  if (s.pausedAt[k]) s.pausedAt[k] = now;   // you looked at the paused video again
  if (!s.metas[k]) s.metas[k] = newMeta();
  touch(s.metas[k], t);
  s.metas[k].seen = now;
  s.log.push(tabId);
  if (s.log.length > LOG_CAP) s.log.splice(0, s.log.length - LOG_CAP);
  return true;
}

function regret(k, t) {
  const s = state;
  const d = Math.pow(0.005, 1 / Math.max(1, s.settings.maxAwake));
  for (const [hist, modelWasWrong] of [[s.hModel, true], [s.hLRU, false]]) {
    if (hist[k] !== undefined) {
      const reward = Math.pow(d, t - hist[k]);
      delete hist[k];
      let wm = s.wModel, wl = 1 - s.wModel;
      if (modelWasWrong) wl *= Math.exp(LEARNING_RATE * reward);
      else wm *= Math.exp(LEARNING_RATE * reward);
      s.wModel = Math.min(0.98, Math.max(0.02, wm / (wm + wl)));
      return;
    }
  }
}

function awake(tab) {
  return !tab.discarded && tab.status !== "unloaded";
}

// --- task focus ------------------------------------------------------------

function taskClusters(tabs) {
  return clusterTabs(tabs.filter(isWeb).map((tb) => ({ id: tb.id, title: tb.title, url: tb.url, openerTabId: tb.openerTabId })));
}

// Called after every switch. Leaving a task starts a countdown; coming back
// to it cancels it. Three switches and taskShiftSeconds away from it later,
// the task is shelved: its tabs sleep together, as soon as each may.
function trackTask(tabId, tasks) {
  const s = state, t = s.task, now = Date.now();
  const cur = tasks.find((c) => c.ids.includes(tabId));
  const inIt = (ids) => ids.includes(tabId) || (cur && cur.ids.some((id) => ids.includes(id)));
  t.shelves = t.shelves.filter((sh) => !inIt(sh.ids));          // back on a shelved task
  if (t.left) {
    if (inIt(t.left.ids)) t.left = null;
    else t.left.switches += 1;
  } else {
    const prev = s.log.length >= 2 ? s.log[s.log.length - 2] : null;
    const was = prev === null ? null : tasks.find((c) => c.ids.includes(prev));
    if (was && !inIt(was.ids)) t.left = { ids: was.ids.slice(), label: was.label, at: now, switches: 1 };
  }
  checkShift(now);
}

function checkShift(now) {
  const t = state.task;
  if (t.left && t.left.switches >= 3 && now - t.left.at >= 1000 * state.settings.taskShiftSeconds) {
    t.shelves.push({ ids: t.left.ids, label: t.left.label, at: now });
    if (t.shelves.length > 5) t.shelves.shift();
    t.left = null;
  }
}

// --- enforcement -----------------------------------------------------------

async function enforce(tabs, tasks) {
  const s = state;
  if (s.settings.paused) return;
  tabs = tabs || await chrome.tabs.query({});
  const now = Date.now(), L = limits(s, now), slept = new Set();
  const lastRef = s.log[s.log.length - 1];

  // Sleeps that don't wait for the limit: a finished task, a paused video.
  if (s.settings.taskFocus) {
    checkShift(now);
    for (const sh of s.task.shelves) {
      for (const tb of tabs) {
        if (sh.ids.includes(tb.id) && tb.id !== lastRef && sleepable(tb, s, now) && await sleepTab(tb, "task")) {
          slept.add(tb.id);
          s.stats.taskSleeps += 1;
        }
      }
      const open = new Set(tabs.filter((tb) => !tb.discarded && !slept.has(tb.id)).map((tb) => tb.id));
      sh.ids = sh.ids.filter((id) => open.has(id));
    }
    s.task.shelves = s.task.shelves.filter((sh) => sh.ids.length);
  } else {
    s.task = { left: null, shelves: [] };
  }
  if (s.settings.away) {
    const wait = isAway(s) ? 0 : s.settings.pausedMinutes * MINUTE;
    for (const tb of tabs) {
      const p = s.pausedAt[key(tb.id)];
      if (p && now - p >= wait && !slept.has(tb.id) && sleepable(tb, s, now) && await sleepTab(tb, "media")) slept.add(tb.id);
    }
  }

  // The limit. Tabs from the task you are on are the last to go.
  const live = tabs.filter((tb) => !slept.has(tb.id));
  let awakeCount = live.filter((tb) => awake(tb) && counts(tb, s)).length;
  const candidates = live.filter((tb) => sleepable(tb, s, now));
  if (!tasks && s.settings.taskFocus && awakeCount > L.c) tasks = taskClusters(tabs);
  const cur = s.settings.taskFocus && tasks ? tasks.find((c) => c.ids.includes(lastRef)) : null;
  while (awakeCount > L.c && candidates.length) {
    const pool = cur ? candidates.filter((tb) => !cur.ids.includes(tb.id)) : candidates;
    const { tab, by } = pickVictim(pool.length ? pool : candidates, L.threshold);
    candidates.splice(candidates.indexOf(tab), 1);
    // over the usual limit it's the usual rule; under it, a smart mode asked
    const why = awakeCount > L.base ? null : (L.modes[0] ? L.modes[0].mode : null);
    if (await sleepTab(tab, by, why)) awakeCount -= 1;
  }
  shadowEnforce(tabs, L.c);
}

function shadowEnforce(tabs, c) {
  const s = state, live = new Set(tabs.map((tb) => key(tb.id)));
  for (const k of Object.keys(s.shadow)) if (!live.has(k)) delete s.shadow[k];
  const asIfAwake = (tb) => ({ ...tb, discarded: false, status: "complete" });
  const cands = tabs.filter((tb) => s.shadow[key(tb.id)] !== undefined && tb.status !== "loading"
    && sleepable(asIfAwake(tb), s))
    .sort((a, b) => s.shadow[key(a.id)] - s.shadow[key(b.id)]);
  let n = tabs.filter((tb) => s.shadow[key(tb.id)] !== undefined && counts(tb, s)).length;
  for (const tb of cands) {
    if (n <= c) break;
    delete s.shadow[key(tb.id)];
    n -= 1;
  }
}

function pickVictim(candidates, threshold) {
  const s = state, c = s.settings.maxAwake, t = s.clock;
  const meta = (tb) => s.metas[key(tb.id)] || { ...newMeta(), last: 0, count: 0 };
  const lruTab = () => candidates.reduce((a, b) => (meta(a).last <= meta(b).last ? a : b));
  if (Math.random() < s.wModel) {
    let best = null, bestScore = -1;
    for (const tb of candidates) {
      const sc = score(s.model, features(meta(tb), t, c));
      if (sc > bestScore) { bestScore = sc; best = tb; }
    }
    if (bestScore >= threshold) return { tab: best, by: "model" };
  }
  return { tab: lruTab(), by: "lru" };
}

async function sleepTab(tab, by, why = null) {
  const s = state, k = key(tab.id);
  try {
    const out = await chrome.tabs.discard(tab.id);
    if (!out) return false;
    const nk = key(out.id);
    if (nk !== k) migrate(k, nk);
    s.asleep[nk] = { by, why, at: Date.now(), title: tab.title || tab.url, url: tab.url };
    delete s.pausedAt[nk];
    delete s.prewoke[nk];
    if (by === "model") { s.hModel[nk] = s.clock; s.stats.modelSleeps += 1; }
    if (by === "lru") { s.hLRU[nk] = s.clock; s.stats.lruSleeps += 1; }
    for (const h of [s.hModel, s.hLRU]) {
      const keys = Object.keys(h);
      if (keys.length > s.settings.maxAwake) delete h[keys.sort((a, b) => h[a] - h[b])[0]];
    }
    s.stats.sleeps += 1;
    return true;
  } catch (e) {
    return false;     // Chrome refused (for example the tab became active)
  }
}

function migrate(from, to) {
  const s = state;
  for (const name of PER_TAB) {
    const m = s[name];
    if (m[from] !== undefined) { m[to] = m[from]; delete m[from]; }
  }
  const id = (x) => (String(x) === from ? Number(to) : x);
  for (const sh of s.task.shelves) sh.ids = sh.ids.map(id);
  if (s.task.left) s.task.left.ids = s.task.left.ids.map(id);
}

function forget(k) {
  const s = state;
  for (const name of PER_TAB) delete s[name][k];
}

// --- predictive wake -------------------------------------------------------

// Which sleeping tab you're most likely to open next: the one you most often
// switched to from the tab you're on, else the most recent one of this task.
function predictNext(tabs) {
  const s = state, from = s.log[s.log.length - 1];
  const asleep = tabs.filter((tb) => tb.discarded && !tb.active && isWeb(tb));
  if (!asleep.length) return null;
  const ids = new Set(asleep.map((tb) => tb.id)), n = new Map();
  for (let i = 1; i < s.log.length; i++) {
    if (s.log[i - 1] === from && ids.has(s.log[i])) n.set(s.log[i], (n.get(s.log[i]) || 0) + 1);
  }
  let best = null, most = 0;
  for (const [id, c] of n) if (c > most) { most = c; best = id; }
  if (best !== null && most >= 2) return { tab: asleep.find((tb) => tb.id === best), why: `you often go there from here (${most}×)` };
  if (s.settings.taskFocus) {
    const cur = taskClusters(tabs).find((c) => c.ids.includes(from));
    const same = cur ? asleep.filter((tb) => cur.ids.includes(tb.id)) : [];
    const last = (tb) => (s.metas[key(tb.id)] || {}).last || 0;
    if (same.length) return { tab: same.sort((a, b) => last(b) - last(a))[0], why: `part of your ${cur.label} task` };
  }
  return null;
}

async function prewake(tab, why) {
  const s = state, k = key(tab.id);
  if (!tab.discarded) return false;
  try { await chrome.tabs.reload(tab.id); } catch { return false; }
  delete s.asleep[k];
  s.prewoke[k] = { at: Date.now(), why };
  if (!s.metas[k]) s.metas[k] = newMeta();
  s.metas[k].seen = Date.now();          // grace period: don't put it straight back to sleep
  s.stats.prewakes += 1;
  return true;
}

// --- away and handoff ------------------------------------------------------

async function syncIdle() {
  if (!chrome.idle) return;
  const secs = Math.max(15, Math.round(60 * state.settings.awayMinutes));
  chrome.idle.setDetectionInterval(secs);
  state.idle = await chrome.idle.queryState(secs);
}

// What's playing is shared as a hash of its address, never the address.
async function mediaHash(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  let id = u.origin + u.pathname;
  const v = u.searchParams.get("v");
  if (v) id += "?v=" + v;                // YouTube-style video ids live in the query
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function publishPlaying(tab) {
  const hash = await mediaHash(tab.url);
  if (!hash || (lastPublished.hash === hash && Date.now() - lastPublished.at < MINUTE)) return;
  lastPublished = { hash, at: Date.now() };
  await chrome.storage.sync.set({ nowPlaying: { device: state.deviceId, hash, at: Date.now() } });
}

async function onRemotePlaying(v) {
  const s = state;
  if (!s.settings.handoff || !v || v.device === s.deviceId || Date.now() - v.at > 10 * MINUTE) return;
  for (const tb of await chrome.tabs.query({})) {
    if (tb.audible || !sleepable(tb, s)) continue;
    if (await mediaHash(tb.url) === v.hash) await sleepTab(tb, "handoff");
  }
}

// --- green mode ------------------------------------------------------------

async function syncOffscreen() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) return;
  const have = (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
  if (state.settings.green && !have) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BATTERY_STATUS"],
      justification: "Green mode: notice when the computer runs on battery." }).catch(() => {});
  } else if (!state.settings.green && have) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function sampleCpu() {
  if (!chrome.system || !chrome.system.cpu) return;
  const info = await chrome.system.cpu.getInfo();
  let idle = 0, total = 0;
  for (const p of info.processors) { idle += p.usage.idle; total += p.usage.total; }
  const prev = state.cpuPrev, now = Date.now();
  state.cpuPrev = { idle, total, at: now };
  if (prev && total > prev.total && now - prev.at < 10 * MINUTE) {
    state.cpu = { load: Math.min(1, Math.max(0, 1 - (idle - prev.idle) / (total - prev.total))), at: now };
  }
}

// Carbon intensity of the local grid from Electricity Maps, with the user's
// own free API key. Fetched outside the event queue so tabs never wait on it.
async function refreshCarbon(force) {
  await serial(load);
  const st = state.settings, old = state.carbon;
  if (!st.green || !st.carbonKey || !st.carbonZone) return state.carbon || null;
  if (!force && old && old.zone === st.carbonZone && Date.now() - old.at < 30 * MINUTE) return old;
  let rec;
  if (!(await chrome.permissions.contains({ origins: [CARBON_ORIGIN] }))) {
    rec = { g: null, zone: st.carbonZone, at: Date.now(), error: "Allow access to api.electricitymap.org in Settings" };
  } else {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
      const r = await fetch(`https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(st.carbonZone)}`,
        { headers: { "auth-token": st.carbonKey }, signal: ctl.signal });
      clearTimeout(timer);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.carbonIntensity !== "number") throw new Error(j.message || j.error || `HTTP ${r.status}`);
      rec = { g: j.carbonIntensity, zone: st.carbonZone, at: Date.now() };
    } catch (e) {
      rec = { g: null, zone: st.carbonZone, at: Date.now(), error: String(e.message || e).slice(0, 140) };
    }
  }
  await serial(async () => { state.carbon = rec; await enforce(); await save(); });
  return rec;
}

// --- optional page scripts (typing, predictive wake, call mode) ------------

async function syncScripts() {
  const s = state;
  const all = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  const calls = all || await chrome.permissions.contains({ origins: CALL_SITES });
  const want = {
    typing: s.settings.protectTyping && all &&
      { id: "typing", js: ["content-typing.js"], matches: ["<all_urls>"], runAt: "document_idle" },
    intent: s.settings.predictiveWake && all &&
      { id: "intent", js: ["content-intent.js"], matches: ["<all_urls>"], runAt: "document_idle" },
    "call-main": s.settings.callMode && calls &&
      { id: "call-main", js: ["content-call.js"], matches: CALL_SITES, runAt: "document_start", world: "MAIN", allFrames: true },
    "call-relay": s.settings.callMode && calls &&
      { id: "call-relay", js: ["content-call-relay.js"], matches: CALL_SITES, runAt: "document_start", allFrames: true },
  };
  try {
    const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id));
    const add = [], remove = [];
    for (const [id, spec] of Object.entries(want)) {
      if (spec && !have.has(id)) add.push(spec);
      if (!spec && have.has(id)) remove.push(id);
    }
    if (remove.length) await chrome.scripting.unregisterContentScripts({ ids: remove });
    if (add.length) await chrome.scripting.registerContentScripts(add);
  } catch (e) {
    console.warn("Smart Tab Saver: page scripts", e);
  }
}

// --- tasks as Chrome tab groups (off unless you turn it on) ----------------

async function syncGroups(tabs, tasks) {
  const s = state;
  if (!chrome.tabGroups) return;
  try {
    const live = new Set((await chrome.tabGroups.query({})).map((g) => key(g.id)));
    for (const g of Object.keys(s.groups)) if (!live.has(g)) delete s.groups[g];
    const ours = (tb) => s.groups[key(tb.groupId)] !== undefined;
    if (!s.settings.tabGroups) {
      const mine = tabs.filter(ours).map((tb) => tb.id);
      if (mine.length) await chrome.tabs.ungroup(mine);
      s.groups = {};
      return;
    }
    const byId = new Map(tabs.map((tb) => [tb.id, tb]));
    const free = (tb) => tb && !tb.pinned && (tb.groupId === -1 || ours(tb));
    const used = new Set(), placed = new Set();
    for (const task of tasks) {
      const perWindow = new Map();
      for (const id of task.ids) {
        const tb = byId.get(id);
        if (!free(tb)) continue;
        if (!perWindow.has(tb.windowId)) perWindow.set(tb.windowId, []);
        perWindow.get(tb.windowId).push(tb);
      }
      for (const [windowId, list] of perWindow) {
        if (list.length < 2) continue;
        const reuse = list.find((tb) => ours(tb) && !used.has(tb.groupId));
        let gid = reuse ? reuse.groupId : undefined;
        const need = list.filter((tb) => tb.groupId !== gid).map((tb) => tb.id);
        if (need.length) gid = await chrome.tabs.group(gid !== undefined ? { tabIds: need, groupId: gid } : { tabIds: need, createProperties: { windowId } });
        used.add(gid);
        for (const tb of list) placed.add(tb.id);
        if (s.groups[key(gid)] !== task.label) {
          await chrome.tabGroups.update(gid, { title: task.label });
          s.groups[key(gid)] = task.label;
        }
      }
    }
    // tabs we grouped earlier that no longer belong to a task
    const stray = tabs.filter((tb) => ours(tb) && !placed.has(tb.id)).map((tb) => tb.id);
    if (stray.length) await chrome.tabs.ungroup(stray);
  } catch (e) {
    console.warn("Smart Tab Saver: tab groups", e);
  }
}

// --- learning from your own switches ---------------------------------------

function learn() {
  const s = state, c = s.settings.maxAwake;
  const log = s.log.map(String);
  const distinct = new Set(log).size;
  if (log.length < 150 || distinct <= c) {
    return { ok: false, message: `Not enough history yet: ${log.length} tab switches across ${distinct} tabs. Keep browsing with more than ${c} tabs and try again.` };
  }
  const { X, y } = optDataset(log, c, 2);
  if (X.length < 100 || y.every((v) => v === y[0])) {
    return { ok: false, message: "Your history doesn't have enough moments where a tab had to sleep. Keep browsing and try again." };
  }
  const fitted = fitLogReg(X, y);
  const candidate = { ...fitted, source: "learned", trainedOn: log.length };
  const before = replay(log, c, s.model), after = replay(log, c, candidate);
  s.model = candidate;
  s.lastLearn = { at: Date.now(), switches: log.length, rows: X.length,
    lruReloads: after.lruFaults, oldModelReloads: before.modelFaults, newModelReloads: after.modelFaults };
  return { ok: true, ...s.lastLearn };
}

// --- events ----------------------------------------------------------------

async function onSwitch(tabId, isNew) {
  await load();
  const moved = reference(tabId, isNew);
  const tabs = await chrome.tabs.query({});
  const tasks = state.settings.taskFocus ? taskClusters(tabs) : null;
  if (moved && tasks) trackTask(tabId, tasks);
  await enforce(tabs, tasks);
  await save();
}

chrome.tabs.onActivated.addListener(({ tabId }) => serial(() => onSwitch(tabId, false)));
chrome.tabs.onCreated.addListener((tab) => serial(() => onSwitch(tab.id, true)));

chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  await load();
  forget(key(tabId));
  await save();
}));

chrome.tabs.onReplaced.addListener((added, removed) => serial(async () => {
  await load();
  migrate(key(removed), key(added));
  await save();
}));

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.discarded !== true && info.status !== "loading" && info.audible === undefined) return;
  serial(async () => {
    await load();
    const s = state, k = key(tabId);
    if (info.discarded === true && !s.asleep[k]) {
      s.asleep[k] = { by: "chrome", at: Date.now(), title: tab.title || tab.url, url: tab.url };
    }
    if (info.status === "loading" && info.url) {       // a new page: its typing, call and video are gone
      delete s.dirty[k];
      delete s.calls[k];
      delete s.playing[k];
      delete s.pausedAt[k];
    }
    if (info.audible === true) {
      s.playing[k] = 1;
      delete s.pausedAt[k];
      if (s.settings.handoff) await publishPlaying(tab).catch(() => {});
    } else if (info.audible === false && s.playing[k]) {
      delete s.playing[k];
      s.pausedAt[k] = Date.now();
    }
    await save();
  });
});

const handlers = {
  async typing(msg, sender) { if (sender.tab) state.dirty[key(sender.tab.id)] = !!msg.dirty; },
  async call(msg, sender) {
    if (!sender.tab) return;
    if (msg.live) state.calls[key(sender.tab.id)] = Date.now();
    else delete state.calls[key(sender.tab.id)];
    await enforce();
  },
  async battery(msg) {
    state.power = msg.unsupported ? null : { charging: !!msg.charging, level: typeof msg.level === "number" ? msg.level : null, at: Date.now() };
    await enforce();
  },
  async intent(msg, sender) {
    if (!state.settings.predictiveWake || !sender.tab || Date.now() - lastIntent < 8000) return { ok: false };
    lastIntent = Date.now();
    const tabs = await chrome.tabs.query({});
    const guess = predictNext(tabs);
    if (!guess || !(await prewake(guess.tab, guess.why))) return { ok: false };
    await enforce();
    return { ok: true, tabId: guess.tab.id };
  },
  async prewake(msg) {                     // hovering a sleeping tab in the popup
    const tab = await chrome.tabs.get(msg.tabId);
    return { ok: await prewake(tab, "you pointed at it") };
  },
  async open(msg) {
    const tab = await chrome.tabs.update(msg.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  },
  async settings(msg) {
    const s = state, before = s.settings;
    s.settings = { ...s.settings, ...msg.settings };
    const clamp = (name, lo, hi) => { s.settings[name] = Math.max(lo, Math.min(hi, Number(s.settings[name]) || lo)); };
    clamp("maxAwake", 2, 50);
    s.settings.maxAwake = Math.round(s.settings.maxAwake);
    clamp("taskShiftSeconds", 10, 3600);
    clamp("awayMinutes", 1, 120);
    clamp("pausedMinutes", 1, 240);
    clamp("carbonHigh", 50, 1500);
    if (before.carbonKey !== s.settings.carbonKey || before.carbonZone !== s.settings.carbonZone) delete s.carbon;
    await syncScripts();
    await syncOffscreen();
    await syncIdle();
    const tabs = await chrome.tabs.query({});
    const tasks = s.settings.taskFocus ? taskClusters(tabs) : [];
    if (before.tabGroups !== s.settings.tabGroups || s.settings.tabGroups) await syncGroups(tabs, tasks);
    await enforce(tabs, tasks);
  },
  async sleep(msg) {
    const tab = await chrome.tabs.get(msg.tabId);
    if (!tab.active) await sleepTab(tab, "you");
  },
  async wake(msg) {
    delete state.asleep[key(msg.tabId)];
    await chrome.tabs.reload(msg.tabId);
  },
  async "sleep-task"(msg) {
    const now = { ...state, settings: { ...state.settings, graceSeconds: 0 } };   // you asked: no grace period
    for (const tb of await chrome.tabs.query({})) {
      if (msg.ids.includes(tb.id) && sleepable(tb, now)) await sleepTab(tb, "you");
    }
  },
  async "wake-task"(msg) {
    for (const tb of await chrome.tabs.query({})) {
      if (msg.ids.includes(tb.id) && tb.discarded) { delete state.asleep[key(tb.id)]; await chrome.tabs.reload(tb.id).catch(() => {}); }
    }
    state.task.shelves = state.task.shelves.filter((sh) => !sh.ids.some((id) => msg.ids.includes(id)));
  },
  async refresh() { await sampleCpu(); },
  learn: async () => learn(),
  async "reset-model"() { Object.assign(state, { model: PRETRAINED, lastLearn: null, wModel: 0.5 }); },
  async "reset-stats"() { state.stats = freshStats(); },
  async enforce() { await enforce(); },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "carbon-test") {
    refreshCarbon(true).then((r) => reply({ ok: true, carbon: r }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  const h = msg && handlers[msg.type];
  if (!h) return false;
  serial(async () => {
    await load();
    let out;
    try { out = await h(msg, sender); } catch (e) { out = { ok: false, error: String(e.message || e) }; }
    await save();
    reply(out || { ok: true });
  });
  return true;   // reply asynchronously
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.nowPlaying || !changes.nowPlaying.newValue) return;
  serial(async () => { await load(); await onRemotePlaying(changes.nowPlaying.newValue); await save(); });
});

if (chrome.idle) {
  chrome.idle.onStateChanged.addListener((st) => serial(async () => {
    await load();
    state.idle = st;
    await enforce();
    await save();
  }));
}

chrome.permissions.onAdded.addListener(() => serial(async () => { await load(); await syncScripts(); await save(); }));
chrome.permissions.onRemoved.addListener(() => serial(async () => { await load(); await syncScripts(); await save(); }));

async function setUp() {
  chrome.alarms.create("enforce", { periodInMinutes: 1 });
  await syncScripts();
  await syncOffscreen();
  await syncIdle();
  await sampleCpu();
}

chrome.runtime.onStartup.addListener(() => serial(async () => {
  // Tab ids change between browser sessions: keep the model, stats and
  // learning history, forget per-tab state.
  await load();
  for (const k of PER_TAB) state[k] = {};
  Object.assign(state, { task: { left: null, shelves: [] }, groups: {} });
  await setUp();
  await save();
}));

chrome.runtime.onInstalled.addListener(() => serial(async () => {
  await load();
  const tabs = await chrome.tabs.query({});
  for (const tb of tabs.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0))) {
    if (!state.metas[key(tb.id)]) reference(tb.id, true);
  }
  await setUp();
  await save();
}));

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "enforce") return;
  serial(async () => {
    await load();
    await sampleCpu();
    await syncIdle();
    await syncOffscreen();
    const tabs = await chrome.tabs.query({});
    const tasks = state.settings.taskFocus ? taskClusters(tabs) : [];
    await enforce(tabs, tasks);
    await syncGroups(await chrome.tabs.query({}), tasks);
    await save();
  });
  refreshCarbon(false);
});
