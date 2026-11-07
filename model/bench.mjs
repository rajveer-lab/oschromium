// Test bench for the eviction model: replays reference strings under OPT, LRU,
// the shipped model and candidate models, the way the extension decides.
// Models are trained on one set of strings and scored on different ones.
//   node model/bench.mjs

// Experiments behind the model in policy.js (see model/README.md). "Shipped
// model" here is the model before the change: 8 features, binary labels.
import { newMeta, touch, pageFeatures as features } from "../policy.js";
const PRETRAINED = { weights: [0.2308512859375677, 0.08614118576060052, 0.1478872605910588, 0.22419167629105455,
  0.2519189703719372, 0.16225389771383122, -0.2005505162180408, -1.7726282540109795], bias: -0.2526316818701606 };
import { taskBrowsing, sweepBrowsing, cyclic, uniform, rng } from "./workloads.mjs";

const nextUses = (log) => {
  const nxt = new Array(log.length), seen = new Map();
  for (let t = log.length - 1; t >= 0; t--) { nxt[t] = seen.has(log[t]) ? seen.get(log[t]) : Infinity; seen.set(log[t], t); }
  return nxt;
};

// --- features ----------------------------------------------------------------

// v1: the shipped eight features of one tab on its own.
const v1 = (m, t, c) => features(m, t, c);

// v2: adds where the tab stands among the tabs that could sleep: its recency
// rank (0 = most recent, 1 = least recent), its use-count rank, and how many
// of its last four uses fell in the last 2C switches.
function v2(m, t, c, ctx) {
  const x = features(m, t, c);
  const n = ctx.n - 1 || 1;
  let u = m.last, recent = 0;
  for (let j = 0; j <= Math.min(3, m.count - 1); j++) {
    if (t - u <= 2 * c) recent++;
    if (j < m.g.length) u -= m.g[j];
  }
  return [...x, ctx.recency / n, ctx.frequency / n, recent / 4];
}

// v3: adds the tab's task: whether it belongs to the task of the tab you're
// on, and how long since any tab of its task was used.
function v3(m, t, c, ctx) {
  return [...v2(m, t, c, ctx), ctx.sameTask, Math.log1p(ctx.taskAge / c)];
}

// Task bookkeeping as the switches go by (tabs without a task get none).
function tasker(task) {
  const tk = { of: new Map(), last: new Map(), cur: undefined, t: 0 };
  tk.ref = (p, t, i) => {
    const k = task ? task[i] : -1;
    if (k >= 0) { tk.of.set(p, k); tk.last.set(k, t); }
    tk.cur = k >= 0 ? k : undefined;
    tk.t = t;
  };
  return tk;
}

function context(res, metas, tk) {       // ranks among the residents, and their tasks
  const ids = [...res];
  const byLast = [...ids].sort((a, b) => metas.get(b).last - metas.get(a).last);
  const byCount = [...ids].sort((a, b) => metas.get(b).count - metas.get(a).count);
  const out = new Map();
  for (const id of ids) {
    const o = { n: ids.length, recency: byLast.indexOf(id), frequency: byCount.indexOf(id) };
    if (tk) {
      const k = tk.of.get(id);
      o.sameTask = k !== undefined && k === tk.cur ? 1 : 0;
      o.taskAge = k === undefined ? tk.t - metas.get(id).last : tk.t - (tk.last.get(k) ?? metas.get(id).last);
    }
    out.set(id, o);
  }
  return out;
}

const dot = (w, b, x) => x.reduce((s, v, i) => s + w[i] * v, b);

// --- policies ------------------------------------------------------------------

// Every policy sees the same thing the extension does: the residents and their
// histories at the moment a tab has to sleep.
function simulate(log, c, choose, task) {
  const metas = new Map(), res = new Set(), seen = new Set(), tk = tasker(task);
  const state = { faults: 0, t: 0 };
  const nxt = nextUses(log);
  const nextOf = new Map();
  for (let t = 0; t < log.length; t++) {
    const p = log[t];
    state.t = t;
    tk.ref(p, t, t);
    if (!res.has(p)) {
      if (seen.has(p)) { state.faults++; choose.onFault && choose.onFault(p, t); }
      if (res.size >= c) {
        const v = choose(res, metas, t, c, nextOf, tk);
        if (!res.has(v)) throw new Error("policy chose a tab that isn't awake");
        res.delete(v);
        choose.onEvict && choose.onEvict(v, t);
      }
      res.add(p);
    }
    choose.onRef && choose.onRef(p, t, metas, tk);
    seen.add(p);
    nextOf.set(p, nxt[t]);
    if (!metas.has(p)) metas.set(p, newMeta());
    touch(metas.get(p), t);
  }
  return state.faults;
}

