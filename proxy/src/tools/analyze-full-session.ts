import fs from "fs";
import path from "path";

const dir = path.resolve("data/full-session-capture");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("raw-") && f.endsWith(".jsonl"))
  .sort();
const file = path.join(dir, files[files.length - 1]);
console.log("Analyzing", file, "size", fs.statSync(file).size);

const events = fs
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

console.log("events", events.length);
const byKind: Record<string, number> = {};
for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log("byKind", byKind);

// Interesting timeline
const interesting = events.filter((e) => {
  if (!e.url && !e.kind?.startsWith("nav")) return false;
  const u = String(e.url || e.kind || "").toLowerCase();
  return (
    u.includes("signup") ||
    u.includes("captcha") ||
    u.includes("verify") ||
    u.includes("auths") ||
    u.includes("mail.tm") ||
    u.includes("cloudauth") ||
    (e.kind === "nav" && String(e.url || "").includes("qwen")) ||
    (e.kind === "nav" && String(e.url || "").includes("mail"))
  );
});

console.log("\n=== TIMELINE (key events) ===");
for (const e of interesting) {
  if (e.kind === "nav") {
    console.log(`[${(e.t / 1000).toFixed(1)}s] NAV ${e.url}`);
    continue;
  }
  if (e.kind === "net.request" && (e.method === "POST" || e.method === "GET" || e.method === "PATCH")) {
    const short = String(e.url).slice(0, 140);
    console.log(`[${(e.t / 1000).toFixed(1)}s] → ${e.method} ${short}`);
    if (e.postData && (String(e.url).includes("signup") || String(e.url).includes("Verify") || String(e.url).includes("InitCaptcha") || String(e.url).includes("accounts") || String(e.url).includes("token"))) {
      console.log("    body:", String(e.postData).slice(0, 400));
    }
  }
  if (e.kind === "net.response") {
    const u = String(e.url);
    if (
      u.includes("signup") ||
      u.includes("Verify") ||
      u.includes("captcha-open") ||
      u.includes("/auths/") ||
      u.includes("messages") ||
      u.includes("InitCaptcha")
    ) {
      console.log(
        `[${(e.t / 1000).toFixed(1)}s] ← ${e.status} ${u.slice(0, 140)}`,
      );
      if (e.bodyPreview) {
        console.log("    body:", String(e.bodyPreview).slice(0, 600).replace(/\s+/g, " "));
      }
    }
  }
}

// Extract mail message body fully
console.log("\n=== MAIL.TM MESSAGE BODIES ===");
for (const e of events) {
  if (
    e.kind === "net.response" &&
    String(e.url).includes("api.mail.tm/messages/") &&
    e.bodyPreview
  ) {
    console.log("URL", e.url);
    console.log(String(e.bodyPreview).slice(0, 4000));
  }
}

// Extract signup + verify captcha details
console.log("\n=== SIGNUP REQUESTS FULL ===");
for (const e of events) {
  if (e.kind === "net.request" && String(e.url).includes("signup")) {
    console.log(JSON.stringify({ t: e.t, url: e.url, postData: e.postData, headers: e.headers }, null, 2));
  }
}

console.log("\n=== VERIFY CAPTCHA ===");
for (const e of events) {
  if (
    String(e.url || "").includes("VerifyCaptcha") ||
    String(e.url || "").includes("-verify.captcha")
  ) {
    console.log(e.kind, e.t, e.status || e.method, String(e.url).slice(0, 100));
    if (e.postData) console.log(" post", String(e.postData).slice(0, 500));
    if (e.bodyPreview) console.log(" body", String(e.bodyPreview).slice(0, 500));
  }
}

// Write compact study notes
const notes = {
  file,
  byKind,
  flow: interesting
    .filter(
      (e) =>
        e.kind === "nav" ||
        (e.kind === "net.request" &&
          (e.method === "POST" || String(e.url).includes("messages"))),
    )
    .map((e) => ({
      t: e.t,
      kind: e.kind,
      method: e.method,
      url: e.url,
      status: e.status,
    })),
};
fs.writeFileSync(
  path.join(dir, "study-notes.json"),
  JSON.stringify(notes, null, 2),
);
console.log("\nWrote study-notes.json");
