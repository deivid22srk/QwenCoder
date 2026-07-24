/*
 * HTTP-native WAF assist for Qwen signup.
 *
 * Path A: page.evaluate POST /api/v1/auths/signup (pure HTTP body)
 * Path B: if WAF HTML but no embed UI → fast-fill form + click so SPA mounts captcha
 * Then: native bezier puzzle solver → capture tokens / session
 */

import { chromium, type Browser, type Page } from "playwright";
import crypto from "crypto";
import { registerQwenAccountHttp } from "./account-register-http.ts";
import { solveQwenPuzzleOnPage } from "./qwen-puzzle-solver.ts";
import {
  getFingerprintProfile,
  type FingerprintProfile,
} from "./fingerprint.ts";
import {
  launchIsolatedBrowser,
  type IsolatedSession,
} from "./isolated-browser.ts";

const AUTH_PAGE = "https://chat.qwen.ai/auth?mode=register";

/** Full stealth init — same family as playwright.ts account contexts. */
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
  `;
}

export interface WafAssistResult {
  success: boolean;
  error?: string;
  token?: string;
  userId?: string;
  email?: string;
  name?: string;
  u_atoken?: string;
  u_asig?: string;
  method: "http+waf";
  elapsedMs: number;
  puzzleAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function attachCapture(page: Page) {
  const captured: {
    u_atoken?: string;
    u_asig?: string;
    user?: any;
    verifyOk: boolean;
  } = { verifyOk: false };

  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/v1/auths/signup") && u.includes("u_atoken")) {
      try {
        const url = new URL(u);
        captured.u_atoken = url.searchParams.get("u_atoken") || undefined;
        captured.u_asig = url.searchParams.get("u_asig") || undefined;
        console.log(
          `[WafAssist] tokens atoken=${captured.u_atoken?.slice(0, 10)}… asig=${captured.u_asig?.slice(0, 10)}…`,
        );
      } catch {
        /* ignore */
      }
    }
  });

  page.on("response", async (res) => {
    try {
      const u = res.url();
      // ONLY real puzzle verify — never cloudauth device Log (ResultObject:true is fingerprint)
      if (
        /VerifyCaptchaV2|-verify\.captcha-open|Action=VerifyCaptcha/i.test(u) ||
        (u.includes("VerifyCaptcha") && !u.includes("cloudauth-device"))
      ) {
        const t = await res.text().catch(() => "");
        if (/"VerifyResult"\s*:\s*true|"VerifyCode"\s*:\s*"T001"/i.test(t)) {
          captured.verifyOk = true;
          console.log("[WafAssist] captcha verify OK (T001)");
        } else if (/"VerifyResult"\s*:\s*false/i.test(t)) {
          const m = t.match(/"VerifyCode"\s*:\s*"([^"]+)"/);
          console.log(
            `[WafAssist] captcha verify FAIL code=${m?.[1] || "?"}`,
          );
        }
      }
      if (!u.includes("/api/v1/auths/signup")) return;
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json") && !ct.includes("text")) return;
      const text = await res.text().catch(() => "");
      if (!text.trim().startsWith("{")) return;
      const data = JSON.parse(text);
      if (data?.token || data?.id) {
        captured.user = data;
        console.log(`[WafAssist] signup user id=${data.id}`);
      }
    } catch {
      /* ignore */
    }
  });

  return captured;
}

async function captchaVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Purple arrow is the real interactable control
    const slider = document.getElementById("aliyunCaptcha-sliding-slider");
    const bg = document.getElementById(
      "aliyunCaptcha-img",
    ) as HTMLImageElement | null;
    const block = document.getElementById("waf_nc_block");
    const embed = document.getElementById("aliyunCaptcha-window-embed");
    const blockOn = !!block && getComputedStyle(block).display !== "none";
    const sliderOk =
      !!slider &&
      slider.getBoundingClientRect().width > 8 &&
      getComputedStyle(slider).pointerEvents !== "none";
    return !!(
      sliderOk &&
      (blockOn || embed?.classList.contains("aliyunCaptcha-show")) &&
      bg &&
      (bg.naturalWidth > 20 || bg.complete)
    );
  });
}

async function httpSignupEvaluate(
  page: Page,
  body: Record<string, unknown>,
  xRequestId?: string,
) {
  return page.evaluate(
    async ({ body, xRequestId }) => {
      const res = await fetch("/api/v1/auths/signup", {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
          source: "web",
          timezone: new Date().toString().split(" (")[0],
          "x-request-id": xRequestId || crypto.randomUUID(),
          version: "0.2.74",
          "bx-v": "2.5.36",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text.trim().startsWith("{") ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return {
        status: res.status,
        isWaf: /aliyun_waf|<!doctype|waf_nc|AliyunCaptcha|Access Verification/i.test(
          text,
        ),
        json,
        hasToken: !!(json?.token || json?.id),
      };
    },
    { body, xRequestId },
  );
}

/** Fill a React/Ant input so controlled state updates */
async function fillReactInput(page: Page, selector: string, value: string) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 20_000 });
  await loc.click({ force: true });
  await loc.fill("");
  // type so React onChange fires (keep short delay for controlled inputs)
  await loc.pressSequentially(value, { delay: 10 });
  // blur to trigger validation
  await loc.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  });
}

/**
 * Check terms checkbox (Ant Design).
 * Must toggle visible wrapper — clicking hidden input alone often fails.
 */
async function checkTermsCheckbox(page: Page) {
  const input = page.locator(".ant-checkbox-input").first();
  const wrapper = page
    .locator(
      ".qwenchat-auth-pc-register-policy .ant-checkbox-wrapper, .ant-checkbox-wrapper",
    )
    .first();
  const inner = page.locator(".ant-checkbox-inner").first();

  // Already checked?
  const already =
    (await input.isChecked().catch(() => false)) ||
    (await page
      .locator(".ant-checkbox-checked")
      .count()
      .then((n) => n > 0)
      .catch(() => false));
  if (already) {
    console.log("[WafAssist] Checkbox already checked");
    return true;
  }

  // 1) click visible inner square
  console.log("[WafAssist] Checking terms checkbox...");
  await inner.click({ force: true }).catch(() => {});
  await sleep(80);
  if (await input.isChecked().catch(() => false)) {
    console.log("[WafAssist] Checkbox checked via .ant-checkbox-inner");
    return true;
  }

  // 2) click wrapper label
  await wrapper.click({ force: true }).catch(() => {});
  await sleep(80);
  if (await input.isChecked().catch(() => false)) {
    console.log("[WafAssist] Checkbox checked via wrapper");
    return true;
  }

  // 3) force via check()
  await input.check({ force: true }).catch(() => {});
  await sleep(60);
  if (await input.isChecked().catch(() => false)) {
    console.log("[WafAssist] Checkbox checked via input.check()");
    return true;
  }

  // 4) DOM force + events (string eval, no __name)
  await page.evaluate(`() => {
    var input = document.querySelector(".ant-checkbox-input");
    if (!input) return false;
    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    var wrap = document.querySelector(".ant-checkbox");
    if (wrap) wrap.classList.add("ant-checkbox-checked");
    var w2 = document.querySelector(".ant-checkbox-wrapper");
    if (w2) w2.classList.add("ant-checkbox-wrapper-checked");
    return input.checked;
  }`);
  await sleep(150);

  const ok = await input.isChecked().catch(() => false);
  console.log(`[WafAssist] Checkbox final checked=${ok}`);
  return ok;
}

/** Fast form fill so SPA mounts the real WAF captcha overlay */
async function triggerSpaCaptcha(
  page: Page,
  credentials: { name: string; email: string; password: string },
) {
  console.log("[WafAssist] Triggering SPA captcha via form + checkbox + Criar Conta...");
  try {
    await page.goto(AUTH_PAGE, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
  } catch (e) {
    console.warn(
      `[WafAssist] goto auth failed: ${e instanceof Error ? e.message : e}`,
    );
    throw e;
  }
  // Wait SPA hydrate via field visibility (no long fixed sleep / no CSS hacks)
  try {
    await page
      .locator('input[name="username"]')
      .waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    console.warn(
      `[WafAssist] username field not visible url=${page.url()} title=${await page.title().catch(() => "?")}`,
    );
    throw e;
  }

  // Ensure register mode (title / switch)
  const title = await page
    .locator(".qwenchat-auth-pc-title")
    .textContent()
    .catch(() => "");
  if (title && !/inscreva|sign up|register|criar/i.test(title)) {
    console.log("[WafAssist] Not on register — switching...");
    await page
      .locator(
        ".qwenchat-auth-pc-switch-button, text=Inscreva, text=Sign up, text=Criar",
      )
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page
      .locator('input[name="username"]')
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => {});
  }

  console.log("[WafAssist] Filling username/email/password...");
  await fillReactInput(page, 'input[name="username"]', credentials.name);
  await fillReactInput(page, 'input[name="email"]', credentials.email);
  await fillReactInput(page, 'input[name="password"]', credentials.password);
  await fillReactInput(
    page,
    'input[name="checkPassword"]',
    credentials.password,
  );

  // Terms checkbox — REQUIRED for button enable
  const checked = await checkTermsCheckbox(page);
  if (!checked) {
    console.warn("[WafAssist] Checkbox still unchecked — forcing DOM click on policy area");
    await page
      .locator(".qwenchat-auth-pc-register-policy")
      .click({ force: true })
      .catch(() => {});
    await page.locator(".ant-checkbox").first().click({ force: true }).catch(() => {});
    await sleep(300);
  }

  // Dump form state (must invoke IIFE — bare `() =>` returns undefined)
  const formState = await page.evaluate(`(() => {
    var u = document.querySelector('input[name="username"]');
    var e = document.querySelector('input[name="email"]');
    var p = document.querySelector('input[name="password"]');
    var c = document.querySelector('input[name="checkPassword"]');
    var cb = document.querySelector('.ant-checkbox-input');
    var btn = document.querySelector('button.qwenchat-auth-pc-submit-button, button[type="submit"]');
    return {
      username: u && u.value,
      email: e && e.value,
      passLen: p && p.value ? p.value.length : 0,
      checkLen: c && c.value ? c.value.length : 0,
      checkbox: !!(cb && cb.checked),
      btnDisabled: btn ? !!(btn.disabled || btn.classList.contains("disabled")) : null,
      btnText: btn ? (btn.textContent || "").trim() : null
    };
  })()`);
  console.log("[WafAssist] Form state:", JSON.stringify(formState));

  // Wait until submit enabled (or force enable)
  const enabled = await page
    .waitForFunction(
      `() => {
        var btn = document.querySelector("button.qwenchat-auth-pc-submit-button") ||
          document.querySelector('button[type="submit"]');
        if (!btn) return false;
        return !btn.disabled && !btn.classList.contains("disabled");
      }`,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!enabled) {
    console.warn(
      "[WafAssist] Submit still disabled — removing disabled + clicking",
    );
    await page.evaluate(`() => {
      var btn = document.querySelector("button.qwenchat-auth-pc-submit-button") ||
        document.querySelector('button[type="submit"]');
      if (!btn) return;
      btn.disabled = false;
      btn.removeAttribute("disabled");
      btn.classList.remove("disabled");
    }`);
  }

  const submit = page
    .locator(
      'button.qwenchat-auth-pc-submit-button, button:has-text("Criar Conta"), button[type="submit"]',
    )
    .first();
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  console.log('[WafAssist] Clicking "Criar Conta"...');
  await submit.click({ force: true });
  // Poll immediately for purple arrow (native widget only — never mutate CSS)
  for (let i = 0; i < 30; i++) {
    if (await captchaVisible(page)) {
      console.log(`[WafAssist] Captcha appeared after ${(i + 1) * 100}ms`);
      return true;
    }
    // one re-click if still nothing after ~600ms
    if (i === 6) {
      await submit.click({ force: true }).catch(() => {});
    }
    await sleep(100);
  }
  console.warn("[WafAssist] Captcha did not appear after Criar Conta");
  return false;
}

async function waitForAccount(
  page: Page,
  captured: ReturnType<typeof attachCapture>,
  credentials: { name: string; email: string; password: string },
  cookies: string[] | undefined,
  xRequestId: string | undefined,
  puzzleAttempts: number,
  t0: number,
): Promise<WafAssistResult | null> {
  for (let i = 0; i < 60; i++) {
    if (captured.user?.token || captured.user?.id) {
      return {
        success: true,
        method: "http+waf",
        token: captured.user.token,
        userId: captured.user.id,
        email: captured.user.email,
        name: captured.user.name,
        u_atoken: captured.u_atoken,
        u_asig: captured.u_asig,
        puzzleAttempts,
        elapsedMs: Date.now() - t0,
      };
    }

    if (captured.u_atoken && captured.u_asig && (i === 10 || i === 25)) {
      console.log("[WafAssist] HTTP retry with u_atoken/u_asig...");
      const retry = await registerQwenAccountHttp(credentials, {
        captchaQuery: {
          u_atoken: captured.u_atoken,
          u_asig: captured.u_asig,
          u_aref: "undefined",
        },
        cookies,
        xRequestId,
        skipWarm: true,
      });
      if (retry.success) {
        return {
          success: true,
          method: "http+waf",
          token: retry.token,
          userId: retry.userId,
          email: retry.email,
          name: retry.name,
          u_atoken: captured.u_atoken,
          u_asig: captured.u_asig,
          puzzleAttempts,
          elapsedMs: Date.now() - t0,
        };
      }
    }

    if (captured.verifyOk || i > 5) {
      const me = await page
        .evaluate(async () => {
          try {
            const r = await fetch("/api/v1/auths/", {
              headers: { accept: "application/json" },
            });
            if (!r.ok) return null;
            return await r.json();
          } catch {
            return null;
          }
        })
        .catch(() => null);
      if (me?.token || me?.id) {
        return {
          success: true,
          method: "http+waf",
          token: me.token,
          userId: me.id,
          email: me.email,
          name: me.name,
          u_atoken: captured.u_atoken,
          u_asig: captured.u_asig,
          puzzleAttempts,
          elapsedMs: Date.now() - t0,
        };
      }
    }

    if (!page.url().includes("/auth")) {
      const me = await page
        .evaluate(async () => {
          try {
            const r = await fetch("/api/v1/auths/", {
              headers: { accept: "application/json" },
            });
            if (!r.ok) return null;
            return await r.json();
          } catch {
            return null;
          }
        })
        .catch(() => null);
      if (me?.token || me?.id) {
        return {
          success: true,
          method: "http+waf",
          token: me.token,
          userId: me.id,
          email: me.email,
          name: me.name,
          puzzleAttempts,
          elapsedMs: Date.now() - t0,
        };
      }
    }

    await sleep(350);
  }
  return null;
}

export async function assistWafCaptchaAndSignup(options: {
  signupBody: Record<string, unknown>;
  credentials: { name: string; email: string; password: string };
  xRequestId?: string;
  cookies?: string[];
  headless?: boolean;
}): Promise<WafAssistResult> {
  const t0 = Date.now();
  const headless =
    options.headless ?? process.env.REGISTER_HEADLESS === "true";

  let browser: Browser | null = null;
  let isolated: IsolatedSession | null = null;

  try {
    // ── Dolphin-style clean room (default ON) ──
    // Fresh profile dir + fingerprint + optional rotating proxy each run.
    const useIsolated =
      String(process.env.ISOLATED_BROWSER ?? "1").trim() !== "0";

    let page: Page;

    if (useIsolated) {
      isolated = await launchIsolatedBrowser({
        headless,
        label: options.credentials?.email || "waf",
      });
      page = isolated.page;
      console.log(
        `[WafAssist] ISOLATED dolphin-session id=${isolated.id.slice(0, 8)} ` +
          `ip=${isolated.egressIp || "?"} fp=${isolated.fingerprint.chromeVersion} ` +
          `proxy=${isolated.proxy?.server || "direct"}`,
      );
    } else {
      // Legacy path (not recommended for captcha)
      const fpId =
        options.credentials?.email?.trim().toLowerCase() ||
        crypto.randomBytes(8).toString("hex");
      const fingerprint = getFingerprintProfile(fpId);
      let engine: typeof chromium = chromium;
      try {
        const pwExtra = await import("playwright-extra");
        const stealth = await import("puppeteer-extra-plugin-stealth");
        if (pwExtra.chromium && stealth.default) {
          pwExtra.chromium.use(stealth.default());
          engine = pwExtra.chromium;
        }
      } catch {
        /* plain */
      }
      browser = await engine.launch({
        headless,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--disable-dev-shm-usage",
        ],
      });
      const context = await browser.newContext({
        viewport: fingerprint.viewport,
        locale: fingerprint.locale,
        timezoneId: fingerprint.timezoneId,
        userAgent: fingerprint.userAgent,
        extraHTTPHeaders: {
          "Accept-Language": fingerprint.languages.join(","),
          "sec-ch-ua": fingerprint.secChUa,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
      });
      await context.addInitScript(buildStealthInitScript(fingerprint));
      page = await context.newPage();
      console.log(`[WafAssist] legacy browser (ISOLATED_BROWSER=0)`);
    }

    const captured = attachCapture(page);

    // SPA form is the only path that mounts #aliyunCaptcha-sliding-slider
    console.log(
      "[WafAssist] SPA form → mount purple ARROW (no CSS hacks)...",
    );
    let hasCaptcha = await triggerSpaCaptcha(page, options.credentials);

    if (!hasCaptcha) {
      for (let i = 0; i < 20; i++) {
        if (await captchaVisible(page)) {
          hasCaptcha = true;
          break;
        }
        await sleep(250);
      }
    }

    if (!hasCaptcha) {
      return {
        success: false,
        method: "http+waf",
        error: "WAF captcha never appeared (no purple arrow slider)",
        elapsedMs: Date.now() - t0,
      };
    }

    const arrowBox = await page
      .locator("#aliyunCaptcha-sliding-slider")
      .boundingBox();
    console.log(
      `[WafAssist] Arrow ready ${JSON.stringify(arrowBox)} — CDP solver (max 3 tries)...`,
    );

    // Few tries: F008 burns the IP. Default 3 (was 5).
    // Base/AliyunCaptcha.js is the SDK law — do NOT re-init SDK; only CDP-drag arrow.
    const puzzle = await solveQwenPuzzleOnPage(page, {
      maxAttempts: Number(process.env.CAPTCHA_MAX_RETRIES || 3),
    });

    if (!puzzle.success) {
      return {
        success: false,
        method: "http+waf",
        error: puzzle.error || "puzzle failed",
        puzzleAttempts: puzzle.attempts,
        elapsedMs: Date.now() - t0,
      };
    }

    console.log(
      `[WafAssist] Puzzle OK method=${puzzle.method} attempts=${puzzle.attempts} conf=${puzzle.confidence ?? "?"}`,
    );

    const done = await waitForAccount(
      page,
      captured,
      options.credentials,
      options.cookies,
      options.xRequestId,
      puzzle.attempts,
      t0,
    );
    if (done) return done;

    return {
      success: false,
      method: "http+waf",
      error: "Puzzle OK but session/token not established",
      u_atoken: captured.u_atoken,
      u_asig: captured.u_asig,
      puzzleAttempts: puzzle.attempts,
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      success: false,
      method: "http+waf",
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (isolated) await isolated.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
