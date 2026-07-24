/*
 * Emergency auto-create when rotation has no usable account.
 *
 * Triggered by the chat pipeline (server) when:
 *  - zero accounts configured, or
 *  - every account was tried / dead and getNextAvailableAccount returns null
 *
 * Creates exactly 1 account per wave (mutex). User can disable with
 * AUTO_CREATE_ACCOUNT_ON_EXHAUST=0.
 */

import { addAccount, loadAccounts, type QwenAccount } from "../core/accounts.ts";
import { createQwenAccountAuto } from "./account-register.ts";

const MIN_INTERVAL_MS = Number(
  process.env.AUTO_CREATE_MIN_INTERVAL_MS || 45_000,
);

let inFlight: Promise<QwenAccount | null> | null = null;
let lastFinishAt = 0;
let lastSuccessId: string | null = null;

export function isAutoCreateEnabled(): boolean {
  const raw = String(process.env.AUTO_CREATE_ACCOUNT_ON_EXHAUST ?? "1")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Create + persist one Qwen account (mail.tm + captcha + email verify).
 * Safe to call concurrently — coalesces into a single in-flight create.
 */
export async function createAndPersistOneAccount(
  reason: string,
): Promise<QwenAccount | null> {
  if (!isAutoCreateEnabled()) {
    console.warn(
      `[AutoCreate] skipped (disabled) reason=${reason}`,
    );
    return null;
  }

  if (inFlight) {
    console.log(
      `[AutoCreate] already in flight — waiting (reason=${reason})`,
    );
    return inFlight;
  }

  const sinceLast = Date.now() - lastFinishAt;
  if (lastFinishAt > 0 && sinceLast < MIN_INTERVAL_MS) {
    // If we just created one, return it from DB if present
    if (lastSuccessId) {
      const existing = loadAccounts().find((a) => a.id === lastSuccessId);
      if (existing) {
        console.log(
          `[AutoCreate] reusing last create ${existing.email} (${Math.round(sinceLast / 1000)}s ago)`,
        );
        return existing;
      }
    }
    console.warn(
      `[AutoCreate] rate-limited (${Math.round((MIN_INTERVAL_MS - sinceLast) / 1000)}s left) reason=${reason}`,
    );
    return null;
  }

  inFlight = (async () => {
    const prevHeadless = process.env.REGISTER_HEADLESS;
    // Server path: always headless unless user forced false
    if (process.env.REGISTER_HEADLESS !== "false") {
      process.env.REGISTER_HEADLESS = "true";
    }
    process.env.SOLVER_HUMAN_SLIDER_TRAVEL =
      process.env.SOLVER_HUMAN_SLIDER_TRAVEL ?? "0";

    console.log(
      `[AutoCreate] ══ emergency create (reason=${reason}) ══`,
    );
    const t0 = Date.now();

    try {
      const result = await createQwenAccountAuto();
      const creds = result.credentials;

      if (!result.success || !creds) {
        console.error(
          `[AutoCreate] FAIL after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${result.error || "unknown"}`,
        );
        return null;
      }

      let account: QwenAccount;
      try {
        account = addAccount(creds.email, creds.password);
      } catch (err: any) {
        if (String(err?.message || "").toLowerCase().includes("already exists")) {
          const hit = loadAccounts().find((a) => a.email === creds.email);
          if (hit) {
            lastSuccessId = hit.id;
            console.log(
              `[AutoCreate] account already in DB: ${creds.email}`,
            );
            return hit;
          }
        }
        throw err;
      }

      lastSuccessId = account.id;
      console.log(
        `[AutoCreate] OK ${creds.email} id=${account.id} ` +
          `emailVerified=${result.emailVerified} ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s (reason=${reason})`,
      );
      console.log(
        `[AutoCreate] credentials email=${creds.email} password=${creds.password}`,
      );
      return account;
    } catch (err) {
      console.error(
        `[AutoCreate] exception:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      if (prevHeadless === undefined) {
        delete process.env.REGISTER_HEADLESS;
      } else {
        process.env.REGISTER_HEADLESS = prevHeadless;
      }
      lastFinishAt = Date.now();
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * If there are zero accounts, create one. Returns true if pool is non-empty after.
 */
export async function ensureAtLeastOneAccount(
  reason = "empty pool",
): Promise<boolean> {
  if (loadAccounts().length > 0) return true;
  const created = await createAndPersistOneAccount(reason);
  return !!created || loadAccounts().length > 0;
}
