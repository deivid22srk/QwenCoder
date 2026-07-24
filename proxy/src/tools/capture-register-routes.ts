/**
 * Capture all network routes during a manual Qwen registration.
 * Opens a visible browser for 2 minutes and logs requests/responses.
 *
 * Usage: npx tsx src/tools/capture-register-routes.ts
 */

import { chromium, type Request, type Response } from "playwright";
import fs from "fs";
import path from "path";

const DURATION_MS = Number(process.env.CAPTURE_MS || 120_000);
const OUT_DIR = path.resolve("data", "route-capture");
const START = Date.now();

type CaptureEntry = {
  t: number;
  phase: "request" | "response" | "requestfailed";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string | null;
  bodyPreview?: string | null;
  failure?: string;
};

const entries: CaptureEntry[] = [];
const interesting: CaptureEntry[] = [];

function isInteresting(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("chat.qwen.ai") ||
    u.includes("qwen.ai") ||
    u.includes("aliyun") ||
    u.includes("captcha") ||
    u.includes("auth") ||
    u.includes("signup") ||
    u.includes("signin") ||
    u.includes("register") ||
    u.includes("mail.tm") ||
    u.includes("/api/")
  );
}

function safePreview(text: string | null | undefined, max = 4000): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, max) + `…[truncated ${text.length - max} chars]`;
}

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (
      key.includes("authorization") ||
      key.includes("cookie") ||
      key.includes("token") ||
      key.includes("password")
    ) {
      out[k] = v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(OUT_DIR, `raw-${stamp}.jsonl`);
  const summaryPath = path.join(OUT_DIR, `summary-${stamp}.json`);
  const rawStream = fs.createWriteStream(rawPath, { flags: "a" });

  console.log("=== Qwen register route capture ===");
  console.log(`Duration: ${DURATION_MS / 1000}s`);
  console.log(`Output: ${OUT_DIR}`);
  console.log("Browser opening on auth?mode=register — create your account now.\n");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "pt-BR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  const onRequest = async (req: Request) => {
    const url = req.url();
    const entry: CaptureEntry = {
      t: Date.now() - START,
      phase: "request",
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      requestHeaders: redact(req.headers()),
      postData: safePreview(req.postData()),
    };
    entries.push(entry);
    rawStream.write(JSON.stringify(entry) + "\n");
    if (
      isInteresting(url) &&
      (req.resourceType() === "fetch" || req.resourceType() === "xhr")
    ) {
      interesting.push(entry);
      console.log(
        `[${Math.round(entry.t / 1000)}s] → ${entry.method} ${url}` +
          (entry.postData ? ` body=${entry.postData.slice(0, 120)}` : ""),
      );
    }
  };

  const onResponse = async (res: Response) => {
    const req = res.request();
    const url = res.url();
    let bodyPreview: string | null = null;
    try {
      const ct = res.headers()["content-type"] || "";
      if (
        ct.includes("json") ||
        ct.includes("text") ||
        ct.includes("javascript") ||
        url.includes("/api/")
      ) {
        bodyPreview = safePreview(await res.text());
      }
    } catch {
      // ignore body read errors (redirects, etc.)
    }

    const entry: CaptureEntry = {
      t: Date.now() - START,
      phase: "response",
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      status: res.status(),
      responseHeaders: redact(res.headers()),
      bodyPreview,
    };
    entries.push(entry);
    rawStream.write(JSON.stringify(entry) + "\n");

    const type = req.resourceType();
    if (
      isInteresting(url) &&
      (type === "fetch" || type === "xhr" || type === "document")
    ) {
      interesting.push(entry);
      console.log(
        `[${Math.round(entry.t / 1000)}s] ← ${entry.status} ${entry.method} ${url}` +
          (bodyPreview ? ` body=${bodyPreview.slice(0, 160).replace(/\s+/g, " ")}` : ""),
      );
    }
  };

  const onFailed = (req: Request) => {
    const entry: CaptureEntry = {
      t: Date.now() - START,
      phase: "requestfailed",
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText,
    };
    entries.push(entry);
    rawStream.write(JSON.stringify(entry) + "\n");
    if (isInteresting(req.url())) {
      console.log(
        `[${Math.round(entry.t / 1000)}s] ✕ ${entry.method} ${entry.url} (${entry.failure})`,
      );
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);

  // Also capture from all new pages/popups
  context.on("page", (p) => {
    p.on("request", onRequest);
    p.on("response", onResponse);
    p.on("requestfailed", onFailed);
  });

  await page.goto("https://chat.qwen.ai/auth?mode=register", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log("\n>>> Create the account in the browser NOW. Listening...\n");

  const tick = setInterval(() => {
    const left = Math.max(0, DURATION_MS - (Date.now() - START));
    process.stdout.write(
      `\r[capture] ${Math.ceil(left / 1000)}s left | events=${entries.length} interesting=${interesting.length}   `,
    );
  }, 1000);

  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(tick);
  console.log("\n\nTime up. Saving capture...");

  // Build API-focused summary
  const apiCalls = entries.filter((e) => {
    if (e.phase !== "request" && e.phase !== "response") return false;
    const u = e.url.toLowerCase();
    return (
      (u.includes("/api/") ||
        u.includes("signup") ||
        u.includes("signin") ||
        u.includes("captcha") ||
        u.includes("auths")) &&
      (e.resourceType === "fetch" ||
        e.resourceType === "xhr" ||
        e.resourceType === "document" ||
        e.method === "POST" ||
        e.method === "PUT" ||
        e.method === "PATCH")
    );
  });

  const byUrl = new Map<string, CaptureEntry[]>();
  for (const e of apiCalls) {
    try {
      const parsed = new URL(e.url);
      const key = `${e.method || "?"} ${parsed.origin}${parsed.pathname}`;
      const list = byUrl.get(key) || [];
      list.push(e);
      byUrl.set(key, list);
    } catch {
      // ignore bad urls
    }
  }

  const summary = {
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - START,
    totalEvents: entries.length,
    interestingCount: interesting.length,
    apiRouteKeys: [...byUrl.keys()].sort(),
    routes: [...byUrl.entries()].map(([key, list]) => {
      const reqs = list.filter((x) => x.phase === "request");
      const resps = list.filter((x) => x.phase === "response");
      return {
        key,
        requestCount: reqs.length,
        responseCount: resps.length,
        sampleRequest: reqs[0]
          ? {
              t: reqs[0].t,
              headers: reqs[0].requestHeaders,
              postData: reqs[0].postData,
            }
          : null,
        sampleResponse: resps[0]
          ? {
              t: resps[0].t,
              status: resps[0].status,
              headers: resps[0].responseHeaders,
              bodyPreview: resps[0].bodyPreview,
            }
          : null,
        allStatuses: resps.map((r) => r.status).filter(Boolean),
      };
    }),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  rawStream.end();

  console.log(`\nSaved:`);
  console.log(`  raw:     ${rawPath}`);
  console.log(`  summary: ${summaryPath}`);
  console.log(`\nAPI routes seen (${summary.apiRouteKeys.length}):`);
  for (const k of summary.apiRouteKeys) {
    console.log(`  - ${k}`);
  }

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
