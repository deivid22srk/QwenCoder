/*
 * Qwen account registration — HTTP native first.
 *
 * 1) mail.tm + creds
 * 2) POST /api/v1/auths/signup (pure HTTP, seconds)
 * 3) If WAF → minimal browser HTTP assist (page.evaluate signup + captcha)
 * 4) If tokens only → HTTP retry with u_atoken/u_asig
 * 5) Playwright form fill ONLY if all of the above die
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import net from "net";
import { config } from "../core/config.ts";
import { listAccounts } from "../core/accounts.ts";
import { getFingerprintProfile } from "./fingerprint.ts";
import { createMailTmInbox, type MailTmAccount } from "./mail-tm.ts";
import { registerQwenAccountHttp } from "./account-register-http.ts";
import { assistWafCaptchaAndSignup } from "./waf-captcha-assist.ts";
import { verifyQwenEmail } from "./qwen-email-verify.ts";
import { solveQwenPuzzleOnPage } from "./qwen-puzzle-solver.ts";

const QWEN_AUTH_REGISTER = "https://chat.qwen.ai/auth?mode=register";
const QWEN_HOME = "https://chat.qwen.ai/";

export interface RegisterCredentials {
  username: string;
  email: string;
  password: string;
}

export interface RegisterResult {
  success: boolean;
  error?: string;
  credentials?: RegisterCredentials;
  method?: "http" | "http+waf" | "ui";
  mailTm?: MailTmAccount;
  token?: string;
  userId?: string;
  elapsedMs?: number;
  emailVerified?: boolean;
  activateUrl?: string;
  captcha?: {
    success: boolean;
    attempts?: number;
    confidence?: number;
    error?: string;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function nextQwenUsername(): string {
  const n = listAccounts().length + 1;
  return `QwenAcc${n}`;
}

export function generateUsername(): string {
  return nextQwenUsername();
}

export function generatePassword(length = 16): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*";
  const all = upper + lower + digits + special;
  const pick = (set: string) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = chars.length; i < length; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Full auto create — HTTP is king.
 */
export async function createQwenAccountAuto(): Promise<RegisterResult> {
  const t0 = Date.now();
  console.log("[Register] Creating temp inbox on mail.tm...");
  const mailTm = await createMailTmInbox();
  console.log(`[Register] mail.tm inbox: ${mailTm.address}`);

  const credentials: RegisterCredentials = {
    username: nextQwenUsername(),
    email: mailTm.address,
    password: generatePassword(16),
  };

  console.log("[Register] Credentials:");
  console.log(`  Username: ${credentials.username}`);
  console.log(`  Email:    ${credentials.email}`);
  console.log(`  Password: ${credentials.password}`);

  const result = await createQwenAccount(credentials, mailTm);
  return { ...result, elapsedMs: result.elapsedMs ?? Date.now() - t0 };
}

/**
 * After signup succeeds, poll mail.tm and GET /api/v1/auths/activate?id=&token=
 */
async function finalizeWithEmailVerify(
  result: RegisterResult,
  credentials: RegisterCredentials,
  mailTm?: MailTmAccount,
): Promise<RegisterResult> {
  if (!result.success) return result;
  if (!mailTm?.token) {
    console.warn(
      "[Register] No mail.tm token — skip email activate (account may stay pending)",
    );
    return { ...result, emailVerified: false };
  }

  console.log("[Register] [email] Waiting for activate mail + hitting link...");
  const ev = await verifyQwenEmail(mailTm, {
    timeoutMs: Number(process.env.EMAIL_VERIFY_TIMEOUT_MS || 180_000),
    expectEmail: credentials.email,
    plainPassword: credentials.password,
  });

  if (ev.success) {
    console.log(
      `[Register] Email activated in ${ev.elapsedMs}ms loginProved=${ev.loginProved === true} → ${ev.activateUrl?.slice(0, 80)}…`,
    );
    return {
      ...result,
      emailVerified: true,
      activateUrl: ev.activateUrl,
      userId: result.userId || ev.userId,
      token: result.token,
      elapsedMs: (result.elapsedMs || 0) + ev.elapsedMs,
    };
  }

  console.warn(`[Register] Email activate failed: ${ev.error}`);
  // Signup worked but email not activated — still return partial success
  return {
    ...result,
    emailVerified: false,
    error: result.error,
    // keep success=true for signup, but flag email
    elapsedMs: (result.elapsedMs || 0) + ev.elapsedMs,
  };
}

/**
 * Create account:
 *   HTTP → WAF assist → HTTP retry with tokens → Playwright form (last resort)
 */
