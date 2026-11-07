// The learned eviction policy, shared by the service worker, the popup and
// the training scripts in model/.
//
// Tabs play the role of pages: every time a tab is opened or switched to is
// one "reference", the limit on awake tabs is the memory size C, and
// reloading a sleeping tab is a page fault. Time is counted in references.
//
// When a tab has to sleep, every tab that may sleep is described by 13
// features: its own history (the first eight, as in the Python project), where
// it stands among the other candidates (recency and use-count rank, recent
// uses) and its task (whether it belongs to the task you're on, and how long
// since that task was used). A linear model scores them and the highest
// score sleeps. The model is trained listwise to pick the tab Belady's OPT
// would pick, with DAgger so it learns from the situations its own choices
// lead to, and calibrated so its score is the probability that the tab won't
// be needed within the next 2C switches. See model/README.md.

export const FEATURES = ["age", "count", "gap1", "gap2", "gap3", "mean_gap", "age_over_gap", "has_gap",
  "recency_rank", "count_rank", "recent_uses", "same_task", "task_age"];

// Trained by model/train.mjs on synthetic task-structured browsing.
export const PRETRAINED = {
  weights: [0.7792, -0.65517, -0.05026, -0.11222, -0.197, 0.48878, 0.33429, 1.52744, 0.56915, 1.03191, 0.18516,
    -1.14465, -0.09716],
  bias: -0.37732,
  source: "pretrained",
  trainedOn: 0,
};

// A model the current features can use (models saved by older versions had 8 weights).
export const usable = (model) => !!model && Array.isArray(model.weights) && model.weights.length === FEATURES.length;

// --- per-tab history --------------------------------------------------------

export function newMeta() {
  return { last: 0, count: 0, g: [], gsum: 0 };
}

export function touch(meta, t) {
  if (meta.count > 0) {
    const gap = t - meta.last;
    meta.g.unshift(gap);
    if (meta.g.length > 3) meta.g.length = 3;
    meta.gsum += gap;
  }
  meta.count += 1;
  meta.last = t;
}

// The tab's own history: same feature row as Meta.row in the Python project.
export function pageFeatures(meta, t, c) {
  const age = Math.max(0, t - meta.last);
  const fAge = Math.log1p(age / c);
  const nGaps = meta.count - 1;
  const gaps = [0, 1, 2].map((j) => (nGaps > j ? Math.log1p(meta.g[j] / c) : fAge));
  if (nGaps > 0) {
    const mean = meta.gsum / nGaps;
    return [fAge, Math.log1p(meta.count), ...gaps, Math.log1p(mean / c), Math.log1p(age) - Math.log1p(mean), 1];
  }
  return [fAge, Math.log1p(meta.count), ...gaps, Math.log1p(age / c), 0, 0];
}

// Where each candidate stands among the others, and its task.
//   ids: the tabs that may sleep; metaOf(id): their history; t: the clock
//   taskOf(id): the task a tab belongs to, if any; cur: the task you're on
//   taskLast(task): when any tab of that task was last used
export function contexts(ids, metaOf, t, taskOf = () => undefined, cur = undefined, taskLast = () => undefined) {
  const byLast = [...ids].sort((a, b) => metaOf(b).last - metaOf(a).last);
  const byCount = [...ids].sort((a, b) => metaOf(b).count - metaOf(a).count);
  const out = new Map();
  for (const id of ids) {
    const k = taskOf(id), tl = k === undefined ? undefined : taskLast(k);
    out.set(id, {
      n: ids.length, recency: byLast.indexOf(id), frequency: byCount.indexOf(id),
      sameTask: k !== undefined && k === cur ? 1 : 0,
      taskAge: t - (tl === undefined ? metaOf(id).last : tl),
    });
  }
  return out;
}