const OPT = (res, metas, t, c, nextOf) => [...res].reduce((a, b) => (nextOf.get(a) >= nextOf.get(b) ? a : b));
const LRU = (res, metas) => [...res].reduce((a, b) => (metas.get(a).last <= metas.get(b).last ? a : b));

function argmaxPolicy(featFn, w, b) {
  return (res, metas, t, c, nextOf, tk) => {
    const ctx = context(res, metas, tk);
    let best = null, bs = -Infinity;
    for (const q of res) { const s = dot(w, b, featFn(metas.get(q), t, c, ctx.get(q))); if (s > bs) { bs = s; best = q; } }
    return best;
  };
}

// The extension's own rule (background.js pickVictim and regret): trust the
// model with probability wModel, and only if its best probability clears the
// threshold; otherwise LRU. A tab coming back soon after it slept counts
// against whoever chose it.
function hybridPolicy(featFn, w, b, seed, threshold = 0.5) {
  const r = rng(seed);
  let wModel = 0.5;
  const hModel = new Map(), hLRU = new Map();
  let c0 = 8;
  const choose = (res, metas, t, c, nextOf, tk) => {
    c0 = c;
    let pick = null, by = "lru";
    if (r() < wModel) {
      const ctx = context(res, metas, tk);
      let best = null, bs = -1;
      for (const q of res) { const s = 1 / (1 + Math.exp(-dot(w, b, featFn(metas.get(q), t, c, ctx.get(q))))); if (s > bs) { bs = s; best = q; } }
      if (bs >= threshold) { pick = best; by = "model"; }
    }
    if (pick === null) pick = LRU(res, metas);
    const h = by === "model" ? hModel : hLRU;
    h.set(pick, t);
    if (h.size > c) h.delete([...h.entries()].sort((a, b2) => a[1] - b2[1])[0][0]);
    return pick;
  };
  choose.onFault = (p, t) => {
    const d = Math.pow(0.005, 1 / c0);
    for (const [h, modelWrong] of [[hModel, true], [hLRU, false]]) {
      if (!h.has(p)) continue;
      const reward = Math.pow(d, t - h.get(p));
      h.delete(p);
      let wm = wModel, wl = 1 - wModel;
      if (modelWrong) wl *= Math.exp(0.45 * reward); else wm *= Math.exp(0.45 * reward);
      wModel = Math.min(0.98, Math.max(0.02, wm / (wm + wl)));
      return;
    }
  };
  return choose;
}

// --- training ------------------------------------------------------------------

// At every OPT eviction: each resident's features, whether its next use is
// more than 2C away (binary label), and which residents OPT would pick (the
// ones used furthest in the future, for the listwise model).
function dataset(strings, cs, featFn) {
  const rows = [], groups = [];
  for (const { log, task } of strings) for (const c of cs) {
    const nxt = nextUses(log), metas = new Map(), res = new Map(), tk = tasker(task);
    for (let t = 0; t < log.length; t++) {
      const p = log[t];
      tk.ref(p, t, t);
      if (!res.has(p) && res.size >= c) {
        const ids = [...res.keys()], ctx = context(new Set(ids), metas, tk);
        const far = Math.max(...ids.map((q) => res.get(q)));
        const g = { X: [], pos: [] };
        for (const q of ids) {
          const x = featFn(metas.get(q), t, c, ctx.get(q));
          rows.push({ x, y: res.get(q) - t > 2 * c ? 1 : 0 });
          g.X.push(x);
          g.pos.push(res.get(q) === far ? 1 : 0);
        }
        groups.push(g);
        let v = null;
        for (const q of ids) if (res.get(q) === far) { v = q; break; }
        res.delete(v);
      }
      res.set(p, nxt[t]);
      if (!metas.has(p)) metas.set(p, newMeta());
      touch(metas.get(p), t);
    }
  }
  return { rows, groups };
}

// Reuse-distance regression (the "predicted next arrival" of Lykouris and
// Vassilvitskii): least squares on log(1 + distance / C), capped for tabs
// never used again. Sleep the tab predicted to be needed last.
const CAP = 64;
function datasetReuse(strings, cs, featFn) {
  const X = [], y = [];
  for (const { log } of strings) for (const c of cs) {
    const nxt = nextUses(log), metas = new Map(), res = new Map();
    for (let t = 0; t < log.length; t++) {
      const p = log[t];
      if (!res.has(p) && res.size >= c) {
        const ids = [...res.keys()], ctx = context(new Set(ids), metas);
        for (const q of ids) {
          X.push(featFn(metas.get(q), t, c, ctx.get(q)));
          y.push(Math.log1p(Math.min(res.get(q) - t, CAP * c) / c));
        }
        let v = null, far = -1;
        for (const q of ids) if (res.get(q) > far) { far = res.get(q); v = q; }
        res.delete(v);
      }
      res.set(p, nxt[t]);
      if (!metas.has(p)) metas.set(p, newMeta());
      touch(metas.get(p), t);
    }
  }
  return { X, y };
}

