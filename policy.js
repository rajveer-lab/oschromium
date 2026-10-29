// The learned eviction policy, shared by the service worker and the popup.
//
// Tabs play the role of pages: every time a tab is opened or switched to is
// one "reference", the limit on awake tabs is the memory size C, and
// reloading a sleeping tab is a page fault. Time is counted in references,
// so the model trained on page traces applies to tabs unchanged.

export const FEATURES = ["age", "count", "gap1", "gap2", "gap3", "mean_gap", "age_over_gap", "has_gap"];

// Logistic regression trained offline to imitate Belady's OPT
// (label: next use more than 2 x C references away).
export const PRETRAINED = {
  weights: [0.2308512859375677, 0.08614118576060052, 0.1478872605910588, 0.22419167629105455,
    0.2519189703719372, 0.16225389771383122, -0.2005505162180408, -1.7726282540109795],
  bias: -0.2526316818701606,
  source: "pretrained",
  trainedOn: 0,
};

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

// Same feature row as Meta.row in the Python project.
export function features(meta, t, c) {
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

export function score(model, x) {
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * x[i];
  return 1 / (1 + Math.exp(-z));
}

// --- learning from your own history ----------------------------------------

function nextUses(log) {
  const nxt = new Array(log.length);
  const seen = new Map();
  for (let t = log.length - 1; t >= 0; t--) {
    nxt[t] = seen.has(log[t]) ? seen.get(log[t]) : Infinity;
    seen.set(log[t], t);
  }
  return nxt;
}

// Replay the reference log under OPT with c slots. At every OPT eviction,
// record each resident tab's features (past only) and whether OPT knows it
// is not needed within horizon * c references.
export function optDataset(log, c, horizon = 2, maxPerEviction = 16) {
  const nxt = nextUses(log);
  const metas = new Map();
  const resident = new Map();      // id -> its next use
  const X = [], y = [];
  for (let t = 0; t < log.length; t++) {
    const p = log[t];
    if (!resident.has(p) && resident.size >= c) {
      const ids = [...resident.keys()];
      const sample = ids.length > maxPerEviction ? shuffle(ids).slice(0, maxPerEviction) : ids;
      for (const q of sample) {
        X.push(features(metas.get(q), t, c));
        y.push(resident.get(q) - t > horizon * c ? 1 : 0);
      }
      let victim = null, far = -1;
      for (const [q, n] of resident) if (n > far) { far = n; victim = q; }
      resident.delete(victim);
    }
    resident.set(p, nxt[t]);
    if (!metas.has(p)) metas.set(p, newMeta());
    touch(metas.get(p), t);
  }
  return { X, y };
}

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// Logistic regression by Newton's method with a small L2 penalty.
export function fitLogReg(X, y, l2 = 1e-3, iters = 30) {
  const n = X.length, d = X[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / n));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) + 1e-9;
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  let w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let s = 0;
      for (let j = 0; j <= d; j++) s += w[j] * z[j];
      const p = 1 / (1 + Math.exp(-s)), q = p * (1 - p);
      for (let j = 0; j <= d; j++) {
        g[j] += (p - y[i]) * z[j] / n;
        for (let k = 0; k <= d; k++) H[j][k] += q * z[j] * z[k] / n;
      }
    }
    for (let j = 0; j <= d; j++) { H[j][j] += l2; if (j > 0) g[j] += l2 * w[j]; }
    const step = solve(H, g);
    let big = 0;
    for (let j = 0; j <= d; j++) { w[j] -= step[j]; big = Math.max(big, Math.abs(step[j])); }
    if (big < 1e-8) break;
  }
  const weights = w.slice(1).map((v, j) => v / sd[j]);
  const bias = w[0] - w.slice(1).reduce((s, v, j) => s + v * mu[j] / sd[j], 0);
  return { weights, bias };
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const v = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / v;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

// Replay a log and count reloads (faults on tabs seen before) for LRU and
// for a model that evicts the highest-scoring resident tab.
export function replay(log, c, model) {
  const lru = new Map(), seen = new Set();
  let lruFaults = 0, modelFaults = 0;
  const metas = new Map(), res = new Set();
  for (let t = 0; t < log.length; t++) {
    const p = log[t], old = seen.has(p);
    seen.add(p);
    if (lru.has(p)) lru.delete(p);
    else {
      if (old) lruFaults++;
      if (lru.size >= c) lru.delete(lru.keys().next().value);
    }
    lru.set(p, 1);
    if (!res.has(p)) {
      if (old) modelFaults++;
      if (res.size >= c) {
        let v = null, best = -1;
        for (const q of res) {
          const s = score(model, features(metas.get(q), t, c));
          if (s > best) { best = s; v = q; }
        }
        res.delete(v);
      }
      res.add(p);
    }
    if (!metas.has(p)) metas.set(p, newMeta());
    touch(metas.get(p), t);
  }
  return { lruFaults, modelFaults };
}
