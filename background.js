// Smart Tab Saver service worker.
//
// Keeps at most `maxAwake` tabs loaded. When there are too many, it puts one
// to sleep (chrome.tabs.discard) chosen by the learned policy (policy.js):
//   1. score every tab that may sleep with P(not needed soon), from its own
//      history, where it stands among the other tabs, and its task;
//   2. if even the best score is below the threshold, use LRU instead;
//   3. switching: the model and LRU both run as shadows on the same switches,
//      and the one that caused fewer reloads lately decides (Chledowski et
//      al. 2021), so the model never does much worse than LRU.
//
// Smart features on top (each can be switched off in the popup):
//   - Task focus: open tabs are grouped into tasks (tasks.js). When you move
//     on from a task for good, its tabs sleep together.
//   - Predictive wake: heading for the tab bar wakes the sleeping tab you
//     are most likely to open next, before you click it.
//   - Away and handoff: a video you paused and left, stepping away from the
//     computer, or the same video playing on another of your Chrome devices
//     lets tabs sleep sooner. Opening YouTube on your phone pauses YouTube
//     here and puts its tab to sleep (phone handoff).
//   - Green mode: on battery, with a busy CPU or a high-carbon power grid,
//     fewer tabs stay awake.
//   - Call mode: during a video call in the browser, fewer tabs stay awake.
//   - Phone app: see the tabs on your phone and sleep, wake, close, pause or
//     open them there (docs/app), end-to-end encrypted.

import { PRETRAINED, usable, newMeta, touch, features, contexts, score, trainModel, replay, walk, optChoice } from "./policy.js";
import { DEFAULT_SETTINGS, CALL_SITES, CARBON_ORIGIN, PHONE_RELAY, PHONE_ORIGINS, counts, sleepable, limits, isAway,
  isVideoSite, isExcluded, hostOf } from "./rules.js";
import { MAX_AGE, CODE_MINUTES, newPairing, pairingCode, newShortCode, codeChannel, seal, unseal, toLaptop, toPhone } from "./docs/app/link.js";
import { clusterTabs } from "./tasks.js";

const LOG_CAP = 5000;
const HALF_LIFE = 100;          // switches: how fast the model's and LRU's recent reloads are forgotten
const MINUTE = 60 * 1000;
const PER_TAB = ["metas", "asleep", "shadow", "shadowModel", "dirty", "calls", "prewoke", "playing", "pausedAt"];

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
    wModel: 0.5,        // the model's share of recent success against LRU (the popup's trust bar)
    lead: { model: 0, lru: 0 },   // recent reloads of each, fading: the one with fewer decides
    shadow: {},         // tabs plain LRU would keep awake -> their last switch time
    shadowModel: {},    // tabs the model alone would keep awake
    dirty: {},          // tabId -> true while the user has typed unsaved text
    log: [],            // tab switch history, for learning
    taskLog: [],        // the task of each switch in log (or null)
    taskLast: {},       // task -> clock of its last switch
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
  if (!state.phone) state.phone = { seen: [], last: null };   // relay messages seen, last handoff handled
  if (!state.phone.nonces) state.phone.nonces = [];             // phone app commands seen
  if (!state.deviceId) state.deviceId = crypto.randomUUID();
  if (!usable(state.model)) Object.assign(state, { model: PRETRAINED, lastLearn: null });   // an older version's model
  if (!state.lead) state.lead = { model: 0, lru: 0 };
  if (!state.taskLast) state.taskLast = {};
  if (!Array.isArray(state.taskLog) || state.taskLog.length !== state.log.length) state.taskLog = state.log.map(() => null);
  return state;
}

async function save() {
  await chrome.storage.local.set({ state });
}

const key = (id) => String(id);
const isWeb = (tb) => /^https?:/.test(tb.url || "");

// --- references: a tab is opened or switched to ---------------------------

