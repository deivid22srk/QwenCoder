/**
 * Browser manager - handles Playwright initialization, header capture, and account state
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import type { AccountConfig, AccountState, AntiBotConfig, CapturedHeaders } from "./types.js";
import { getFingerprintProfile } from "./fingerprint.js";
import { getStealthScript } from "./stealth.js";
import { sleep } from "./human-behavior.js";

// Try to load stealth plugin
let chromiumWithStealth: typeof chromium | null = null;

try {
  const pwExtra = await import("playwright-extra");
  const stealth = await import("puppeteer-extra-plugin-stealth");

  if (pwExtra.chromium && stealth.default) {
    const plugin = stealth.default();
    pwExtra.chromium.use(plugin);
    chromiumWithStealth = pwExtra.chromium;
    console.log("[BrowserManager] Stealth plugin loaded");
  }
} catch {
  console.warn("[BrowserManager] playwright-extra/stealth not available, using regular playwright");
}

// Per-account state
const accountStates = new Map<string, AccountState>();
const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();

const DEFAULT_CONFIG: AntiBotConfig = {
  headerCacheTtlMs: 5 * 60 * 1000, // 5 minutes
  rateLimitCooldownMs: 10 * 60 * 1000, // 10 minutes
  headless: true,
  profileDir: "./data/profiles",
};

let config: AntiBotConfig = { ...DEFAULT_CONFIG };

export function configureAntiBot(userConfig: Partial<AntiBotConfig>): void {
  config = { ...config, ...userConfig };
}

export function getAccountState(accountId: string): AccountState | undefined {
  return accountStates.get(accountId);
}

export function isAccountAvailable(accountId: string): boolean {
  const state = accountStates.get(accountId);
  if (!state) return true;
  if (!state.isRateLimited) return true;
  return Date.now() > state.rateLimitedUntil;
}

export function markAccountRateLimited(accountId: string): void {
  const state = accountStates.get(accountId);
  if (state) {
    state.isRateLimited = true;
    state.rateLimitedUntil = Date.now() + config.rateLimitCooldownMs;
    console.log(`[BrowserManager] Account ${accountId} rate limited until ${new Date(state.rateLimitedUntil).toISOString()}`);
  }
}

export function clearRateLimit(accountId: string): void {
  const state = accountStates.get(accountId);
  if (state) {
    state.isRateLimited = false;
    state.rateLimitedUntil = 0;
  }
}

/**
 * Initialize browser for an account
 */
export async function initAccount(account: AccountConfig): Promise<void> {
  if (accountPages.has(account.id)) {
    console.log(`[BrowserManager] Already initialized for ${account.id}`);
    return;
  }

  const profilePath = path.resolve(config.profileDir, account.id);
  const fingerprint = getFingerprintProfile(account.id);

  console.log(`[BrowserManager] Launching browser for ${account.id}...`);

  const engineToUse = chromiumWithStealth || chromium;

  const context = await engineToUse.launchPersistentContext(profilePath, {
    headless: config.headless,
    userAgent: fingerprint.userAgent,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezoneId,
    viewport: fingerprint.viewport,
    screen: fingerprint.viewport,
    extraHTTPHeaders: {
      "sec-ch-ua": fingerprint.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
    ],
  });

  // Inject stealth script
  await context.addInitScript(getStealthScript(fingerprint));

  const page = await context.newPage();
  accountContexts.set(account.id, context);
  accountPages.set(account.id, page);

  // Initialize account state
  accountStates.set(account.id, {
    id: account.id,
    headers: null,
    lastRefresh: 0,
    isRateLimited: false,
    rateLimitedUntil: 0,
  });

  console.log(`[BrowserManager] Browser initialized for ${account.id}`);
}

/**
 * Capture anti-bot headers by intercepting a real browser request
 */
