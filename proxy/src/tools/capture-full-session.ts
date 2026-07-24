/**
 * Full interactive session capture for Qwen register flow.
 * Records for ~2 minutes:
 *  - Network (request/response headers + bodies when possible)
 *  - Mouse: move (throttled), down/up, click, wheel, velocity
 *  - Keyboard: keydown/keyup, codes, targets
 *  - DOM: mutations (added/removed/attrs), visibility of captcha nodes
 *  - Navigation / console / dialogs
 *
 * Usage: npx tsx src/tools/capture-full-session.ts
 */

import { chromium, type Page, type Request, type Response } from "playwright";
import fs from "fs";
import path from "path";

const DURATION_MS = Number(process.env.CAPTURE_MS || 120_000);
const OUT_DIR = path.resolve("data", "full-session-capture");
const START = Date.now();

type Evt = {
  t: number;
  kind: string;
  [k: string]: unknown;
};

const events: Evt[] = [];
let rawStream: fs.WriteStream;

function now() {
  return Date.now() - START;
}

function push(evt: Evt) {
  events.push(evt);
  rawStream.write(JSON.stringify(evt) + "\n");
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (
      key.includes("authorization") ||
      key === "cookie" ||
      key.includes("token") ||
      key.includes("password")
    ) {
      out[k] =
        v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)} (len=${v.length})` : "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function preview(text: string | null | undefined, max = 6000): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, max) + `…[+${text.length - max}]`;
}

function isInterestingUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("qwen") ||
    u.includes("aliyun") ||
    u.includes("captcha") ||
    u.includes("auth") ||
    u.includes("signup") ||
    u.includes("signin") ||
    u.includes("verify") ||
    u.includes("mail.tm") ||
    u.includes("/api/") ||
    u.includes("cloudauth") ||
    u.includes("waf")
  );
}

async function injectRecorders(page: Page) {
  // May already be exposed if page navigated
  try {
    await page.exposeFunction("__qwenCapture", (payload: Evt) => {
      push({
        ...payload,
        t: now(),
        pageUrl: page.url(),
      });
    });
  } catch {
    // already exposed
  }

  await page.addInitScript(() => {
    const send = (kind: string, data: Record<string, unknown> = {}) => {
      try {
        const fn = (window as unknown as { __qwenCapture?: (p: unknown) => void })
          .__qwenCapture;
        if (fn) fn({ kind, ...data });
      } catch {
        /* ignore */
      }
    };

    // ── mouse ────────────────────────────────────────────────
    let lastMove = 0;
    let lastX = 0;
    let lastY = 0;
    let lastMoveTs = performance.now();

    document.addEventListener(
      "mousemove",
      (e) => {
        const ts = performance.now();
        // throttle ~33ms (~30Hz) but always keep velocity
        if (ts - lastMove < 33) return;
        const dt = Math.max(1, ts - lastMoveTs);
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        const dist = Math.hypot(dx, dy);
        const speed = dist / (dt / 1000); // px/s
        lastMove = ts;
        lastMoveTs = ts;
        lastX = e.clientX;
        lastY = e.clientY;
        send("mouse.move", {
          x: e.clientX,
          y: e.clientY,
          pageX: e.pageX,
          pageY: e.pageY,
          buttons: e.buttons,
          speed,
          dx,
          dy,
          dt,
          target: describe(e.target),
        });
      },
      true,
    );

    for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu"] as const) {
      document.addEventListener(
        type,
        (e) => {
          const me = e as MouseEvent;
          send(`mouse.${type}`, {
            x: me.clientX,
            y: me.clientY,
            pageX: me.pageX,
            pageY: me.pageY,
            button: me.button,
            buttons: me.buttons,
            detail: me.detail,
            target: describe(me.target),
            path: pathSelectors(me.target),
          });
        },
        true,
      );
    }

    document.addEventListener(
      "wheel",
      (e) => {
        send("mouse.wheel", {
          x: e.clientX,
          y: e.clientY,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          target: describe(e.target),
        });
      },
      { passive: true, capture: true },
    );

    // ── keyboard ─────────────────────────────────────────────
    for (const type of ["keydown", "keyup"] as const) {
      document.addEventListener(
        type,
        (e) => {
          const ke = e as KeyboardEvent;
          // Don't store password field values in full — mark sensitive
          const t = ke.target as HTMLElement | null;
          const sensitive =
            (t &&
              (t.getAttribute("type") === "password" ||
                /password|checkPassword/i.test(
                  t.getAttribute("name") || t.id || "",
                ))) ||
            false;
          send(`key.${type}`, {
            key: sensitive && type === "keydown" ? "[sensitive]" : ke.key,
            code: ke.code,
            keyCode: ke.keyCode,
            repeat: ke.repeat,
            altKey: ke.altKey,
            ctrlKey: ke.ctrlKey,
            metaKey: ke.metaKey,
            shiftKey: ke.shiftKey,
            sensitive,
            target: describe(ke.target),
          });
        },
        true,
      );
    }

    document.addEventListener(
      "input",
      (e) => {
        const t = e.target as HTMLInputElement | HTMLTextAreaElement | null;
        if (!t) return;
        const name = t.getAttribute("name") || t.id || "";
        const sensitive =
          t.type === "password" || /password|checkPassword/i.test(name);
        send("input", {
          target: describe(t),
          name,
          inputType: t.type || t.tagName,
          value: sensitive
            ? `[len=${(t.value || "").length}]`
            : (t.value || "").slice(0, 200),
          valueLen: (t.value || "").length,
        });
      },
      true,
    );

    document.addEventListener(
      "change",
      (e) => {
        const t = e.target as HTMLInputElement | null;
        if (!t) return;
        send("change", {
          target: describe(t),
          name: t.name || t.id,
          type: t.type,
          checked: (t as HTMLInputElement).checked,
          value:
            t.type === "password"
              ? `[len=${(t.value || "").length}]`
              : (t.value || "").slice(0, 200),
        });
      },
      true,
    );

    // ── focus ────────────────────────────────────────────────
    document.addEventListener(
      "focusin",
      (e) => send("focusin", { target: describe(e.target) }),
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => send("focusout", { target: describe(e.target) }),
      true,
    );

    // ── visibility / captcha snapshot polling ────────────────
    const captchaIds = [
      "waf_nc_block",
      "WAF_NC_WRAPPER",
      "nocaptcha",
      "aliyunCaptcha-window-embed",
      "aliyunCaptcha-window-float",
      "aliyunCaptcha-img-box",
      "aliyunCaptcha-img",
      "aliyunCaptcha-puzzle",
      "aliyunCaptcha-sliding-body",
      "aliyunCaptcha-sliding-slider",
      "aliyunCaptcha-sliding-left",
      "aliyunCaptcha-sliding-text",
      "aliyunCaptcha-btn-refresh",
    ];

    let lastSnap = "";
    setInterval(() => {
      try {
        const nodes: Record<string, unknown> = {};
        for (const id of captchaIds) {
          const el = document.getElementById(id);
          if (!el) {
            nodes[id] = null;
            continue;
          }
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          nodes[id] = {
            tag: el.tagName,
            className: el.className,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            text: (el.textContent || "").trim().slice(0, 80),
            leftStyle: (el as HTMLElement).style?.left || null,
            widthStyle: (el as HTMLElement).style?.width || null,
            src:
              el.tagName === "IMG"
                ? ((el as HTMLImageElement).currentSrc || "").slice(0, 120)
                : null,
          };
        }
        const url = location.href;
        const snap = JSON.stringify({ url, nodes });
        if (snap !== lastSnap) {
          lastSnap = snap;
          send("ui.snapshot", { url, nodes });
        }
      } catch {
        /* ignore */
      }
    }, 250);

    // ── mutation observer (what appears / changes) ───────────
    const mo = new MutationObserver((mutations) => {
      const batch: unknown[] = [];
      for (const m of mutations.slice(0, 40)) {
        if (m.type === "childList") {
          batch.push({
            type: "childList",
            target: describe(m.target),
            added: [...m.addedNodes]
              .slice(0, 8)
              .map((n) => describe(n))
              .filter(Boolean),
            removed: [...m.removedNodes]
              .slice(0, 8)
              .map((n) => describe(n))
              .filter(Boolean),
          });
        } else if (m.type === "attributes") {
          const el = m.target as HTMLElement;
          batch.push({
            type: "attributes",
            target: describe(m.target),
            attr: m.attributeName,
            value: el.getAttribute(m.attributeName || "")?.slice(0, 120),
          });
        } else if (m.type === "characterData") {
          batch.push({
            type: "characterData",
            target: describe(m.target.parentElement),
            text: (m.target.textContent || "").slice(0, 100),
          });
        }
      }
      if (batch.length) send("dom.mutation", { mutations: batch });
    });

    const startMo = () => {
      if (!document.documentElement) return;
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeFilter: [
          "class",
          "style",
          "src",
          "disabled",
          "value",
          "aria-hidden",
          "hidden",
        ],
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startMo);
    } else {
      startMo();
    }

    // ── helpers ──────────────────────────────────────────────
    function describe(node: EventTarget | Node | null): string | null {
      if (!node || !(node as Node).nodeType) return null;
      const n = node as Node;
      if (n.nodeType === 3) {
        return `#text:${(n.textContent || "").trim().slice(0, 40)}`;
      }
      const el = n as HTMLElement;
      if (!el.tagName) return n.nodeName;
      const id = el.id ? `#${el.id}` : "";
      const name = el.getAttribute?.("name");
      const cls =
        typeof el.className === "string" && el.className
          ? "." +
            el.className
              .trim()
              .split(/\s+/)
              .slice(0, 3)
              .join(".")
          : "";
      const namePart = name ? `[name=${name}]` : "";
      const ph = el.getAttribute?.("placeholder");
      const phPart = ph ? `[ph=${ph.slice(0, 30)}]` : "";
      return `${el.tagName.toLowerCase()}${id}${cls}${namePart}${phPart}`.slice(
        0,
        160,
      );
    }

    function pathSelectors(node: EventTarget | null): string[] {
      const parts: string[] = [];
      let cur = node as HTMLElement | null;
      let depth = 0;
      while (cur && depth < 6) {
        const d = describe(cur);
        if (d) parts.push(d);
        cur = cur.parentElement;
        depth++;
      }
      return parts;
    }

    send("recorder.ready", {
      href: location.href,
      ua: navigator.userAgent,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: devicePixelRatio,
    });
  });
}

