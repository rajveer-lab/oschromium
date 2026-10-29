// Predictive wake: notices when the mouse leaves the page fast through the
// top edge, which is how you head for the tab bar, and tells Smart Tab Saver
// so it can wake the sleeping tab you're most likely to open next. Only the
// fact that you're heading up is sent; nothing about the page is.
(() => {
  const trail = [];               // recent [time, y] samples
  let sent = -Infinity;
  document.addEventListener("mousemove", (e) => {
    const t = performance.now();
    trail.push([t, e.clientY]);
    while (trail.length && t - trail[0][0] > 150) trail.shift();
  }, { passive: true, capture: true });
  window.addEventListener("mouseout", (e) => {
    const now = performance.now();
    while (trail.length && now - trail[0][0] > 150) trail.shift();     // only the last moment counts
    if (e.relatedTarget || e.clientY > 8 || trail.length < 2) return;   // not leaving through the top
    const [t0, y0] = trail[0], [t1, y1] = trail[trail.length - 1];
    const speed = (y0 - y1) / Math.max(1, t1 - t0);                    // px per ms, upward
    if (speed < 0.5 || now - sent < 3000) return;
    sent = now;
    try { chrome.runtime.sendMessage({ type: "intent" }).catch(() => {}); } catch (err) { /* extension reloaded */ }
  }, true);
})();
