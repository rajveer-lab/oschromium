// Green mode: service workers can't read the battery, so this hidden page
// does and reports whether the computer is plugged in.
(async () => {
  const send = (msg) => chrome.runtime.sendMessage({ type: "battery", ...msg }).catch(() => {});
  if (!navigator.getBattery) { send({ unsupported: true }); return; }
  const b = await navigator.getBattery();
  const report = () => send({ charging: b.charging, level: b.level });
  b.addEventListener("chargingchange", report);
  b.addEventListener("levelchange", report);
  report();
})();