export async function createQwenAccount(
  credentials: RegisterCredentials,
  mailTm?: MailTmAccount,
): Promise<RegisterResult> {
  const forceUi =
    process.env.REGISTER_FORCE_UI === "1" ||
    process.env.REGISTER_FORCE_UI === "true";

  if (forceUi) {
    console.log("[Register] REGISTER_FORCE_UI=1 — Playwright form only");
    return createQwenAccountViaPlaywright(credentials, mailTm);
  }

  // ── 1) Pure HTTP ──────────────────────────────────────────────
  console.log("[Register] [1/3] Pure HTTP signup...");
  let http = await registerQwenAccountHttp({
    name: credentials.username,
    email: credentials.email,
    password: credentials.password,
  });

  if (http.success) {
    console.log(
      `[Register] HTTP OK in ${http.elapsedMs ?? "?"}ms — no browser needed`,
    );
    return finalizeWithEmailVerify(
      {
        success: true,
        method: "http",
        credentials,
        mailTm,
        token: http.token,
        userId: http.userId,
        elapsedMs: http.elapsedMs,
      },
      credentials,
      mailTm,
    );
  }

  if (!http.needsCaptcha && !http.wafBlocked) {
    console.log(`[Register] HTTP hard fail: ${http.error}`);
    // still try WAF assist? only if not a clean validation error
    const msg = String(http.error || "").toLowerCase();
    if (
      msg.includes("already") ||
      msg.includes("exist") ||
      msg.includes("invalid email") ||
      msg.includes("password")
    ) {
      return {
        success: false,
        method: "http",
        credentials,
        mailTm,
        error: http.error,
        elapsedMs: http.elapsedMs,
      };
    }
  }

  // ── 2) Minimal WAF assist (HTTP body inside browser + captcha) ─
  if (!http.signupBody) {
    return {
      success: false,
      method: "http",
      credentials,
      mailTm,
      error: http.error || "HTTP signup failed without body for WAF assist",
      elapsedMs: http.elapsedMs,
    };
  }

  console.log(
    "[Register] [2/3] WAF blocked pure HTTP — minimal captcha assist (no form)...",
  );
  const assist = await assistWafCaptchaAndSignup({
    signupBody: http.signupBody,
    credentials: {
      name: credentials.username,
      email: credentials.email,
      password: credentials.password,
    },
    xRequestId: http.xRequestId,
    cookies: http.cookies,
  });

  if (!assist.success) {
    console.warn(
      `[Register] WAF assist failed (${assist.elapsedMs}ms): ${assist.error || "unknown"}`,
    );
  }

  if (assist.success) {
    console.log(`[Register] WAF assist OK in ${assist.elapsedMs}ms`);
    return finalizeWithEmailVerify(
      {
        success: true,
        method: "http+waf",
        credentials,
        mailTm,
        token: assist.token,
        userId: assist.userId,
        elapsedMs: assist.elapsedMs,
        captcha: {
          success: true,
          attempts: assist.puzzleAttempts,
        },
      },
      credentials,
      mailTm,
    );
  }

  // ── 2b) HTTP retry with captured tokens ───────────────────────
  if (assist.u_atoken && assist.u_asig && http.signupBody) {
    console.log("[Register] [2b] HTTP retry with u_atoken/u_asig...");
    const retry = await registerQwenAccountHttp(
      {
        name: credentials.username,
        email: credentials.email,
        password: credentials.password,
      },
      {
        captchaQuery: {
          u_atoken: assist.u_atoken,
          u_asig: assist.u_asig,
          u_aref: "undefined",
        },
        cookies: http.cookies,
        xRequestId: http.xRequestId,
        skipWarm: true,
      },
    );
    if (retry.success) {
      console.log(`[Register] HTTP retry OK in ${retry.elapsedMs}ms`);
      return finalizeWithEmailVerify(
        {
          success: true,
          method: "http",
          credentials,
          mailTm,
          token: retry.token,
          userId: retry.userId,
          elapsedMs: retry.elapsedMs,
        },
        credentials,
        mailTm,
      );
    }
    console.log(`[Register] HTTP retry failed: ${retry.error}`);
  }

  // ── 3) Last resort: full Playwright form ──────────────────────
  const allowUi =
    process.env.REGISTER_ALLOW_UI_FALLBACK !== "0" &&
    process.env.REGISTER_ALLOW_UI_FALLBACK !== "false";

  if (!allowUi) {
    return {
      success: false,
      method: "http+waf",
      credentials,
      mailTm,
      error: `HTTP+WAF failed (${assist.error || http.error}). UI fallback disabled.`,
      elapsedMs: assist.elapsedMs,
    };
  }

  console.log(
    "[Register] [3/3] LAST RESORT — Playwright form fill (slow path)...",
  );
  const ui = await createQwenAccountViaPlaywright(credentials, mailTm);
  if (ui.success) {
    return finalizeWithEmailVerify(ui, credentials, mailTm);
  }
  return ui;
}

// ─── Playwright form (last resort only) ─────────────────────────

function getStealthInitScript(profileJson: string): string {
  return `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try { delete navigator.__proto__.webdriver; } catch {}
    window.chrome = window.chrome || { runtime: {} };
  `;
}

async function findFreePort(preferred = 9222): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  if (await tryPort(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 50; p++) {
    if (await tryPort(p)) return p;
  }
  return preferred;
}