function reference(tabId, isNew, task) {
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
    delete s.asleep[k];
  }
  // A tab we woke early because you were heading for it: no wait for you.
  if (s.prewoke[k]) {
    if (now - s.prewoke[k].at < 10 * MINUTE) s.stats.prewakeHits += 1;
    delete s.prewoke[k];
  }
  // Shadows: the same switches, the same limit and protections, but LRU, or
  // the model alone, chooses. A switch to a tab one of them would have put to
  // sleep counts as its reload; the counts fade so recent ones matter most.
  const fade = Math.pow(0.5, 1 / HALF_LIFE);
  s.lead.model *= fade;
  s.lead.lru *= fade;
  if (!isNew && s.metas[k]) {
    if (s.shadow[k] === undefined) { s.stats.lruReloads += 1; s.lead.lru += 1; }
    if (!s.shadowModel[k]) s.lead.model += 1;
  }
  const total = s.lead.model + s.lead.lru;
  s.wModel = total > 0.05 ? s.lead.lru / total : 0.5;
  s.shadow[k] = t;
  s.shadowModel[k] = 1;
  if (task) s.taskLast[task] = t;

  if (s.pausedAt[k]) s.pausedAt[k] = now;   // you looked at the paused video again
  if (!s.metas[k]) s.metas[k] = newMeta();
  touch(s.metas[k], t);
  s.metas[k].seen = now;
  s.log.push(tabId);
  s.taskLog.push(task || null);
  if (s.log.length > LOG_CAP) {
    s.log.splice(0, s.log.length - LOG_CAP);
    s.taskLog.splice(0, s.taskLog.length - LOG_CAP);
  }
  return true;
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
  if (!tasks) tasks = taskClusters(tabs);
  const cur = s.settings.taskFocus ? tasks.find((c) => c.ids.includes(lastRef)) : null;
  while (awakeCount > L.c && candidates.length) {
    const pool = cur ? candidates.filter((tb) => !cur.ids.includes(tb.id)) : candidates;
    const residents = live.filter((tb) => awake(tb) && counts(tb, s));
    const { tab, by } = pickVictim(pool.length ? pool : candidates, residents, tasks, L.threshold);
    candidates.splice(candidates.indexOf(tab), 1);
    // over the usual limit it's the usual rule; under it, a smart mode asked
    const why = awakeCount > L.base ? null : (L.modes[0] ? L.modes[0].mode : null);
    if (await sleepTab(tab, by, why)) awakeCount -= 1;
  }
  shadowEnforce(tabs, L.c);
  shadowModelEnforce(tabs, tasks, L.c);
}

