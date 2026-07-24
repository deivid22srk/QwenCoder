import fs from "fs";

const raw = fs
  .readFileSync(
    "data/route-capture/raw-2026-07-19T18-21-33-169Z.jsonl",
    "utf8",
  )
  .split(/\n+/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean) as any[];

// Window around signup attempts (52s - 70s from capture)
const window = raw.filter((e) => e.t >= 50000 && e.t <= 70000);

console.log("=== events 50s-70s (signup window) ===");
for (const e of window) {
  const u = String(e.url || "");
  if (
    !u.includes("google") &&
    !u.includes("aplus") &&
    !u.includes("doubleclick") &&
    !u.includes("gstatic") &&
    !u.includes("alicdn.com/img") &&
    !u.includes(".png") &&
    !u.includes(".css") &&
    !u.includes(".woff")
  ) {
    console.log(
      `\n[${e.t}] ${e.phase} ${e.method || ""} ${e.status || ""} ${u.slice(0, 200)}`,
    );
    if (e.postData) console.log("  post:", String(e.postData).slice(0, 400));
    if (e.bodyPreview && e.phase === "response") {
      const b = String(e.bodyPreview);
      // extract interesting tokens
      const tokens = [
        ...b.matchAll(/u_atoken[=:\"']([^\"'&\s]+)/gi),
        ...b.matchAll(/u_asig[=:\"']([^\"'&\s]+)/gi),
        ...b.matchAll(/aliyun_waf_\w+[=\"']([^\"']+)/gi),
        ...b.matchAll(/captchaVerifyParam[\"']?\s*[:=]\s*[\"']([^\"']+)/gi),
        ...b.matchAll(/certifyId[\"']?\s*[:=]\s*[\"']([^\"']+)/gi),
      ];
      if (tokens.length) {
        console.log(
          "  tokens:",
          tokens.map((m) => m[0].slice(0, 120)).join(" | "),
        );
      }
      if (
        u.includes("signup") ||
        u.includes("captcha") ||
        u.includes("verify") ||
        u.includes("waf") ||
        u.includes("aliyun")
      ) {
        console.log("  body:", b.slice(0, 500).replace(/\s+/g, " "));
      }
    }
    if (e.requestHeaders) {
      const interesting = [
        "cookie",
        "bx-ua",
        "bx-umidtoken",
        "bx-v",
        "x-request-id",
      ];
      for (const k of interesting) {
        const found = Object.entries(e.requestHeaders).find(
          ([hk]) => hk.toLowerCase() === k,
        );
        if (found) console.log(`  hdr ${found[0]}: ${String(found[1]).slice(0, 120)}`);
      }
    }
  }
}

// All captcha / waf / acs / nvc related URLs full timeline
console.log("\n=== ALL captcha/waf/acs/nvc/umid URLs ===");
for (const e of raw) {
  const u = String(e.url || "").toLowerCase();
  if (
    u.includes("captcha") ||
    u.includes("waf") ||
    u.includes("/nvc") ||
    u.includes("umid") ||
    u.includes("u_atoken") ||
    u.includes("u_asig") ||
    u.includes("punish") ||
    u.includes("____tmd____") ||
    u.includes("grid") ||
    u.includes("nocaptcha")
  ) {
    console.log(
      `[${e.t}] ${e.phase} ${e.method || ""} ${e.status || ""} ${e.url}`,
    );
    if (e.postData) console.log("  post:", String(e.postData).slice(0, 300));
    if (e.bodyPreview)
      console.log("  body:", String(e.bodyPreview).slice(0, 300));
  }
}
