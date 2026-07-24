/*
 * Dolphin-style isolated browser sessions for Qwen signup / captcha.
 *
 * Each session is a clean room:
 *  - unique profile dir (wiped after close)
 *  - unique fingerprint seed (never reuse email seed)
 *  - optional residential proxy (new session id → new IP)
 *  - stealth + no shared cookies/storage/cache
 *
 * Env:
 *   REGISTER_PROXY / CAPTCHA_PROXY / HTTPS_PROXY  — http(s)://user:pass@host:port
 *   PROXY_ROTATE_SESSION=1  — inject -session-<uuid> into proxy username (common on residential)
 *   ISOLATED_BROWSER=0      — disable and fall back to plain launch
 *   REGISTER_HEADLESS=true|false
 *   REGISTER_CHANNEL=chrome|msedge|chromium (optional real Chrome channel)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  clearFingerprintCache,
  getFingerprintProfile,
  type FingerprintProfile,
} from "./fingerprint.ts";

export interface IsolatedSession {
  id: string;
  fingerprint: FingerprintProfile;
  profileDir: string;
  proxy?: { server: string; username?: string; password?: string; raw: string };
  egressIp?: string;
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

function env(name: string, fallback = ""): string {
  return String(process.env[name] ?? fallback).trim();
}

function envTruthy(name: string, defaultTrue = true): boolean {
  const v = env(name, defaultTrue ? "1" : "0").toLowerCase();
  if (["0", "false", "no", "off"].includes(v)) return false;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  return defaultTrue;
}

/** Resolve proxy from env (register path first). */
export function resolveRegisterProxy(): string | undefined {
  const raw =
    env("REGISTER_PROXY") ||
    env("CAPTCHA_PROXY") ||
    env("HTTPS_PROXY") ||
    env("HTTP_PROXY") ||
    env("ALL_PROXY");
  return raw || undefined;
}

/**
 * Parse proxy URL. Supports:
 *   http://user:pass@host:port
 *   socks5://user:pass@host:port
 * With PROXY_ROTATE_SESSION=1, appends -session-<id> to username for sticky-rotating residential.
 */
export function parseProxy(
  raw: string,
  sessionId: string,
): { server: string; username?: string; password?: string; raw: string } {
  let urlStr = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlStr)) {
    urlStr = `http://${urlStr}`;
  }
  const u = new URL(urlStr);
  const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  let username = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;

  if (username && envTruthy("PROXY_ROTATE_SESSION", true)) {
    // Common residential format: user-session-abc123 or user_session-abc
    const short = sessionId.replace(/-/g, "").slice(0, 12);
    if (!/session[-_]/i.test(username)) {
      username = `${username}-session-${short}`;
    } else {
      username = username.replace(
        /session[-_][A-Za-z0-9]+/i,
        `session-${short}`,
      );
    }
  }

  return { server, username, password, raw: urlStr };
}

function buildStealthInitScript(profile: FingerprintProfile): string {
  const profileJson = JSON.stringify(profile).replace(/</g, "\\u003c");
  return `
    const __qwenFingerprint = ${profileJson};
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try { delete navigator.__proto__.webdriver; } catch (e) {}
    window.chrome = window.chrome || {
      runtime: { onMessage: { addListener: function(){} }, sendMessage: function(){} },
      loadTimes: function(){ return {}; },
      csi: function(){ return {}; },
      app: { isInstalled: false },
    };
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });
    Object.defineProperty(navigator, 'languages', { get: () => __qwenFingerprint.languages });
    Object.defineProperty(navigator, 'language', { get: () => __qwenFingerprint.locale });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => __qwenFingerprint.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => __qwenFingerprint.deviceMemory });
    Object.defineProperty(navigator, 'platform', { get: () => __qwenFingerprint.platform });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    if ('userAgentData' in navigator) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: __qwenFingerprint.brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async (hints) => {
            const values = {
              architecture: 'x86', bitness: '64',
              brands: __qwenFingerprint.brands,
              fullVersionList: __qwenFingerprint.fullVersionList,
              mobile: false, model: '',
              platform: 'Windows',
              platformVersion: __qwenFingerprint.platformVersion,
              uaFullVersion: __qwenFingerprint.chromeVersion,
              wow64: false,
            };
            return hints.reduce((acc, hint) => {
              if (hint in values) acc[hint] = values[hint];
              return acc;
            }, {});
          },
          toJSON: () => ({ brands: __qwenFingerprint.brands, mobile: false, platform: 'Windows' }),
        }),
      });
    }
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return __qwenFingerprint.webglVendor;
      if (param === 37446) return __qwenFingerprint.webglRenderer;
      return getParameter.apply(this, arguments);
    };
    Object.defineProperty(screen, 'colorDepth', { get: () => __qwenFingerprint.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __qwenFingerprint.pixelDepth });
    // Permissions / notification noise
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  `;
}