// What the model alone would keep awake, for switching.
function shadowModelEnforce(tabs, tasks, c) {
  const s = state, live = new Set(tabs.map((tb) => key(tb.id)));
  for (const k of Object.keys(s.shadowModel)) if (!live.has(k)) delete s.shadowModel[k];
  const asIfAwake = (tb) => ({ ...tb, discarded: false, status: "complete" });
  const members = tabs.filter((tb) => s.shadowModel[key(tb.id)] && counts(tb, s));
  const cands = members.filter((tb) => tb.status !== "loading" && sleepable(asIfAwake(tb), s));
  while (members.length > c && cands.length) {
    const v = modelPick(cands, members, tasks);
    delete s.shadowModel[key(v.tab.id)];
    members.splice(members.indexOf(v.tab), 1);
    cands.splice(cands.indexOf(v.tab), 1);
  }
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

const metaOf = (tb) => state.metas[key(tb.id)] || newMeta();

// The model's pick among candidates: features are worked out over all the
// awake tabs (residents), as in training. Returns the tab and its score.
function modelPick(candidates, residents, tasks) {
  const s = state, c = s.settings.maxAwake, t = s.clock;
  const taskOf = new Map();
  for (const task of tasks || []) for (const id of task.ids) taskOf.set(id, task.label);
  const all = [...new Set([...residents, ...candidates])];
  const ctx = contexts(all, metaOf, t, (tb) => taskOf.get(tb.id), taskOf.get(s.log[s.log.length - 1]), (k) => s.taskLast[k]);
  let best = null, top = -1;
  for (const tb of candidates) {
    const sc = score(s.model, features(metaOf(tb), t, c, ctx.get(tb)));
    if (sc > top) { top = sc; best = tb; }
  }
  return { tab: best, score: top };
}

function pickVictim(candidates, residents, tasks, threshold) {
  const s = state;
  const lruTab = () => candidates.reduce((a, b) => (metaOf(a).last <= metaOf(b).last ? a : b));
  if (s.lead.model <= s.lead.lru) {          // the model has caused no more reloads than LRU lately
    const m = modelPick(candidates, residents, tasks);
    if (m.score >= threshold) return { tab: m.tab, by: "model" };
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
    if (by === "model") s.stats.modelSleeps += 1;
    if (by === "lru") s.stats.lruSleeps += 1;
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
  s.log = s.log.map(id);   // a tab gets a new id when it sleeps
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

// --- phone handoff and the phone app ---------------------------------------

// Two things reach this browser from your phone through a public ntfy relay:
//   - Phone handoff: opening YouTube on your phone makes an automation app
//     there publish a plain signal to a private topic. Any video playing on
//     YouTube here is paused, the time it stopped at goes into the address,
//     and the tab sleeps unless you're looking at it.
//   - The phone app (docs/app) sends commands, sealed with the key from the
//     pairing QR code: sleep, wake, close, pause or play a tab, pause YouTube,
//     or send the address of a tab to open it on the phone. While the app is
//     open it gets the list of tabs, sealed the same way, whenever it changes.
// While the service worker runs it listens on one WebSocket for both topics (a
// ping every 20 s keeps it running); an alarm every 30 s reconnects it and
// polls the relay in case a message was missed.

const PHONE_TEST = "test from Smart Tab Saver";
const APP_LIVE = 5 * MINUTE;                // keep sending tab lists this long after the app was last seen
let phoneSocket = null, phonePing = null, streamTimer = null;
const streamReplies = [];

function newTopic() {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  return "sts-" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => abc[b % abc.length]).join("");
}

async function phoneOn() {
  return state.settings.phoneHandoff && await chrome.permissions.contains({ origins: PHONE_ORIGINS });
}

async function remoteOn() {
  return state.settings.remote && !!state.settings.remoteKey && await chrome.permissions.contains({ origins: PHONE_ORIGINS });
}

const pairing = () => ({ id: state.settings.remoteId, key: state.settings.remoteKey });

function newRemotePairing() {
  const p = newPairing();
  Object.assign(state.settings, { remoteId: p.id, remoteKey: p.key });
}

async function phoneTopics() {
  const topics = [];
  if (await phoneOn()) topics.push(state.settings.phoneTopic);
  if (await remoteOn()) topics.push(toLaptop(pairing()));
  return topics;
}

async function syncPhone() {
  const s = state;
  if (s.settings.phoneHandoff && !s.settings.phoneTopic) s.settings.phoneTopic = newTopic();
  if (s.settings.remote && !s.settings.remoteKey) newRemotePairing();
  const topics = await phoneTopics();
  if (!topics.length) {
    closePhone();
    await chrome.alarms.clear("phone");
    return;
  }
  if (!(await chrome.alarms.get("phone"))) chrome.alarms.create("phone", { periodInMinutes: 0.5 });
  openPhone(topics.join(","));
}

function closePhone() {
  clearInterval(phonePing);
  phonePing = null;
  if (phoneSocket) {
    phoneSocket.onclose = null;
    phoneSocket.close();
    phoneSocket = null;
  }
}

function openPhone(topics) {
  if (phoneSocket && phoneSocket.topics === topics && phoneSocket.readyState <= WebSocket.OPEN) return;
  closePhone();
  let ws;
  try { ws = new WebSocket(`${PHONE_RELAY.replace(/^http/, "ws")}/${topics}/ws`); } catch { return; }
  ws.topics = topics;
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === "message") serial(async () => { await load(); await onRelayMessage(m); await save(); });
  };
  ws.onclose = () => {                       // the next alarm reconnects
    if (phoneSocket !== ws) return;
    clearInterval(phonePing);
    phoneSocket = phonePing = null;
  };
  phoneSocket = ws;
  phonePing = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, 20000);
}

