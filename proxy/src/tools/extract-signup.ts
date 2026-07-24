import fs from "fs";

const s = JSON.parse(
  fs.readFileSync("data/route-capture/analysis-latest.json", "utf8"),
);

const signupReqs = s.posts.filter((p: any) =>
  String(p.url).includes("signup"),
);
const signupRes = s.apiResponses.filter((p: any) =>
  String(p.url).includes("signup"),
);

console.log("=== SIGNUP REQUESTS ===");
for (const r of signupReqs) {
  console.log(
    JSON.stringify(
      {
        t: r.t,
        url: r.url,
        method: r.method,
        postData: r.postData,
        headers: r.headers,
      },
      null,
      2,
    ),
  );
}

console.log("=== SIGNUP RESPONSES ===");
for (const r of signupRes) {
  console.log(
    JSON.stringify(
      {
        t: r.t,
        status: r.status,
        url: r.url,
        body: r.bodyPreview,
      },
      null,
      2,
    ),
  );
}

console.log("=== ALL POSTS TO chat.qwen.ai ===");
for (const p of s.posts) {
  if (String(p.url).includes("chat.qwen.ai")) {
    console.log(
      p.t,
      p.method,
      p.url,
      "\n  body:",
      String(p.postData || "").slice(0, 800),
    );
    const h = p.headers || {};
    console.log(
      "  headers:",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(h).filter(([k]) =>
            [
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
              "accept",
            ].includes(String(k).toLowerCase()),
          ),
        ),
      ),
    );
  }
}

// Look for password hash pattern in any post body
console.log("\n=== bodies containing password/username/email ===");
for (const p of s.posts) {
  const body = String(p.postData || "");
  if (
    body.includes("password") ||
    body.includes("username") ||
    body.includes("email") ||
    body.includes("login_type")
  ) {
    console.log(p.t, p.url);
    console.log(body.slice(0, 1500));
  }
}
