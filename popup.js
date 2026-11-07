import { features, score, newMeta } from "./policy.js";
import { CALL_SITES, DEFAULT_SETTINGS, REASON, counts, sleepable, limits, greenSignals, callActive, isAway } from "./rules.js";
import { clusterTabs } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const ALL = ["<all_urls>"];

function favicon(tab) {
  const img = document.createElement("img");
  img.alt = "";
  img.src = tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? tab.favIconUrl : "icons/icon16.png";
  img.onerror = () => { img.src = "icons/icon16.png"; };
  return img;
}

function el(tag, cls, textContent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function item(icon, title, tooltip, whyNodes, button) {
  const li = el("li");
  const t = el("div", "t");
  const name = el("span", "name", title);
  name.title = tooltip || "";
  const why = el("span", "why");
  why.append(...whyNodes);
  t.append(name, why);
  li.append(icon, t, button || el("span"));
  return li;
}

function text(s) { return document.createTextNode(s); }
function chip(label, cls) { return el("span", "chip" + (cls ? " " + cls : ""), label); }
function btn(label, onClick) {
  const b = el("button", "small", label);
  b.type = "button";
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

// --- smart features: one row each, with a plain explanation and a "why" ---

const FEATURES = [
  {
    key: "taskFocus", name: "Task focus",
    line: "Groups your tabs by what you're doing. When you move on to another task, the old task's tabs sleep together.",
    why: "Tabs you open for one job, like planning a trip, are used together and dropped together. Tasks are worked out from tab titles and site names, on this computer only. Coming back to a task stops it from going to sleep.",
    status: (s, x) => {
      const t = s.task || {};
      if (t.left) {
        const left = Math.max(0, 1000 * s.settings.taskShiftSeconds - (Date.now() - t.left.at));
        const switches = Math.max(0, 3 - t.left.switches);
        return `You left “${t.left.label}”. Its tabs sleep ${switches ? `after ${switches} more switch${switches > 1 ? "es" : ""} and ` : ""}${left ? `in ${ago(left)}` : "soon"}.`;
      }
      if (t.shelves && t.shelves.length) return `Putting “${t.shelves[t.shelves.length - 1].label}” to sleep.`;
      return x.tasks.length ? `${x.tasks.length} task${x.tasks.length > 1 ? "s" : ""} found in your tabs.` : "No tasks yet: they appear when a few tabs are about the same thing.";
    },
  },
  {
    key: "predictiveWake", name: "Predictive wake", perm: ALL,
    line: "Move the mouse quickly up toward the tab bar and the sleeping tab you'll most likely open next starts loading.",
    why: "It guesses from the tab you usually open after this one, or the latest tab of the same task, so the page is ready when you click. Needs permission to run a tiny script on pages; it only notices the mouse heading up, never what's on the page.",
    status: (s) => s.stats.prewakes ? `Woke ${s.stats.prewakes} tab${s.stats.prewakes > 1 ? "s" : ""} early; you opened ${s.stats.prewakeHits} of them.` : "Nothing woken early yet.",
  },
  {
    key: "away", name: "Away & handoff",
    line: (s) => `A video you paused and left for ${s.settings.pausedMinutes} minute${s.settings.pausedMinutes === 1 ? "" : "s"} sleeps, and fewer tabs stay awake while you're away from the computer.`,
    why: "A paused video you walked away from, maybe to keep watching on the TV, still holds memory. Most video sites remember where you stopped. Stepping away is noticed from no keyboard or mouse use; a locked screen counts too.",
    extra: { key: "handoff", label: "Also sleep a paused video here when the same one starts on my other Chrome device", hint: "Uses Chrome sync. Only a scrambled code of the video's address is shared, never the address. The tab you're looking at never sleeps." },
    status: (s) => {
      const paused = Object.keys(s.pausedAt || {}).length;
      if (isAway(s)) return s.idle === "locked" ? "Screen locked: fewer tabs stay awake." : "You're away: fewer tabs stay awake.";
      return paused ? `${paused} paused video${paused > 1 ? "s" : ""} waiting.` : "You're here. No paused videos.";
    },
  },
  {
    key: "green", name: "Green mode",
    line: "On battery, with a busy CPU or a high-carbon power grid, fewer tabs stay awake.",
    why: "Every awake tab uses memory and power. A busy CPU stands in for a hot laptop. Grid carbon is optional: add a free Electricity Maps key in Settings.",
    status: (s) => {
      const g = greenSignals(s);
      if (g.length) return `Active: ${g.join(", ")}.`;
      const parts = [];
      if (s.power) parts.push(s.power.charging ? "Plugged in" : "On battery");
      if (s.cpu) parts.push(`CPU ${Math.round(100 * s.cpu.load)}%`);
      if (s.carbon && s.carbon.g != null) parts.push(`grid ${Math.round(s.carbon.g)} g CO₂/kWh`);
      else if (s.carbon && s.carbon.error) parts.push(`grid: ${s.carbon.error}`);
      return parts.length ? parts.join(" · ") + "." : "Checking power and CPU…";
    },
  },
  {
    key: "callMode", name: "Call mode", perm: CALL_SITES,
    line: "During a video call in Meet, Zoom, Teams and others in the browser, half as many tabs stay awake so the call stays smooth.",
    why: "It only notices that a call site turned your microphone or camera on or off. It never hears, sees or records anything. Calls in desktop apps can't be seen by a browser extension. Works for calls you join after turning it on.",
    status: (s) => callActive(s) ? "In a call right now." : "Not in a call.",
  },
];

const openWhy = new Set();

async function renderFeatures(s, x) {
  const all = await chrome.permissions.contains({ origins: ALL });
  const allowedBy = {};
  for (const f of FEATURES) allowedBy[f.key] = !f.perm || all || await chrome.permissions.contains({ origins: f.perm });
  const box = $("features");
  box.replaceChildren();
  for (const f of FEATURES) {
    const on = !!s.settings[f.key];
    const allowed = allowedBy[f.key];
    const row = el("div", "feat" + (on ? " on" : ""));
    const sw = el("label", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.checked = on;
    input.setAttribute("aria-label", f.name);
    input.onchange = async () => {
      await send({ type: "settings", settings: { [f.key]: input.checked } });
      if (input.checked && f.perm) await chrome.permissions.request({ origins: f.perm }).catch(() => false);
      render();
    };
    sw.append(input, el("span"));
    sw.lastChild.setAttribute("aria-hidden", "true");
    const body = el("div", "ft");
    const head = el("div", "fhead");
    head.append(el("b", "", f.name));
    const active = x.L.modes.some((m) => m.mode === { away: "away", green: "green", callMode: "call" }[f.key]);
    if (on && active) head.append(chip("active now"));
    body.append(head, el("div", "line", typeof f.line === "function" ? f.line(s) : f.line));
    if (on) {
      const st = el("div", "now", allowed ? f.status(s, x) : "Needs your permission to work. ");
      if (!allowed) {
        const allow = el("button", "link", "Allow");
        allow.type = "button";
        allow.onclick = async () => { await chrome.permissions.request({ origins: f.perm }).catch(() => false); render(); };
        st.append(allow);
      }
      body.append(st);
    }
    if (f.extra && on) {
      const lab = el("label", "mini");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!s.settings[f.extra.key];
      cb.onchange = async () => { await send({ type: "settings", settings: { [f.extra.key]: cb.checked } }); render(); };
      lab.append(cb, el("span", "", f.extra.label));
      body.append(lab);
    }
    const d = el("details");
    d.open = openWhy.has(f.key);
    d.ontoggle = () => { if (d.open) openWhy.add(f.key); else openWhy.delete(f.key); };
    d.append(el("summary", "", "Why?"), el("p", "", f.why + (f.extra ? " " + f.extra.hint : "")));
    body.append(d);
    row.append(sw, body);
    box.append(row);
  }
}

// --- the whole popup -------------------------------------------------------

async function render() {
  const { state } = await chrome.storage.local.get("state");
  if (!state) { $("note").textContent = "Switch tabs once to start."; return; }
  const s = { calls: {}, pausedAt: {}, task: { left: null, shelves: [] }, ...state };
  s.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  const c = s.settings.maxAwake, L = limits(s);
  const tabs = await chrome.tabs.query({});
  const awake = tabs.filter((t) => !t.discarded && t.status !== "unloaded" && counts(t, s));
  $("awake").textContent = awake.length;
  $("limit").textContent = L.c;
  $("asleep").textContent = tabs.filter((t) => t.discarded || t.status === "unloaded").length;
  $("on").checked = !s.settings.paused;
  $("max").value = c;
  $("max-out").textContent = c;
  try {
    const m = await chrome.system.memory.getInfo();
    $("ram").textContent = `${(m.availableCapacity / 2 ** 30).toFixed(1)} GB of ${(m.capacity / 2 ** 30).toFixed(0)} GB RAM free`;
  } catch { $("ram").textContent = ""; }

  const modes = $("modes");
  modes.replaceChildren();
  modes.hidden = !L.modes.length || s.settings.paused;
  if (L.modes.length) {
    const names = { call: "Call mode", away: "Away", green: "Green mode" };
    modes.append(text(L.c < c ? `Limit now ${L.c}, usually ${c}: ` : "On: "));
    L.modes.forEach((m, i) => { if (i) modes.append(text(" ")); modes.append(chip(`${names[m.mode]} · ${m.why}`, m.mode)); });
  }

  // tasks
  const web = tabs.filter((t) => /^https?:/.test(t.url || ""));
  const tasks = s.settings.taskFocus ? clusterTabs(web.map((t) => ({ id: t.id, title: t.title, url: t.url, openerTabId: t.openerTabId }))) : [];
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = front ? front.id : null;
  const lastRef = s.log[s.log.length - 1];
  $("tasks-sec").hidden = !tasks.length;
  const tl = $("tasks");
  tl.replaceChildren();
  for (const task of tasks.slice(0, 6)) {
    const members = task.ids.map((id) => byId.get(id)).filter(Boolean);
    const sleeping = members.filter((t) => t.discarded).length;
    const here = task.ids.includes(lastRef) || task.ids.includes(activeId);
    const why = [text(`${members.length} tabs${sleeping ? ` · ${sleeping} asleep` : ""}`)];
    if (here) why.push(chip("you're here"));
    const b = sleeping === members.length
      ? btn("Wake", async () => { await send({ type: "wake-task", ids: task.ids }); setTimeout(render, 400); })
      : here ? null : btn("Sleep", async () => { await send({ type: "sleep-task", ids: task.ids }); render(); });
    const dot = el("span", "dot" + (here ? " here" : ""));
    const li = item(dot, task.label, members.map((t) => t.title).join("\n"), why, b);
    tl.append(li);
  }
  const t = s.task;
  $("task-note").textContent = t.left ? FEATURES[0].status(s, { tasks }) : "";

  // reloads
  $("ours").textContent = s.stats.reloads;
  $("lru").textContent = s.stats.lruReloads;
  $("since").textContent = `Since ${new Date(s.stats.since).toLocaleDateString()} · ${s.stats.sleeps} tabs put to sleep`;
  $("prewake-note").hidden = !s.stats.prewakes;
  $("prewake-note").textContent = `Not counted above: ${s.stats.prewakeHits} tab${s.stats.prewakeHits === 1 ? " was" : "s were"} already loading when you got there, thanks to Predictive wake (${s.stats.prewakes} woken early in all).`;

  const wm = Math.round(100 * s.wModel);
  $("trust-bar").style.width = wm + "%";
  $("trust-m").textContent = wm + "%";
  $("trust-l").textContent = 100 - wm + "%";
  $("model-src").textContent = s.model.source === "learned" ? `trained on your ${s.model.trainedOn} switches` : "pretrained";

  // next to sleep: the tabs the model scores highest right now
  const next = $("next");
  next.replaceChildren();
  const cand = tabs.filter((tb) => sleepable(tb, s)).map((tb) => {
    const meta = s.metas[String(tb.id)] || newMeta();
    return { tb, p: score(s.model, features(meta, s.clock, c)) };
  }).sort((a, b) => b.p - a.p).slice(0, 4);
  if (!cand.length) next.append(el("li", "empty", "No tab can sleep right now."));
  for (const { tb, p } of cand) {
    const bar = el("span", "bar");
    const fill = el("i");
    fill.style.width = Math.round(100 * p) + "%";
    bar.append(fill);
    next.append(item(favicon(tb), tb.title || tb.url, tb.url, [bar, text(`${Math.round(100 * p)}% likely not needed soon`)],
      btn("Sleep", async () => { await send({ type: "sleep", tabId: tb.id }); render(); })));
  }

  // sleeping tabs, newest first: point to start loading, click to open
  const sl = $("sleeping");
  sl.replaceChildren();
  const asleep = tabs.filter((tb) => tb.discarded || tb.status === "unloaded").map((tb) => ({ tb, info: s.asleep[String(tb.id)] }))
    .sort((a, b) => (b.info?.at || 0) - (a.info?.at || 0)).slice(0, 8);
  $("sleeping-hint").hidden = !asleep.length;
  if (!asleep.length) sl.append(el("li", "empty", "Nothing asleep yet."));
  for (const { tb, info } of asleep) {
    const reason = (info && (info.why || info.by)) || "chrome";
    const when = info?.at ? new Date(info.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const li = item(favicon(tb), tb.title || tb.url, tb.url, [chip(REASON[reason] || reason, reason === "lru" ? "lru" : ""), text(when)],
      btn("Wake", async () => { await send({ type: "wake", tabId: tb.id }); setTimeout(render, 300); }));
    li.classList.add("clickable");
    let timer = null;
    li.onmouseenter = () => {
      timer = setTimeout(async () => {
        const r = await send({ type: "prewake", tabId: tb.id });
        if (r && r.ok) li.querySelector(".why").replaceChildren(chip("loading for you"));
      }, 450);
    };
    li.onmouseleave = () => clearTimeout(timer);
    li.onclick = () => send({ type: "open", tabId: tb.id });
    sl.append(li);
  }

  await renderFeatures(s, { tasks, L });

  if (s.lastLearn) {
    const LL = s.lastLearn;
    $("learn-msg").textContent = `Last trained ${new Date(LL.at).toLocaleDateString()} on ${LL.switches} switches. On that history: new model ${LL.newModelReloads} reloads, previous ${LL.oldModelReloads}, LRU ${LL.lruReloads}.`;
  }
}

$("on").addEventListener("change", async (e) => { await send({ type: "settings", settings: { paused: !e.target.checked } }); render(); });
$("max").addEventListener("input", (e) => { $("max-out").textContent = e.target.value; });
$("max").addEventListener("change", async (e) => { await send({ type: "settings", settings: { maxAwake: +e.target.value } }); render(); });
$("learn").addEventListener("click", async () => {
  const b = $("learn");
  b.disabled = true; b.textContent = "Learning…";
  const r = await send({ type: "learn" });
  b.disabled = false; b.textContent = "Learn from my browsing";
  await render();
  if (!r.ok) $("learn-msg").textContent = r.message || r.error;   // after render, which shows the last training
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Keep the numbers live while the popup is open, but never redraw the lists
// under the pointer.
let pointerInside = false, pending = null;
document.addEventListener("mouseover", (e) => { pointerInside = !!e.target.closest("ul.tabs, .features"); });
document.addEventListener("mouseleave", () => { pointerInside = false; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.state || pending) return;
  pending = setTimeout(() => { pending = null; if (!pointerInside) render(); }, 800);
});

render();
send({ type: "refresh" }).then(render, () => {});