export async function captureHeaders(accountId: string): Promise<CapturedHeaders | null> {
  const page = accountPages.get(accountId);
  if (!page) {
    console.error(`[BrowserManager] No page for account ${accountId}`);
    return null;
  }

  const state = accountStates.get(accountId);
  if (!state) return null;

  console.log(`[BrowserManager] Capturing headers for ${accountId}...`);

  return new Promise<CapturedHeaders | null>((resolve) => {
    let resolved = false;
    const done = (headers: CapturedHeaders | null) => {
      if (resolved) return;
      resolved = true;
      if (headers) {
        state.headers = headers;
        state.lastRefresh = Date.now();
      }
      resolve(headers);
    };

    const timeout = setTimeout(async () => {
      console.warn(`[BrowserManager] Header capture timeout for ${accountId}`);
      await page.unroute("**/api/v2/chat/completions*").catch(() => {});
      done(null);
    }, 30000);

    const routeHandler = async (route: any, request: any) => {
      if (resolved) {
        await route.abort("aborted").catch(() => {});
        return;
      }
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      const headers: CapturedHeaders = {
        cookie: reqHeaders["cookie"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "2.5.36",
        "user-agent": reqHeaders["user-agent"] || "",
      };

      console.log(`[BrowserManager] Headers captured for ${accountId}`);

      await route.abort("aborted").catch(() => {});
      await page.unroute("**/api/v2/chat/completions*").catch(() => {});
      done(headers);
    };

    page
      .route("**/api/v2/chat/completions*", routeHandler)
      .then(async () => {
        // Navigate and trigger a request
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
        });
        await sleep(2000);

        // Type and send to trigger API call
        const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
        try {
          await page.focus(inputSelector);
          await page.fill(inputSelector, "");
          await page.type(inputSelector, "a", { delay: 100 });
          await sleep(2000);

          // Try to click send
          const sendSelectors = [
            ".message-input-right-button-send .send-button",
            ".chat-prompt-send-button",
            "button.send-button",
          ];

          let clicked = false;
          for (const selector of sendSelectors) {
            try {
              const btn = await page.$(selector);
              if (btn && (await btn.isVisible())) {
                await page.evaluate((sel) => {
                  const element = document.querySelector(sel) as HTMLElement;
                  if (element) {
                    element.focus();
                    element.click();
                  }
                }, selector);
                await btn.click({ force: true, delay: 50 }).catch(() => {});
                clicked = true;
                break;
              }
            } catch {
              // Try next
            }
          }

          if (!clicked) {
            await page.keyboard.press("Enter");
          }
        } catch (err) {
          console.warn(`[BrowserManager] Error triggering request: ${err}`);
          clearTimeout(timeout);
          await page.unroute("**/api/v2/chat/completions*").catch(() => {});
          done(null);
        }
      })
      .catch(async (err) => {
        console.warn(`[BrowserManager] Error setting up route: ${err}`);
        clearTimeout(timeout);
        done(null);
      });
  });
}

/**
 * Get cached headers or capture new ones if expired
 */
export async function getHeaders(accountId: string): Promise<CapturedHeaders | null> {
  const state = accountStates.get(accountId);
  if (!state) return null;

  // Check if headers are still valid
  if (state.headers && Date.now() - state.lastRefresh < config.headerCacheTtlMs) {
    return state.headers;
  }

  // Need to refresh
  return captureHeaders(accountId);
}

/**
 * Close browser for an account
 */
export async function closeAccount(accountId: string): Promise<void> {
  const context = accountContexts.get(accountId);
  const page = accountPages.get(accountId);

  if (page) {
    try {
      await page.close();
    } catch {}
  }

  if (context) {
    try {
      await context.close();
    } catch {}
  }

  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  accountStates.delete(accountId);

  console.log(`[BrowserManager] Closed browser for ${accountId}`);
}

/**
 * Close all browsers
 */
export async function closeAll(): Promise<void> {
  const accountIds = Array.from(accountContexts.keys());
  for (const id of accountIds) {
    await closeAccount(id);
  }
}

/**
 * Reset profile directory for an account (clears cookies/cache)
 */
export async function resetProfile(accountId: string): Promise<void> {
  await closeAccount(accountId);

  const profilePath = path.resolve(config.profileDir, accountId);
  if (fs.existsSync(profilePath)) {
    fs.rmSync(profilePath, { recursive: true, force: true });
    console.log(`[BrowserManager] Reset profile for ${accountId}`);
  }
}