export function features(meta, t, c, ctx) {
  const n = ctx.n - 1 || 1;
  let u = meta.last, recent = 0;             // how many of its last four uses fell within 2C switches
  for (let j = 0; j <= Math.min(3, meta.count - 1); j++) {
    if (t - u <= 2 * c) recent++;
    if (j < meta.g.length) u -= meta.g[j];
  }
  return [...pageFeatures(meta, t, c), ctx.recency / n, ctx.frequency / n, recent / 4,
    ctx.sameTask, Math.log1p(Math.max(0, ctx.taskAge) / c)];
}

export function score(model, x) {
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * x[i];
  return 1 / (1 + Math.exp(-z));
}

// --- replaying a history -----------------------------------------------------

function nextUses(log) {
  const nxt = new Array(log.length);
  const seen = new Map();
  for (let t = log.length - 1; t >= 0; t--) {
    nxt[t] = seen.has(log[t]) ? seen.get(log[t]) : Infinity;
    seen.set(log[t], t);
  }
  return nxt;
}

const hasTask = (k) => k !== null && k !== undefined && !(typeof k === "number" && k < 0);

// Walks a reference log with c awake slots. At each eviction, choose(ids,
// ctx, metas, t, nextOf) names the tab that sleeps; seeEviction gets the same
// view first (for collecting training data). Returns the reloads: switches
// to a tab seen before that was asleep. task[t] is the task of the t-th
// switch, if known. onRef(p, t, view) sees every switch before it's handled.
export function walk(log, task, c, choose, seeEviction, onRef) {
  const metas = new Map(), res = new Set(), seen = new Set(), tabTask = new Map(), taskLast = new Map(), nextOf = new Map();
  const nxt = nextUses(log);
  let faults = 0;
  for (let t = 0; t < log.length; t++) {
    const p = log[t], k = task ? task[t] : null;
    if (hasTask(k)) { tabTask.set(p, k); taskLast.set(k, t); }
    const cur = hasTask(k) ? k : undefined;
    if (onRef) onRef(p, t, { metas, tabTask, taskLast, cur });
    if (!res.has(p)) {
      if (seen.has(p)) faults++;
      if (res.size >= c) {
        const ids = [...res];
        const ctx = contexts(ids, (q) => metas.get(q), t, (q) => tabTask.get(q), cur, (kk) => taskLast.get(kk));
        if (seeEviction) seeEviction(ids, ctx, metas, t, nextOf);
        const v = choose(ids, ctx, metas, t, nextOf);
        if (!res.has(v)) throw new Error("the policy chose a tab that isn't awake");
        res.delete(v);
      }
      res.add(p);
    }
    seen.add(p);
    nextOf.set(p, nxt[t]);
    if (!metas.has(p)) metas.set(p, newMeta());
    touch(metas.get(p), t);
  }
  return faults;
}

export const optChoice = (ids, ctx, metas, t, nextOf) => ids.reduce((a, b) => (nextOf.get(a) >= nextOf.get(b) ? a : b));
export const lruChoice = (ids, ctx, metas) => ids.reduce((a, b) => (metas.get(a).last <= metas.get(b).last ? a : b));
export const modelChoice = (model, c) => (ids, ctx, metas, t) => {
  let best = null, top = -Infinity;
  for (const q of ids) {
    const s = score(model, features(metas.get(q), t, c, ctx.get(q)));
    if (s > top) { top = s; best = q; }
  }
  return best;
};

// Reloads on a history under LRU and under a model that always decides.
export function replay(log, task, c, model) {
  return { lruFaults: walk(log, task, c, lruChoice), modelFaults: walk(log, task, c, modelChoice(model, c)) };
}

// --- training -------------------------------------------------------------------

