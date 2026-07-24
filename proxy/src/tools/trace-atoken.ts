import fs from "fs";

const raw = fs
  .readFileSync(
    "data/route-capture/raw-2026-07-19T18-21-33-169Z.jsonl",
    "utf8",
  )
  .split(/\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const token = "c0f843e27795eaf55a30fb3eb4f9d7c0";
const certify = "0a03e58c17844853457132621e493f";

for (const e of raw) {
  const blob = JSON.stringify(e);
  if (!blob.includes(token) && !blob.includes("u_atoken") && !blob.includes("VerifyCaptcha") && !blob.includes(certify))
    continue;
  if (e.phase === "request") {
    console.log(`REQ [${e.t}] ${e.method} ${e.url}`);
    if (e.postData) console.log("  post:", String(e.postData).slice(0, 600));
  }
  if (e.phase === "response" && e.bodyPreview) {
    console.log(`RES [${e.t}] ${e.status} ${e.url}`);
    console.log("  body:", String(e.bodyPreview).slice(0, 500));
  }
}

const v = raw.find(
  (e) => e.phase === "request" && String(e.url).includes("VerifyCaptcha"),
);
if (v?.postData) {
  const params = new URLSearchParams(v.postData);
  console.log("\n=== VerifyCaptchaV2 fields ===");
  for (const [k, val] of params) {
    if (k === "CaptchaVerifyParam") {
      try {
        console.log(k, decodeURIComponent(val).slice(0, 800));
      } catch {
        console.log(k, val.slice(0, 800));
      }
    } else {
      console.log(k, val.slice(0, 200));
    }
  }
}

// InitCaptcha body
const init = raw.find(
  (e) => e.phase === "request" && String(e.postData || "").includes("InitCaptcha"),
);
if (init?.postData) {
  console.log("\n=== InitCaptchaV2 ===");
  const params = new URLSearchParams(init.postData);
  for (const [k, val] of params) {
    console.log(k, val.slice(0, 200));
  }
}