async function launchRegisterBrowser(accountId: string): Promise<{
  context: BrowserContext;
  page: Page;
  cdpPort: number;
}> {
  let chromiumWithStealth: typeof chromium | null = null;
  try {
    const pwExtra = await import("playwright-extra");
    const stealth = await import("puppeteer-extra-plugin-stealth");
    if (pwExtra.chromium && stealth.default) {
      pwExtra.chromium.use(stealth.default());
      chromiumWithStealth = pwExtra.chromium;
    }
  } catch {
    /* fallback */
  }

  const fingerprint = getFingerprintProfile(accountId);
  const profilePath = path.resolve("data", "qwen_profiles", accountId);
  fs.mkdirSync(profilePath, { recursive: true });
  const engine = chromiumWithStealth || chromium;
  const headless = process.env.REGISTER_HEADLESS === "true";
  const cdpPort = await findFreePort(
    Number(process.env.CDP_PORT || process.env.REGISTER_CDP_PORT || "9222"),
  );

  const context = await engine.launchPersistentContext(profilePath, {
    headless,
    userAgent: fingerprint.userAgent,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezoneId,
    viewport: fingerprint.viewport,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-sandbox",
    ],
  });
  await context.addInitScript(
    getStealthInitScript(
      JSON.stringify(fingerprint).replace(/</g, "\\u003c"),
    ),
  );
  const page = context.pages()[0] || (await context.newPage());
  return { context, page, cdpPort };
}

async function typeInto(page: Page, selector: string, value: string) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: config.timeouts.page });
  await input.click();
  await input.fill("");
  await input.pressSequentially(value, {
    delay: 20 + Math.floor(Math.random() * 30),
  });
}

export async function createQwenAccountViaPlaywright(
  credentials: RegisterCredentials,
  mailTm?: MailTmAccount,
): Promise<RegisterResult> {
  const accountId = crypto
    .createHash("md5")
    .update(credentials.email.trim().toLowerCase())
    .digest("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

  let context: BrowserContext | null = null;
  const t0 = Date.now();

  try {
    const launched = await launchRegisterBrowser(accountId);
    context = launched.context;
    const { page, cdpPort } = launched;

    await page.goto(QWEN_AUTH_REGISTER, {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });
    await sleep(2000);

    await typeInto(page, 'input[name="username"]', credentials.username);
    await typeInto(page, 'input[name="email"]', credentials.email);
    await typeInto(page, 'input[name="password"]', credentials.password);
    await typeInto(page, 'input[name="checkPassword"]', credentials.password);

    const checkbox = page.locator(".ant-checkbox-input").first();
    if (!(await checkbox.isChecked().catch(() => false))) {
      await page
        .locator(".ant-checkbox-wrapper, .qwenchat-auth-pc-register-policy label")
        .first()
        .click({ force: true })
        .catch(() => checkbox.check({ force: true }));
    }
    await sleep(400);

    const submit = page
      .locator(
        'button.qwenchat-auth-pc-submit-button, button[type="submit"], button:has-text("Criar Conta")',
      )
      .first();
    await page
      .waitForFunction(() => {
        const btn = document.querySelector(
          "button.qwenchat-auth-pc-submit-button",
        ) as HTMLButtonElement | null;
        return btn && !btn.disabled;
      }, { timeout: 10_000 })
      .catch(() => {});
    await submit.click({ force: true });
    await sleep(2000);

    // Captcha?
    const hasCaptcha = await page
      .locator(
        "#aliyunCaptcha-sliding-slider, #aliyunCaptcha-puzzle, #aliyunCaptcha-window-float",
      )
      .first()
      .isVisible()
      .catch(() => false);

    if (hasCaptcha) {
      await sleep(800);
      // UI fallback path: more attempts than the HTTP/WAF path (which defaults
      // to 3) because we're already on a slow path. Operators who want fewer
      // attempts (e.g. to avoid F008 IP throttling) can set
      // CAPTCHA_UI_FALLBACK_MAX_ATTEMPTS — defaults to 10 to preserve prior
      // behavior. CAPTCHA_MAX_RETRIES still applies to the HTTP/WAF path.
      const uiMaxAttempts = Number(
        process.env.CAPTCHA_UI_FALLBACK_MAX_ATTEMPTS ?? "10",
      );
      const captcha = await solveQwenPuzzleOnPage(page, {
        maxAttempts: uiMaxAttempts,
      });
      if (!captcha.success) {
        return {
          success: false,
          method: "ui",
          credentials,
          mailTm,
          error: captcha.error || "captcha failed",
          captcha: {
            success: false,
            attempts: captcha.attempts,
            confidence: captcha.confidence,
            error: captcha.error,
          },
          elapsedMs: Date.now() - t0,
        };
      }
      await sleep(2500);
    }

    for (let i = 0; i < 30; i++) {
      if (!page.url().includes("auth") && !page.url().includes("login")) {
        return {
          success: true,
          method: "ui",
          credentials,
          mailTm,
          elapsedMs: Date.now() - t0,
        };
      }
      await sleep(500);
    }

    return {
      success: false,
      method: "ui",
      credentials,
      mailTm,
      error: "Still on auth after form+captcha",
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      success: false,
      method: "ui",
      credentials,
      mailTm,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
