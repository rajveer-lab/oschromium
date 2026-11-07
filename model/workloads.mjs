// Reference strings (tab switches) for training and testing the eviction
// model, as described in the Review 3 report (section 13.1). Every
// generator is seeded, so a seed always gives the same string.

export function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const expo = (r, mean) => Math.max(1, Math.round(-mean * Math.log(1 - r())));

// Task-structured browsing: one task at a time, 2-6 tabs each, new tabs now
// and then, a Zipf-like favourite inside the task, back-and-forth between two
// tabs, bursts of about 22 switches, returns to earlier tasks (recent ones
// more likely) with probability 0.45, and two anchor tabs (mail, chat)
// checked on 6% of switches.
export function taskBrowsing(seed, n = 1200, opts = {}) {
  const r = rng(seed);
  const sweeps = opts.sweeps || false;
  let next = 2;                             // tabs 0 and 1 are the anchors
  const tasks = [];                         // most recent last
  const log = [], task = [];
  const newTask = () => {
    const k = 2 + Math.floor(r() * 5);
    const t = { tabs: Array.from({ length: k }, () => next++), id: tasks.length };
    tasks.push(t);
    return t;
  };
  let cur = newTask(), burst = expo(r, 22);
  while (log.length < n) {
    if (burst-- <= 0) {
      if (tasks.length > 1 && r() < 0.45) {
        const old = tasks.filter((t) => t !== cur);
        let i = old.length - 1;                // recent tasks more likely
        while (i > 0 && r() < 0.5) i--;
        cur = old[i];
        tasks.splice(tasks.indexOf(cur), 1);
        tasks.push(cur);
      } else cur = newTask();
      burst = expo(r, 22);
      if (sweeps && r() < 0.25) {             // compare 9-13 tabs one after another
        const m = 9 + Math.floor(r() * 5);
        const s = Array.from({ length: m }, () => next++);
        for (let pass = 0; pass < 2 && log.length < n; pass++) for (const p of s) if (log.length < n) { log.push(p); task.push(-1); }
      }
    }
    let p;
    const before = log[log.length - 2];
    if (r() < 0.06) p = r() < 0.6 ? 0 : 1;
    else if (r() < 0.05) { p = next++; cur.tabs.push(p); }
    else if (before !== undefined && before !== log[log.length - 1] && cur.tabs.includes(before) && r() < 0.35) p = before;   // back and forth
    else {
      let i = 0;                               // Zipf-like: earlier tabs of a task are favourites
      while (i < cur.tabs.length - 1 && r() < 0.55) i++;
      p = cur.tabs[i];
    }
    if (p === log[log.length - 1]) continue;
    log.push(p);
    task.push(p < 2 ? -2 : cur.id);
  }
  return { log, task };
}

export const sweepBrowsing = (seed, n = 1200) => taskBrowsing(seed, n, { sweeps: true });

export function cyclic(seed, n = 1200, k = 10) {
  return { log: Array.from({ length: n }, (_, i) => i % k), task: new Array(n).fill(0) };
}

export function uniform(seed, n = 1200, k = 12) {
  const r = rng(seed), log = [];
  while (log.length < n) {
    const p = Math.floor(r() * k);
    if (p !== log[log.length - 1]) log.push(p);
  }
  return { log, task: new Array(n).fill(0) };
}
