// Task clusters: groups open tabs by what you are doing with them.
//
// Each tab becomes a bag of words from its title, site name and address,
// plus topic tags from a small built-in word list (so "flights" and
// "hotels" both count as travel). Words are weighted by TF-IDF over the open
// tabs, so words every tab shares count for nothing. Tabs are then merged
// bottom-up (average-linkage clustering) while their cosine similarity stays
// above a threshold. A tab opened from another tab gets a bonus, since you
// usually open links for the job you are on. Everything runs locally.

const STOP = new Set(`a an and are as at be by for from has have how in into is it its of on or that the this to was what when where which who why will with you your
  www com org net edu gov co in uk io app html htm php aspx index home page new tab untitled welcome official site online free best top
  login sign signin log account search results result watch view open read more get one two all about our us my me de en`.split(/\s+/));

const TOPICS = {
  travel: "flight flights airline airlines airport hotel hotels booking trip travel holiday vacation visa resort stay goa beach tour train ticket tickets itinerary airbnb makemytrip expedia skyscanner",
  shopping: "cart buy price prices deal deals shop shopping amazon flipkart myntra order product laptop laptops phone phones offer sale compare checkout",
  coding: "python javascript java code coding github stackoverflow error api docs documentation npm react function library tutorial programming bug compile git linux",
  study: "course courses lecture lectures notes assignment exam exams quiz university college syllabus study class module chapter textbook moodle coursera udemy",
  sports: "cricket cricbuzz espncricinfo football match score scores league ipl fifa player players highlights tournament",
  food: "recipe recipes cooking food dinner lunch breakfast cook ingredients restaurant zomato swiggy",
  watch: "movie movies film films netflix trailer series episode season imdb prime hotstar music spotify song songs playlist video videos youtube",
  work: "inbox mail gmail outlook calendar meeting meet zoom teams slack docs sheet sheets slides drive jira notion",
  news: "news headlines breaking politics election weather forecast",
  money: "bank banking stock stocks invest investing market crypto loan tax upi payment",
};
const TOPIC_OF = new Map();
for (const [topic, words] of Object.entries(TOPICS)) for (const w of words.split(" ")) if (!TOPIC_OF.has(w)) TOPIC_OF.set(w, topic);

const SITE_WORDS = new Set("com org net edu gov co in uk io ac www m app web".split(" "));

function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w));
}

// Bag of weighted terms for one tab. Topic tags come from the title and the
// site name only: addresses often hold user names and ids, not topics.
export function terms(title, url) {
  const bag = new Map(), topics = new Map();
  const add = (t, w) => bag.set(t, (bag.get(t) || 0) + w);
  const tag = (w) => {
    const topic = TOPIC_OF.get(w) || TOPIC_OF.get(stem(w));
    if (topic) topics.set(topic, (topics.get(topic) || 0) + 1);
  };
  let host = "", path = "";
  try { const u = new URL(url); host = u.hostname; path = decodeURIComponent(u.pathname); } catch { /* not a URL */ }
  const ip = /^[\d.]+$|^localhost$|^\[/.test(host);
  const site = ip ? [host] : host.split(".").filter((p) => p && !SITE_WORDS.has(p));
  const name = site.length ? site[site.length - 1] : "";
  if (name) { add(stem(name), 1.5); tag(name); }   // same site: a strong hint
  for (const w of site.slice(0, -1)) if (!STOP.has(w)) { add(stem(w), 0.5); tag(w); }
  for (const w of words(title || "")) { add(stem(w), 1); tag(w); }
  for (const w of words(path.replace(/[-_/+.]/g, " ")).slice(0, 8)) add(stem(w), 0.4);
  for (const [topic, k] of topics) add("#" + topic, Math.min(2.4, 1.2 * k));
  return bag;
}

function vectors(bags) {
  const n = bags.length, df = new Map();
  for (const b of bags) for (const t of b.keys()) df.set(t, (df.get(t) || 0) + 1);
  return bags.map((b) => {
    const v = new Map();
    let norm = 0;
    for (const [t, tf] of b) {
      const w = tf * Math.log((n + 1) / df.get(t));   // a word every tab has weighs almost nothing
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, w] of a) { const o = b.get(t); if (o) s += w * o; }
  return s;
}

const LABEL = { travel: "Travel", shopping: "Shopping", coding: "Coding", study: "Study", sports: "Sports",
  food: "Food", watch: "Watching", work: "Work", news: "News", money: "Money" };

function nice(t) {
  const w = t.replace(/^#/, "");
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// tabs: [{ id, title, url, openerTabId }] (ordinary websites only).
// Returns clusters of two or more tabs: [{ ids, label, words }], biggest first.
export function clusterTabs(tabs, threshold = 0.18) {
  if (tabs.length < 2) return [];
  const bags = tabs.map((t) => terms(t.title, t.url));
  const vec = vectors(bags);
  const n = tabs.length, index = new Map(tabs.map((t, i) => [t.id, i]));
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = cosine(vec[i], vec[j]);
      if (tabs[i].openerTabId === tabs[j].id || tabs[j].openerTabId === tabs[i].id) s += 0.3;
      sim[i][j] = sim[j][i] = s;
    }
  }
  // average-linkage agglomerative clustering
  let groups = tabs.map((_, i) => [i]);
  for (;;) {
    let best = threshold, bi = -1, bj = -1;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        let s = 0;
        for (const i of groups[a]) for (const j of groups[b]) s += sim[i][j];
        s /= groups[a].length * groups[b].length;
        if (s > best) { best = s; bi = a; bj = b; }
      }
    }
    if (bi < 0) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  return groups.filter((g) => g.length >= 2).map((g) => {
    // only words at least two tabs of this cluster share can name it
    const weight = new Map(), members = new Map();
    for (const i of g) for (const [t, w] of vec[i]) {
      weight.set(t, (weight.get(t) || 0) + w);
      members.set(t, (members.get(t) || 0) + 1);
    }
    const ranked = [...weight].filter(([t]) => members.get(t) >= 2).sort((a, b) => b[1] - a[1]);
    const topic = ranked.find(([t]) => t.startsWith("#") && members.get(t) / g.length >= 0.6);
    const plain = ranked.filter(([t]) => !t.startsWith("#") && !/^[\d.]+$/.test(t)).slice(0, 3).map(([t]) => nice(t));
    const label = topic ? [LABEL[topic[0].slice(1)], ...plain.slice(0, 1)].join(" · ") : plain.slice(0, 2).join(" · ") || "Task";
    return { ids: g.map((i) => tabs[i].id), label, words: plain };
  }).sort((a, b) => b.ids.length - a.ids.length || index.get(a.ids[0]) - index.get(b.ids[0]));
}