async function detectEgressIp(page: Page): Promise<string | undefined> {
  try {
    const ip = await page.evaluate(async () => {
      const urls = [
        "https://api.ipify.org?format=json",
        "https://httpbin.org/ip",
      ];
      for (const u of urls) {
        try {
          const r = await fetch(u, { cache: "no-store" });
          const j = await r.json();
          return j.ip || j.origin || null;
        } catch {
          /* try next */
        }
      }
      return null;
    });
    return ip || undefined;
  } catch {
    return undefined;
  }
}

function rmProfileDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

/**
 * Launch a fully isolated Chromium session (Dolphin-like clean room).
 */
export async function launchIsolatedBrowser(options?: {
  headless?: boolean;
  proxyUrl?: string | null;
  label?: string;
}): Promise<IsolatedSession> {
  const id = crypto.randomUUID();
  const label = options?.label || "session";
  const headless =
    options?.headless ?? env("REGISTER_HEADLESS") === "true";

  // Brand-new fingerprint — never seed from email (that reused F001)
  const fpId = `iso-${id}`;
  clearFingerprintCache(fpId);
  const fingerprint = getFingerprintProfile(fpId);

  const profileDir = path.resolve(
    "data",
    "isolated_profiles",
    `${Date.now()}-${id.slice(0, 8)}`,
  );
  fs.mkdirSync(profileDir, { recursive: true });

  const proxyRaw =
    options?.proxyUrl === null
      ? undefined
      : options?.proxyUrl || resolveRegisterProxy();
  const proxy = proxyRaw ? parseProxy(proxyRaw, id) : undefined;

  // Stealth engine when available
  let engine: typeof chromium = chromium;
  try {
    const pwExtra = await import("playwright-extra");
    const stealth = await import("puppeteer-extra-plugin-stealth");
    if (pwExtra.chromium && stealth.default) {
      pwExtra.chromium.use(stealth.default());
      engine = pwExtra.chromium;
    }
  } catch {
    /* plain chromium */
  }

  const channel = env("REGISTER_CHANNEL"); // chrome | msedge | ""

  console.log(
    `[IsolatedBrowser] launch id=${id.slice(0, 8)} label=${label} headless=${headless} ` +
      `fp=${fingerprint.chromeVersion} vp=${fingerprint.viewport.width}x${fingerprint.viewport.height} ` +
      `proxy=${proxy ? proxy.server : "none"} profile=${path.basename(profileDir)}`,
  );

  // Persistent context = full profile isolation (cookies, localStorage, cache)
  const context = await engine.launchPersistentContext(profileDir, {
    headless,
    channel: channel || undefined,
    userAgent: fingerprint.userAgent,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezoneId,
    viewport: fingerprint.viewport,
    screen: {
      width: fingerprint.viewport.width,
      height: fingerprint.viewport.height,
    },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    colorScheme: "light",
    ignoreDefaultArgs: ["--enable-automation"],
    proxy: proxy
      ? {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
        }
      : undefined,
    extraHTTPHeaders: {
      "Accept-Language": fingerprint.languages.join(","),
      "sec-ch-ua": fingerprint.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-sandbox",
      `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
    ],
  });

  await context.addInitScript(buildStealthInitScript(fingerprint));

  // Nuke any residual storage just in case
  await context.clearCookies();
  const page = context.pages()[0] || (await context.newPage());

  let egressIp: string | undefined;
  if (envTruthy("ISOLATED_CHECK_IP", true)) {
    try {
      await page.goto("about:blank");
      // lightweight IP check via request from context (uses proxy)
      const req = await context.request.get("https://api.ipify.org?format=json", {
        timeout: 12_000,
      });
      if (req.ok()) {
        const j = (await req.json()) as { ip?: string };
        egressIp = j.ip;
      }
    } catch {
      egressIp = await detectEgressIp(page);
    }
    console.log(
      `[IsolatedBrowser] egress IP=${egressIp || "unknown"} session=${id.slice(0, 8)}`,
    );
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    // Wipe profile so next session cannot reuse disk artifacts
    rmProfileDir(profileDir);
    clearFingerprintCache(fpId);
    console.log(`[IsolatedBrowser] closed+wiped session=${id.slice(0, 8)}`);
  };

  return {
    id,
    fingerprint,
    profileDir,
    proxy,
    egressIp,
    browser: null, // persistent context owns the browser
    context,
    page,
    close,
  };
}