function fitRidge(X, y, l2 = 1e-2) {
  const { mu, sd } = standardize(X);
  const d = mu.length, A = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0)), b = new Array(d + 1).fill(0);
  X.forEach((x, i) => {
    const z = [1, ...x.map((v, j) => (v - mu[j]) / sd[j])];
    for (let j = 0; j <= d; j++) { b[j] += z[j] * y[i]; for (let k = 0; k <= d; k++) A[j][k] += z[j] * z[k]; }
  });
  for (let j = 1; j <= d; j++) A[j][j] += l2 * X.length;
  const w = gauss(A, b);
  return unscale(w.slice(1), w[0], mu, sd);
}

function gauss(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

// Follow whichever of two policies has had fewer reloads lately (Chledowski et
// al. 2021). Both run as shadows on the same switches; the real choice is made
// by the current leader. Reload counts fade by half every `half` switches.
function switchPolicy(chooseA, chooseB, c, half = 100) {
  const shadows = [chooseA, chooseB].map((f) => ({ f, res: new Set(), score: 0 }));
  const fade = Math.pow(0.5, 1 / half);
  const choose = (res, metas, t, cc, nextOf, tk) => {
    const lead = shadows[0].score <= shadows[1].score ? shadows[0] : shadows[1];
    return lead.f(res, metas, t, cc, nextOf, tk);
  };
  choose.onRef = (p, t, metas, tk) => {
    for (const s of shadows) {
      s.score *= fade;
      if (!s.res.has(p)) {
        if (metas.has(p)) s.score += 1;
        if (s.res.size >= c) s.res.delete(s.f(s.res, metas, t, c, null, tk));
        s.res.add(p);
      }
    }
  };
  return choose;
}

// DAgger (Ross et al. 2011; used for caching by Parrot, Liu et al. 2020):
// run a policy on the strings and, at every eviction it faces, record what
// OPT would sleep in that same situation (the residents used furthest in the
// future). Training on these teaches the model to recover from its own
// choices, not only to copy OPT along OPT's own path.
function rollout(strings, cs, featFn, policyFor) {
  const groups = [];
  for (const { log, task } of strings) for (const c of cs) {
    const nxt = nextUses(log), metas = new Map(), res = new Set(), nextOf = new Map(), tk = tasker(task);
    const choose = policyFor(c);
    for (let t = 0; t < log.length; t++) {
      const p = log[t];
      tk.ref(p, t, t);
      if (!res.has(p) && res.size >= c) {
        const ids = [...res], ctx = context(res, metas, tk);
        const far = Math.max(...ids.map((q) => nextOf.get(q)));
        groups.push({ X: ids.map((q) => featFn(metas.get(q), t, c, ctx.get(q))), pos: ids.map((q) => (nextOf.get(q) === far ? 1 : 0)) });
        res.delete(choose(res, metas, t, c, nextOf, tk));
      }
      res.add(p);
      nextOf.set(p, nxt[t]);
      if (!metas.has(p)) metas.set(p, newMeta());
      touch(metas.get(p), t);
    }
  }
  return groups;
}

function standardize(Xs) {
  const d = Xs[0].length, n = Xs.length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of Xs) x.forEach((v, j) => (mu[j] += v / n));
  for (const x of Xs) x.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  return { mu, sd: sd.map((v) => Math.sqrt(v) + 1e-9) };
}

// Binary logistic regression (as the extension trains), by gradient descent.
function fitBinary(rows, l2 = 1e-3, iters = 400, lr = 0.5) {
  const { mu, sd } = standardize(rows.map((r) => r.x));
  const d = mu.length, Z = rows.map((r) => r.x.map((v, j) => (v - mu[j]) / sd[j]));
  let w = new Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    let gb = 0;
    rows.forEach((r, i) => { const p = 1 / (1 + Math.exp(-dot(w, b, Z[i]))); const e = p - r.y; gb += e; Z[i].forEach((v, j) => (g[j] += e * v)); });
    w = w.map((v, j) => v - lr * (g[j] / rows.length + l2 * v));
    b -= lr * gb / rows.length;
  }
  return unscale(w, b, mu, sd);
}

