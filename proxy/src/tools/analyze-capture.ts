import fs from "fs";
import path from "path";

const dir = path.resolve("data/route-capture");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("raw-") && f.endsWith(".jsonl"))
  .sort();
if (files.length === 0) {
  console.error("No raw capture found");
  process.exit(1);
}
const file = path.join(dir, files[files.length - 1]);
console.log("Analyzing", file);

const entries = fs
  .readFileSync(file, "utf8")
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

console.log("events", entries.length);

const posts = entries.filter(
  (e) =>
    e.phase === "request" &&
    (e.method === "POST" || e.method === "PUT" || e.method === "PATCH"),
);

console.log("\n=== ALL POST/PUT/PATCH ===");
for (const e of posts) {
  console.log(`\n[${e.t}ms] ${e.method} ${e.url}`);
  console.log("  type:", e.resourceType);
  if (e.postData) console.log("  body:", String(e.postData).slice(0, 1200));
  const h = e.requestHeaders || {};
  const keep = [
    "content-type",
    "source",
    "timezone",
    "x-request-id",
    "bx-ua",
    "bx-umidtoken",
    "bx-v",
    "authorization",
    "cookie",
    "origin",
    "referer",
  ];
  for (const k of keep) {
    const found = Object.entries(h).find(([hk]) => hk.toLowerCase() === k);
    if (found) console.log(`  hdr ${found[0]}: ${String(found[1]).slice(0, 180)}`);
  }
}

const apiResps = entries.filter((e) => {
  if (e.phase !== "response") return false;
  const u = String(e.url || "").toLowerCase();
  return (
    u.includes("/api/") ||
    u.includes("signup") ||
    u.includes("signin") ||
    u.includes("auths") ||
    u.includes("captcha") ||
    u.includes("verify")
  );
});

console.log("\n=== API RESPONSES ===");
for (const e of apiResps) {
  console.log(`\n[${e.t}ms] ${e.status} ${e.method} ${e.url}`);
  if (e.bodyPreview) console.log("  body:", String(e.bodyPreview).slice(0, 1500));
}

// Unique path keys
const keys = new Set<string>();
for (const e of entries) {
  try {
    const u = new URL(e.url);
    if (
      u.hostname.includes("qwen") ||
      u.pathname.includes("api") ||
      u.pathname.includes("captcha") ||
      u.pathname.includes("auth")
    ) {
      keys.add(`${e.method || "?"} ${u.origin}${u.pathname}`);
    }
  } catch {}
}
console.log("\n=== UNIQUE QWEN/AUTH/API PATHS ===");
for (const k of [...keys].sort()) console.log(" ", k);

// Write compact summary for later
const summary = {
  file,
  postCount: posts.length,
  posts: posts.map((e) => ({
    t: e.t,
    method: e.method,
    url: e.url,
    postData: e.postData,
    headers: e.requestHeaders,
  })),
  apiResponses: apiResps.map((e) => ({
    t: e.t,
    status: e.status,
    method: e.method,
    url: e.url,
    bodyPreview: e.bodyPreview,
  })),
  paths: [...keys].sort(),
};
const out = path.join(dir, "analysis-latest.json");
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log("\nWrote", out);
