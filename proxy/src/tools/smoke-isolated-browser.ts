import {
  launchIsolatedBrowser,
  resolveRegisterProxy,
} from "../services/isolated-browser.ts";

const proxy = resolveRegisterProxy();
console.log("[smoke] proxy env:", proxy || "none (set REGISTER_PROXY for new IP)");

const s = await launchIsolatedBrowser({ headless: true, label: "smoke" });
console.log("[smoke] ok", {
  id: s.id.slice(0, 8),
  ip: s.egressIp,
  chrome: s.fingerprint.chromeVersion,
  vp: s.fingerprint.viewport,
  proxy: s.proxy?.server || "direct",
});
await s.close();
console.log("[smoke] wiped");