// Listwise (conditional logit): at each eviction, make the residents OPT would
// pick the most likely under a softmax over all residents.
function fitListwise(groups, l2 = 1e-3, iters = 400, lr = 0.5) {
  const { mu, sd } = standardize(groups.flatMap((g) => g.X));
  const d = mu.length;
  const Gz = groups.map((g) => ({ Z: g.X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j])), pos: g.pos }));
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const grad = new Array(d).fill(0);
    for (const g of Gz) {
      const s = g.Z.map((z) => dot(w, 0, z)), m = Math.max(...s), e = s.map((v) => Math.exp(v - m));
      const tot = e.reduce((a, v) => a + v, 0), totPos = e.reduce((a, v, i) => a + (g.pos[i] ? v : 0), 0);
      g.Z.forEach((z, i) => { const coef = e[i] / tot - (g.pos[i] ? e[i] / totPos : 0); z.forEach((v, j) => (grad[j] += coef * v)); });
    }
    w = w.map((v, j) => v - lr * (grad[j] / Gz.length + l2 * v));
  }
  return unscale(w, 0, mu, sd);
}

function unscale(w, b, mu, sd) {
  const weights = w.map((v, j) => v / sd[j]);
  return { weights, bias: b - w.reduce((s, v, j) => s + v * mu[j] / sd[j], 0) };
}

// --- run -------------------------------------------------------------------------

export { v3, tasker, rollout, context, simulate, OPT, LRU, argmaxPolicy, hybridPolicy, switchPolicy, dataset, datasetReuse, fitBinary, fitListwise, fitRidge, v1, v2 };

if (import.meta.url === `file://${process.argv[1]}`) {
  const train = [...Array(30)].flatMap((_, i) => [taskBrowsing(1 + i), sweepBrowsing(1001 + i)]);
  const test = {
    "task browsing": [...Array(30)].map((_, i) => taskBrowsing(101 + i)),
    "browsing + sweeps": [...Array(30)].map((_, i) => sweepBrowsing(2001 + i)),
    "cyclic loop, 10 tabs": [cyclic(0)],
    "uniform random, 12 tabs": [uniform(7)],
  };
  const CS = [4, 8, 12];
  console.time("train");
  const sample = (a, n, seed) => { const r = rng(seed); return a.length <= n ? a : a.map((v) => [r(), v]).sort((x, y) => x[0] - y[0]).slice(0, n).map((x) => x[1]); };
  const d1 = dataset(train, CS, v1), d2 = dataset(train, CS, v2);
  console.log(`training rows: ${d1.rows.length}, evictions: ${d2.groups.length} (sampled to 40000 / 8000)`);
  d1.rows = sample(d1.rows, 40000, 1); d2.rows = sample(d2.rows, 40000, 1); d2.groups = sample(d2.groups, 8000, 2);
  const models = {
    "shipped model": { f: v1, ...PRETRAINED },
    "binary, 8 features (retrained)": { f: v1, ...fitBinary(d1.rows) },
    "binary, 11 features": { f: v2, ...fitBinary(d2.rows) },
  };
  const dr = datasetReuse(train, CS, v2);
  const keep = sample([...dr.X.keys()], 120000, 3);
  models["reuse distance, 11 features"] = { f: v2, ...fitRidge(keep.map((i) => dr.X[i]), keep.map((i) => dr.y[i])) };
  console.timeEnd("train");
  for (const [name, set] of Object.entries(test)) {
    console.log(`\n== ${name} (reloads per string, mean over ${set.length})`);
    for (const c of CS) {
      const mean = (fn) => set.reduce((s, w) => s + fn(w.log), 0) / set.length;
      const row = { OPT: mean((l) => simulate(l, c, OPT)), LRU: mean((l) => simulate(l, c, LRU)) };
      for (const [m, M] of Object.entries(models)) {
        row[m + " alone"] = mean((l) => simulate(l, c, argmaxPolicy(M.f, M.weights, M.bias)));
        if (m === "shipped model" || m.startsWith("binary, 11")) row[m + " + fallback + guard"] = mean((l) => simulate(l, c, hybridPolicy(M.f, M.weights, M.bias, 42)));
        if (!m.startsWith("shipped") && !m.includes("8 features")) row[m + " + switch"] = mean((l) => simulate(l, c, switchPolicy(argmaxPolicy(M.f, M.weights, M.bias), LRU, c)));
      }
      console.log(`C=${c}:`, Object.entries(row).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(" | "));
    }
  }
  console.log("\nweights:", JSON.stringify(Object.fromEntries(Object.entries(models).map(([k, m]) => [k, { w: m.weights.map((v) => +v.toFixed(3)), b: +m.bias.toFixed(3) }]))));
}
