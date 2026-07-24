/**
 * Qwen Account Registration Module
 * Handles automatic account creation via Qwen API
 */

import type { Page } from "playwright";
import crypto from "crypto";

export interface RegisterCredentials {
  username: string;
  email: string;
  password: string;
}

export interface RegisterResult {
  success: boolean;
  token?: string;
  error?: string;
}

/**
 * Hash password with SHA-256 (same as Qwen login)
 */
function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Generate a random username
 */
export function generateUsername(): string {
  const adjectives = ["Swift", "Bright", "Calm", "Bold", "Keen", "Wise", "Pure", "True"];
  const nouns = ["Fox", "Wolf", "Bear", "Hawk", "Lynx", "Deer", "Owl", "Seal"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999);
  return `${adj}${noun}${num}`;
}

/**
 * Generate a random email using temporary email services
 * Note: You'll need to integrate with a temp email API
 */
export function generateTempEmail(domain: string = "tempmail.com"): string {
  const random = Math.random().toString(36).substring(2, 10);
  return `user_${random}@${domain}`;
}

/**
 * Generate a random password
 */
export function generatePassword(length: number = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Register a new account via Qwen API
 * Route: POST https://chat.qwen.ai/api/v2/auths/signup
 * Page:  https://chat.qwen.ai/auth?mode=register
 */
export async function registerViaApi(
  page: Page,
  credentials: RegisterCredentials,
): Promise<RegisterResult> {
  try {
    // Navigate to register page
    await page.goto("https://chat.qwen.ai/auth?mode=register", {
      waitUntil: "domcontentloaded",
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Hash password
    const hashedPassword = hashPassword(credentials.password);

    // Call signup API
    const result = await page.evaluate(
      async ({ username, email, password }) => {
        try {
          const response = await fetch(
            "https://chat.qwen.ai/api/v2/auths/signup",
            {
              method: "POST",
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                source: "web",
                timezone: new Date().toString().split(" (")[0],
                "x-request-id": crypto.randomUUID(),
              },
              body: JSON.stringify({
                username,
                email,
                password,
                login_type: "email",
              }),
            },
          );
          const data = await response.json();
          return { ok: response.ok, data };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      },
      {
        username: credentials.username,
        email: credentials.email,
        password: hashedPassword,
      },
    );

    if (result.ok && (result.data?.token || result.data?.success !== false)) {
      // Navigate to main page to set cookies
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
      });
      return {
        success: true,
        token: result.data?.token,
      };
    }

    return {
      success: false,
      error: result.error || result.data?.message || "Registration failed",
    };
  } catch (err) {
    console.warn(`[Register] API registration error: ${err}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Register via UI (fill form and submit)
 * Page: https://chat.qwen.ai/auth?mode=register
 */
export async function registerViaUi(
  page: Page,
  credentials: RegisterCredentials,
): Promise<RegisterResult> {
  try {
    // Navigate to register page
    await page.goto("https://chat.qwen.ai/auth?mode=register", {
      waitUntil: "domcontentloaded",
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Fill username
    const usernameInput = page.locator('input[name="username"]');
    await usernameInput.fill(credentials.username);

    // Fill email
    const emailInput = page.locator('input[name="email"]');
    await emailInput.fill(credentials.email);

    // Fill password
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(credentials.password);

    // Fill confirm password
    const confirmPasswordInput = page.locator(
      'input[name="checkPassword"], input[name="confirmPassword"]',
    );
    if ((await confirmPasswordInput.count()) > 0) {
      await confirmPasswordInput.first().fill(credentials.password);
    }

    // Check terms checkbox
    const checkbox = page.locator(".ant-checkbox-input, input[type='checkbox']");
    if ((await checkbox.count()) > 0 && !(await checkbox.first().isChecked())) {
      await checkbox.first().check({ force: true });
    }

    // Click submit button
    const submitButton = page.locator('button[type="submit"]');
    await submitButton.click();

    // Wait for navigation
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check if registration succeeded
    const currentUrl = page.url();
    if (!currentUrl.includes("auth") && !currentUrl.includes("login")) {
      return { success: true };
    }

    return { success: false, error: "Registration failed - still on auth page" };
  } catch (err) {
    console.warn(`[Register] UI registration error: ${err}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Auto-register a new account with generated credentials
 */
export async function autoRegister(page: Page): Promise<RegisterResult & { credentials?: RegisterCredentials }> {
  const credentials: RegisterCredentials = {
    username: generateUsername(),
    email: generateTempEmail(),
    password: generatePassword(),
  };

  const result = await registerViaApi(page, credentials);

  return {
    ...result,
    credentials: result.success ? credentials : undefined,
  };
}
