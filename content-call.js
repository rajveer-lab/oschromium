// Call mode, page side. Runs in the page itself on video-call sites (Meet,
// Zoom, Teams, ...) and notices when the page turns your microphone or camera
// on or off. It never touches the audio or video: it only counts how many
// mic/camera tracks are live and passes on "call started" / "call ended".
(() => {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function" || md.__smartTabSaver) return;
  Object.defineProperty(md, "__smartTabSaver", { value: true });
  const live = new Set();
  let was = false;
  const report = () => {
    for (const t of live) if (t.readyState === "ended") live.delete(t);
    const now = live.size > 0;
    if (now !== was) {
      was = now;
      window.postMessage({ __smartTabSaver: "call", live: now }, location.origin === "null" ? "*" : location.origin);
    }
  };
  const watch = (stream) => {
    for (const t of stream.getTracks()) {
      live.add(t);
      t.addEventListener("ended", report);
      const stop = t.stop;
      t.stop = function () { const r = stop.apply(this, arguments); live.delete(t); report(); return r; };
    }
    report();
    return stream;
  };
  const getUserMedia = md.getUserMedia;
  md.getUserMedia = function (constraints) {
    return getUserMedia.call(this, constraints).then(watch);
  };
  setInterval(report, 5000);     // tracks can also end without telling anyone
  window.addEventListener("pagehide", () => { live.clear(); report(); });
})();
