// Trains the extension's eviction model and reports how it does on reference
// strings it never saw, using the extension's own code (policy.js).
//   node model/train.mjs
// Prints a results table and the weights to paste into PRETRAINED.

import { trainModel, walk, optChoice, lruChoice, modelChoice, contexts, PRETRAINED, pageFeatures, score, usable } from "../policy.js";
import { taskBrowsing, sweepBrowsing, cyclic, uniform, rng } from "./workloads.mjs";

const CS = [4, 8, 12];
export const HALF_LIFE = 100;               // as background.js: how fast recent reloads are forgotten

// Task clustering in the extension finds most tasks but not all (pairwise
// recall 0.79 in the report): about a quarter of tabs get no task.
export function noisy(w, seed, drop = 0.25) {
  const r = rng(seed), lost = new Map();
  return { log: w.log, task: w.log.map((p, i) => { if (!lost.has(p)) lost.set(p, r() < drop); return lost.get(p) ? -1 : w.task[i]; }) };
}

// The extension's decision rule: run the model and LRU as shadows on the same
// switches and follow whichever has caused fewer reloads lately (Chledowski
// et al. 2021).
export function switching(model, c) {
  const fade = Math.pow(0.5, 1 / HALF_LIFE);
  const sh = { model: { res: new Set(), score: 0, f: modelChoice(model, c) }, lru: { res: new Set(), score: 0, f: lruChoice } };
  const onRef = (p, t, v) => {
    for (const s of Object.values(sh)) {
      s.score *= fade;
      if (s.res.has(p)) continue;
      if (v.metas.has(p)) s.score += 1;
      if (s.res.size >= c) {
        const ids = [...s.res], ctx = contexts(ids, (q) => v.metas.get(q), t, (q) => v.tabTask.get(q), v.cur, (k) => v.taskLast.get(k));
        s.res.delete(s.f(ids, ctx, v.metas, t));
      }
      s.res.add(p);
    }
  };
  const choose = (ids, ctx, metas, t, nextOf) => (sh.model.score <= sh.lru.score ? sh.model : sh.lru).f(ids, ctx, metas, t, nextOf);
  return { choose, onRef };
}

// The shipped model before this change: 8 features, picked at random against LRU by a regret guard.
const OLD = { weights: [0.2308512859375677, 0.08614118576060052, 0.1478872605910588, 0.22419167629105455, 0.2519189703719372,
  0.16225389771383122, -0.2005505162180408, -1.7726282540109795], bias: -0.2526316818701606 };
function oldHybrid(c, seed = 42) {
  const r = rng(seed), hist = { model: new Map(), lru: new Map() };
  let wModel = 0.5;
  const choose = (ids, ctx, metas, t) => {
    let pick = null, by = "lru";
    if (r() < wModel) {
      let best = null, top = -1;
      for (const q of ids) { const s = score(OLD, pageFeatures(metas.get(q), t, c)); if (s > top) { top = s; best = q; } }
      if (top >= 0.5) { pick = best; by = "model"; }
    }
    if (pick === null) pick = lruChoice(ids, ctx, metas);
    hist[by].set(pick, t);
    return pick;
  };
  const onRef = (p, t) => {
    const d = Math.pow(0.005, 1 / c);
    for (const [by, modelWrong] of [["model", true], ["lru", false]]) {
      if (!hist[by].has(p)) continue;
      const reward = Math.pow(d, t - hist[by].get(p));
      hist[by].delete(p);
      let wm = wModel, wl = 1 - wModel;
      if (modelWrong) wl *= Math.exp(0.45 * reward); else wm *= Math.exp(0.45 * reward);
      wModel = Math.min(0.98, Math.max(0.02, wm / (wm + wl)));
      return;
    }
  };
  return { choose, onRef };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fresh = process.argv.includes("--train");
  const strings = [...Array(20)].flatMap((_, i) => [taskBrowsing(1 + i), sweepBrowsing(1001 + i)]).map((w, i) => (i % 2 ? w : noisy(w, 500 + i)));
  let model = PRETRAINED;
  if (fresh || !usable(PRETRAINED)) {
    console.time("training");
    model = trainModel(strings, CS, { rounds: 5, rand: rng(1) });
    console.timeEnd("training");
  }
  const tests = {
    "Task browsing": [...Array(30)].map((_, i) => noisy(taskBrowsing(101 + i), 900 + i)),
    "Browsing + comparison sweeps": [...Array(30)].map((_, i) => noisy(sweepBrowsing(2001 + i), 950 + i)),
    "Cyclic loop, 10 tabs": [cyclic(0)],
    "Uniform random, 12 tabs": [uniform(7)],
  };
  const policies = {
    OPT: () => ({ choose: optChoice }),
    LRU: () => ({ choose: lruChoice }),
    "Old: model + regret guard": (c) => oldHybrid(c),
    "New model alone": (c) => ({ choose: modelChoice(model, c) }),
    "New: model + switching": (c) => switching(model, c),
  };
  console.log("Reloads per 1,200 switches, mean over held-out strings (tasks with clustering-like gaps)\n");
  console.log("| Workload | C | " + Object.keys(policies).join(" | ") + " |");
  console.log("|---|---|" + Object.keys(policies).map(() => "---").join("|") + "|");
  for (const [name, set] of Object.entries(tests)) for (const c of CS) {
    const cells = Object.values(policies).map((f) => (set.reduce((s, w) => { const p = f(c); return s + walk(w.log, w.task, c, p.choose, null, p.onRef); }, 0) / set.length).toFixed(1));
    console.log(`| ${name} | ${c} | ${cells.join(" | ")} |`);
  }
  console.log(`\nweights: [${model.weights.map((v) => +v.toFixed(5)).join(", ")}]\nbias: ${+model.bias.toFixed(5)}`);
}
