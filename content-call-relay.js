// Call mode, extension side: passes "call started" / "call ended" from
// content-call.js (which runs inside the page) on to Smart Tab Saver.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__smartTabSaver !== "call") return;
  try { chrome.runtime.sendMessage({ type: "call", live: !!e.data.live }).catch(() => {}); } catch (err) { /* extension reloaded */ }
});
