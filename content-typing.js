// Tells Smart Tab Saver when you have typed into a form on this page, so the
// tab is never put to sleep with unsaved text. Nothing you type is read or sent.
(() => {
  let dirty = false;
  const set = (v) => {
    if (dirty === v) return;
    dirty = v;
    try { chrome.runtime.sendMessage({ type: "typing", dirty: v }); } catch (e) { /* extension reloaded */ }
  };
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && el.type !== "password" && el.type !== "search") set(true);
  }, true);
  document.addEventListener("submit", () => set(false), true);
})();