// Asks the relay for the last two minutes of messages. Runs outside the event
// queue so tabs never wait on the network.
async function pollPhone(force = false) {
  await serial(load);
  const topics = await phoneTopics();
  if (!topics.length || (!force && phoneSocket && phoneSocket.readyState === WebSocket.OPEN)) return 0;
  let text = "";
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
    const since = Math.floor(Date.now() / 1000) - MAX_AGE;
    const r = await fetch(`${PHONE_RELAY}/${topics.join(",")}/json?poll=1&since=${since}`,
      { cache: "no-store", signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) text = await r.text();
  } catch { return 0; }
  const msgs = [];
  for (const line of text.split("\n")) {
    try { const m = JSON.parse(line); if (m.event === "message") msgs.push(m); } catch { /* blank line */ }
  }
  if (msgs.length) await serial(async () => { await load(); for (const m of msgs) await onRelayMessage(m); await save(); });
  return msgs.length;
}

function firstTime(list, item, cap = 60) {
  if (!item || list.includes(item)) return false;
  list.push(item);
  if (list.length > cap) list.shift();
  return true;
}

async function onRelayMessage(m) {
  if (!firstTime(state.phone.seen, m.id)) return;
  if (m.topic === state.settings.phoneTopic) await onPhoneSignal(m);
  else if (state.settings.remoteId && m.topic === toLaptop(pairing())) await onRemote(m);
}

async function onPhoneSignal(m) {
  if (Date.now() / 1000 - (m.time || 0) > MAX_AGE) return;
  state.phone.last = { at: Date.now(), ...(await pauseYouTube()), test: m.message === PHONE_TEST };
}

// Pauses every video playing on a video site; those tabs sleep unless you're
// looking at them, or they're pinned or excluded.
async function pauseYouTube() {
  const s = state;
  let paused = 0, slept = 0;
  for (const tb of await chrome.tabs.query({})) {
    if (tb.discarded || !isVideoSite(tb.url)) continue;
    let r = null;
    try {
      [{ result: r }] = await chrome.scripting.executeScript({ target: { tabId: tb.id }, world: "MAIN", func: pauseVideo });
    } catch { continue; }
    if (!r || !r.paused) continue;
    paused += 1;
    if (tb.active || (tb.pinned && s.settings.protectPinned) || isExcluded(tb.url, s)) continue;
    if (await sleepTab(await chrome.tabs.get(tb.id), "phone")) slept += 1;
  }
  return { paused, slept };
}

// Runs inside the video page: pause whatever is playing and put the time in
// the address (YouTube's t=), so the tab starts there again when it wakes.
function pauseVideo() {
  const playing = [...document.querySelectorAll("video")].filter((v) => !v.paused && !v.ended);
  if (!playing.length) return { paused: 0 };
  for (const v of playing) v.pause();
  const t = Math.floor(playing[0].currentTime);
  try {
    const u = new URL(location.href);
    if (u.pathname === "/watch" && t > 0) {
      u.searchParams.set("t", t + "s");
      history.replaceState(history.state, "", u.href);
    }
  } catch (e) { /* keep the address as it is */ }
  return { paused: playing.length, t };
}

// Runs inside a page: play its first video, or pause every one that's playing.
function playOrPause(play) {
  const videos = [...document.querySelectorAll("video")];
  if (play) { if (videos[0]) videos[0].play().catch(() => {}); } else videos.forEach((v) => v.pause());
  return videos.length;
}

async function onRemote(m) {
  const s = state, p = s.phone;
  const c = m.message && await unseal(s.settings.remoteKey, m.message);
  if (!c || typeof c.t !== "string" || Math.abs(Date.now() - c.at) > MAX_AGE * 1000 || !firstTime(p.nonces, c.n)) return;
  p.app = Date.now();                       // the app is open: keep its tab list fresh
  const tab = Number.isInteger(c.id) ? await chrome.tabs.get(c.id).catch(() => null) : null;
  let reply = null;
  if (c.t === "sleep" && tab && !tab.active && !tab.discarded) await sleepTab(tab, "remote");
  if (c.t === "wake" && tab && tab.discarded) {
    delete s.asleep[key(tab.id)];
    await chrome.tabs.reload(tab.id).catch(() => {});
  }
  if (c.t === "close" && tab) await chrome.tabs.remove(tab.id).catch(() => {});
  if ((c.t === "pause" || c.t === "play") && tab && !tab.discarded) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: playOrPause, args: [c.t === "play"] }).catch(() => {});
  }
  if (c.t === "pauseAll") p.last = { at: Date.now(), ...(await pauseYouTube()), test: false };
  if (c.t === "url" && tab && isWeb(tab)) reply = { t: "url", id: tab.id, url: tab.url };
  streamSoon(400, reply);
}