async function wirePage(page: Page) {
  await injectRecorders(page);

  page.on("console", (msg) => {
    push({
      t: now(),
      kind: "console",
      type: msg.type(),
      text: msg.text().slice(0, 500),
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      push({
        t: now(),
        kind: "nav",
        url: frame.url(),
      });
      console.log(`[${Math.round(now() / 1000)}s] nav → ${frame.url()}`);
    }
  });

  page.on("dialog", async (d) => {
    push({
      t: now(),
      kind: "dialog",
      type: d.type(),
      message: d.message(),
    });
    await d.dismiss().catch(() => {});
  });

  const onReq = (req: Request) => {
    const url = req.url();
    const entry: Evt = {
      t: now(),
      kind: "net.request",
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      headers: redactHeaders(req.headers()),
      postData: preview(req.postData(), 8000),
    };
    push(entry);
    if (
      isInterestingUrl(url) &&
      (req.resourceType() === "fetch" ||
        req.resourceType() === "xhr" ||
        req.method() === "POST")
    ) {
      console.log(
        `[${Math.round(now() / 1000)}s] → ${req.method()} ${url.slice(0, 120)}`,
      );
    }
  };

  const onRes = async (res: Response) => {
    const req = res.request();
    const url = res.url();
    let bodyPreview: string | null = null;
    try {
      const ct = res.headers()["content-type"] || "";
      if (
        isInterestingUrl(url) &&
        (ct.includes("json") ||
          ct.includes("text") ||
          ct.includes("html") ||
          ct.includes("javascript") ||
          url.includes("/api/") ||
          url.includes("captcha") ||
          url.includes("signup") ||
          url.includes("verify"))
      ) {
        bodyPreview = preview(await res.text(), 8000);
      }
    } catch {
      /* ignore */
    }
    push({
      t: now(),
      kind: "net.response",
      method: req.method(),
      url,
      status: res.status(),
      resourceType: req.resourceType(),
      headers: redactHeaders(res.headers()),
      bodyPreview,
    });
    if (
      isInterestingUrl(url) &&
      (req.resourceType() === "fetch" ||
        req.resourceType() === "xhr" ||
        req.method() === "POST")
    ) {
      console.log(
        `[${Math.round(now() / 1000)}s] ← ${res.status()} ${url.slice(0, 120)}`,
      );
    }
  };

  const onFail = (req: Request) => {
    push({
      t: now(),
      kind: "net.failed",
      method: req.method(),
      url: req.url(),
      failure: req.failure()?.errorText,
    });
  };

  page.on("request", onReq);
  page.on("response", onRes);
  page.on("requestfailed", onFail);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(OUT_DIR, `raw-${stamp}.jsonl`);
  const summaryPath = path.join(OUT_DIR, `summary-${stamp}.json`);
  rawStream = fs.createWriteStream(rawPath, { flags: "a" });

  console.log("=== FULL SESSION CAPTURE (2 min) ===");
  console.log(`Duration: ${DURATION_MS / 1000}s`);
  console.log(`Output:   ${OUT_DIR}`);
  console.log("Capturing: network + mouse + keyboard + DOM mutations + UI snapshots");
  console.log(">>> Preenche o registro / captcha / email AGORA.\n");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "pt-BR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  });

  // inject before any page
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  await wirePage(page);

  context.on("page", async (p) => {
    push({ t: now(), kind: "page.opened", url: p.url() });
    await wirePage(p).catch(() => {});
  });

  await page.goto("https://chat.qwen.ai/auth?mode=register", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  push({ t: now(), kind: "session.start", url: page.url() });

  const tick = setInterval(() => {
    const left = Math.max(0, DURATION_MS - now());
    const counts = events.reduce(
      (acc, e) => {
        const k = String(e.kind).split(".")[0];
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    process.stdout.write(
      `\r[capture] ${Math.ceil(left / 1000)}s left | events=${events.length} ${JSON.stringify(counts)}   `,
    );
  }, 1000);

  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(tick);
  console.log("\n\nTime up. Building summary...");

  push({ t: now(), kind: "session.end" });

  // Summary stats
  const byKind: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  }

  const clicks = events.filter((e) => e.kind === "mouse.click");
  const keys = events.filter((e) => e.kind === "key.keydown");
  const posts = events.filter(
    (e) => e.kind === "net.request" && e.method === "POST",
  );
  const snapshots = events.filter((e) => e.kind === "ui.snapshot");
  const mutations = events.filter((e) => e.kind === "dom.mutation");

  const apiRoutes = new Set<string>();
  for (const e of events) {
    if (e.kind !== "net.request" && e.kind !== "net.response") continue;
    try {
      const u = new URL(String(e.url));
      if (
        u.hostname.includes("qwen") ||
        u.pathname.includes("api") ||
        u.hostname.includes("captcha") ||
        u.hostname.includes("aliyun")
      ) {
        apiRoutes.add(`${e.method || "?"} ${u.origin}${u.pathname}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Mouse path sample (every Nth move for overview)
  const moves = events.filter((e) => e.kind === "mouse.move");
  const mousePath = moves
    .filter((_, i) => i % 5 === 0)
    .map((e) => ({
      t: e.t,
      x: e.x,
      y: e.y,
      speed: e.speed,
    }));

  const summary = {
    capturedAt: new Date().toISOString(),
    durationMs: now(),
    totalEvents: events.length,
    byKind,
    counts: {
      clicks: clicks.length,
      keydowns: keys.length,
      mouseMoves: moves.length,
      posts: posts.length,
      uiSnapshots: snapshots.length,
      domMutations: mutations.length,
    },
    apiRoutes: [...apiRoutes].sort(),
    clickLog: clicks.map((c) => ({
      t: c.t,
      x: c.x,
      y: c.y,
      target: c.target,
      path: c.path,
    })),
    keyLog: keys.map((k) => ({
      t: k.t,
      key: k.key,
      code: k.code,
      sensitive: k.sensitive,
      target: k.target,
    })),
    mousePathSample: mousePath,
    lastUiSnapshot: snapshots[snapshots.length - 1] || null,
    interestingPosts: posts
      .filter((p) => isInterestingUrl(String(p.url)))
      .map((p) => ({
        t: p.t,
        method: p.method,
        url: p.url,
        postData: p.postData,
        headers: p.headers,
      })),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  rawStream.end();

  console.log(`\nSaved:`);
  console.log(`  raw:     ${rawPath}`);
  console.log(`  summary: ${summaryPath}`);
  console.log(`\nEvent counts:`, byKind);
  console.log(`\nAPI routes (${summary.apiRoutes.length}):`);
  for (const r of summary.apiRoutes.slice(0, 40)) console.log(" ", r);

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