function sampleOf(list, n, rand) {
  if (list.length <= n) return list;
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// Every eviction the policy faces, with the residents OPT would pick there.
function evictions(strings, cs, policyFor) {
  const groups = [];
  for (const { log, task } of strings) for (const c of cs) {
    walk(log, task, c, policyFor(c), (ids, ctx, metas, t, nextOf) => {
      const far = Math.max(...ids.map((q) => nextOf.get(q)));
      groups.push({ X: ids.map((q) => features(metas.get(q), t, c, ctx.get(q))), pos: ids.map((q) => (nextOf.get(q) === far ? 1 : 0)), far, t, c,
        y: ids.map((q) => (nextOf.get(q) - t > 2 * c ? 1 : 0)) });
    });
  }
  return groups;
}

function standardize(Xs) {
  const d = Xs[0].length, n = Xs.length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of Xs) x.forEach((v, j) => (mu[j] += v / n));
  for (const x of Xs) x.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  return { mu, sd: sd.map((v) => Math.sqrt(v) + 1e-9) };
}

// Conditional logit: at each eviction, a softmax over the residents should put
// its weight on the ones OPT would pick. Gradient descent on standardized features.
export function fitListwise(groups, { l2 = 1e-3, iters = 600, lr = 0.3 } = {}) {
  const { mu, sd } = standardize(groups.flatMap((g) => g.X));
  const d = mu.length;
  const Z = groups.map((g) => g.X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j])));
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const grad = new Array(d).fill(0);
    groups.forEach((g, gi) => {
      const s = Z[gi].map((z) => z.reduce((a, v, j) => a + w[j] * v, 0)), m = Math.max(...s);
      const e = s.map((v) => Math.exp(v - m)), tot = e.reduce((a, v) => a + v, 0);
      const totPos = e.reduce((a, v, i) => a + (g.pos[i] ? v : 0), 0);
      Z[gi].forEach((z, i) => {
        const coef = e[i] / tot - (g.pos[i] ? e[i] / totPos : 0);
        z.forEach((v, j) => (grad[j] += coef * v));
      });
    });
    w = w.map((v, j) => v - lr * (grad[j] / groups.length + l2 * v));
  }
  return w.map((v, j) => v / sd[j]);
}

// Platt scaling: the probability that a tab won't be needed within 2C
// switches is sigmoid(a * (w . x) + b). The order of the tabs doesn't change.
function calibrate(weights, groups) {
  const raw = [], y = [];
  for (const g of groups) g.X.forEach((x, i) => { raw.push(x.reduce((t, v, j) => t + weights[j] * v, 0)); y.push(g.y[i]); });
  const mu = raw.reduce((t, v) => t + v, 0) / raw.length;
  const sd = Math.sqrt(raw.reduce((t, v) => t + (v - mu) ** 2, 0) / raw.length) || 1;
  const s = raw.map((v) => (v - mu) / sd);
  let a = 1, b = 0;
  for (let it = 0; it < 1000; it++) {
    let ga = 0, gb = 0;
    s.forEach((v, i) => { const p = 1 / (1 + Math.exp(-(a * v + b))); ga += (p - y[i]) * v; gb += p - y[i]; });
    a -= 0.5 * ga / s.length;
    b -= 0.5 * gb / s.length;
  }
  if (!(a > 0)) a = 1e-3;                     // never flip the order
  return { weights: weights.map((w) => (a / sd) * w), bias: b - (a * mu) / sd };
}

// DAgger (Ross et al. 2011; Parrot, Liu et al. 2020): start from OPT's own
// evictions, then repeatedly let the current model run, add the evictions it
// faces with OPT's answer for each, and refit.
//   strings: [{ log, task }]   cs: limits to train for
export function trainModel(strings, cs, { rounds = 3, perRound = 6000, rand = Math.random, iters = 600 } = {}) {
  let groups = sampleOf(evictions(strings, cs, () => optChoice), perRound, rand);
  let w = fitListwise(groups, { iters });
  for (let r = 0; r < rounds; r++) {
    const m = { weights: w, bias: 0 };
    groups = groups.concat(sampleOf(evictions(strings, cs, (c) => modelChoice(m, c)), perRound, rand));
    w = fitListwise(groups, { iters });
  }
  return { ...calibrate(w, groups), evictions: groups.length };
}