// The tab list the phone app shows. Titles are cut short and pages are given
// by site only; the full address is sent when you ask to open a tab.
async function tabList() {
  const s = state, tabs = (await chrome.tabs.query({})).filter(isWeb).slice(0, 150);
  const tasks = s.settings.taskFocus ? taskClusters(tabs) : [];
  const taskOf = new Map();
  tasks.forEach((t, i) => t.ids.forEach((id) => taskOf.set(id, i)));
  return {
    t: "state", at: Date.now(), limit: limits(s).c,
    awake: tabs.filter((tb) => awake(tb) && counts(tb, s)).length,
    tasks: tasks.map((t) => t.label),
    tabs: tabs.map((tb) => ({
      i: tb.id, t: (tb.title || tb.url).slice(0, 90), h: hostOf(tb.url), k: taskOf.has(tb.id) ? taskOf.get(tb.id) : -1,
      s: tb.discarded ? 1 : 0, a: tb.active ? 1 : 0, p: tb.audible ? 1 : 0, v: isVideoSite(tb.url) ? 1 : 0,
    })),
  };
}

// Sends the tab list (and any reply) to the app, if it was open recently.
function streamSoon(delay = 1500, reply = null) {
  if (reply) streamReplies.push(reply);
  if (!state || !state.phone || Date.now() - (state.phone.app || 0) > APP_LIVE) return;
  clearTimeout(streamTimer);
  streamTimer = setTimeout(publishToApp, delay);
}

async function publishToApp() {
  await serial(load);
  if (!(await remoteOn())) return;
  const msgs = streamReplies.splice(0);
  msgs.push(await tabList());
  for (const msg of msgs) {
    try {
      await fetch(`${PHONE_RELAY}/${toPhone(pairing())}`, { method: "POST", body: await seal(state.settings.remoteKey, msg) });
    } catch { /* the app asks again */ }
  }
}

async function phoneTest() {
  await serial(load);
  if (!(await phoneOn())) return { ok: false, error: "Turn on phone handoff first." };
  try {
    const r = await fetch(`${PHONE_RELAY}/${state.settings.phoneTopic}`, { method: "POST", body: PHONE_TEST });
    if (!r.ok) return { ok: false, error: `The relay answered HTTP ${r.status}.` };
  } catch (e) {
    return { ok: false, error: "Couldn't reach the relay: " + String(e.message || e) };
  }
  if (!(phoneSocket && phoneSocket.readyState === WebSocket.OPEN)) setTimeout(() => pollPhone(true), 1500);
  return { ok: true };
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

// Registered scripts only reach pages loaded afterwards, so also run them in the tabs already open.
// Call scripts are skipped: they have to start before the page does.
async function injectIntoOpenTabs(specs) {
  specs = specs.filter((spec) => spec && spec.matches.includes("<all_urls>"));
  if (!specs.length) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"], discarded: false });
  await Promise.allSettled(tabs.flatMap((tb) => specs.map((spec) =>
    chrome.scripting.executeScript({ target: { tabId: tb.id }, files: spec.js }))));
}

async function syncScripts(everywhere = false) {   // everywhere: after install or reload
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
    await injectIntoOpenTabs(everywhere ? Object.values(want) : add);
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
  const log = s.log.map(String), task = s.taskLog;
  const distinct = new Set(log).size;
  if (distinct <= c) {
    return { ok: false, message: `Not enough history yet: ${distinct} different tabs so far, and learning needs more than ${c} (your "keep awake at most"). Keep browsing and try again.` };
  }
  // The moments a tab had to sleep are what it learns from, not a fixed number of switches.
  let moments = 0;
  walk(log, task, c, optChoice, () => moments++);
  if (moments < 15) {
    return { ok: false, message: `Not enough history yet: ${log.length} tab switches gave ${moments} moments where a tab had to sleep, and learning needs 15. Keep browsing and try again.` };
  }
  // Same method as the pretrained model (model/README.md), on your own switches.
  const fitted = trainModel([{ log, task }], [c], { rounds: 2, perRound: 3000, iters: 300 });
  const candidate = { weights: fitted.weights, bias: fitted.bias, source: "learned", trainedOn: log.length };
  const before = replay(log, task, c, s.model), after = replay(log, task, c, candidate);
  if (after.modelFaults > before.modelFaults) {
    return { ok: false, message: `Trained on ${log.length} switches, but the new model would have caused ${after.modelFaults} reloads on them against ${before.modelFaults} with the current one, so the current one stays.` };
  }
  s.model = candidate;
  s.lastLearn = { at: Date.now(), switches: log.length, rows: moments,
    lruReloads: after.lruFaults, oldModelReloads: before.modelFaults, newModelReloads: after.modelFaults };
  return { ok: true, ...s.lastLearn };
}

// --- events ----------------------------------------------------------------

async function onSwitch(tabId, isNew) {
  await load();
  const tabs = await chrome.tabs.query({});
  const tasks = taskClusters(tabs);           // the model uses tasks even when task focus is off
  const mine = tasks.find((c) => c.ids.includes(tabId));
  const moved = reference(tabId, isNew, mine && mine.label);
  if (moved && state.settings.taskFocus) trackTask(tabId, tasks);
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
    await syncPhone();
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
  // A short code to type in the Android app instead of scanning the QR code.
  async "remote-code"() {
    if (!(await remoteOn())) return { ok: false, error: "Turn on the phone app first." };
    const code = newShortCode(), exp = Date.now() + CODE_MINUTES * MINUTE, ch = await codeChannel(code);
    const body = await seal(ch.key, { t: "pair", code: pairingCode(pairing(), PHONE_RELAY), exp });
    try {
      const r = await fetch(`${PHONE_RELAY}/${ch.topic}`, { method: "POST", body });
      if (!r.ok) return { ok: false, error: `The relay answered HTTP ${r.status}.` };
    } catch {
      return { ok: false, error: "Couldn't reach the relay. Check this computer's internet connection." };
    }
    state.remoteCode = { code, exp };
    return { ok: true, code, exp };
  },
  async "remote-unpair"() {                // a new key: phones paired before can no longer read or send
    delete state.remoteCode;
    newRemotePairing();
    await syncPhone();
    return { ok: true };
  },
  async "phone-new-topic"() {
    state.settings.phoneTopic = newTopic();
    await syncPhone();
    return { ok: true, topic: state.settings.phoneTopic };
  },
  learn: async () => learn(),
  async "reset-model"() { Object.assign(state, { model: PRETRAINED, lastLearn: null, wModel: 0.5, lead: { model: 0, lru: 0 } }); },
  async "reset-stats"() { state.stats = freshStats(); },
  async enforce() { await enforce(); },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && (msg.type === "phone-test" || msg.type === "phone-check")) {   // these wait on the network
    (msg.type === "phone-test" ? phoneTest() : pollPhone(true).then((n) => ({ ok: true, signals: n })))
      .then(reply, (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
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

chrome.permissions.onAdded.addListener(() => serial(async () => { await load(); await syncScripts(); await syncPhone(); await save(); }));
chrome.permissions.onRemoved.addListener(() => serial(async () => { await load(); await syncScripts(); await syncPhone(); await save(); }));

async function setUp(installed = false) {
  chrome.alarms.create("enforce", { periodInMinutes: 1 });
  await syncScripts(installed);
  await syncOffscreen();
  await syncIdle();
  await syncPhone();
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
  await setUp(true);
  await save();
}));

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "phone") {
    serial(async () => { await load(); await syncPhone(); await save(); });
    pollPhone();
    return;
  }
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

// Keep an open phone app up to date as tabs change.
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onUpdated]) {
  ev.addListener(() => streamSoon());
}
