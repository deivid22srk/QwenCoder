/*
 * Qwen email activation via mail.tm inbox.
 *
 * Capture (2026-07-19 full session) showed:
 *   Subject: Activate your account / qwen.ai active mail.
 *   Link: https://chat.qwen.ai/api/v1/auths/activate?id={uuid}&token={hex64}
 *   Valid 7 days.
 *
 * Proof of activation: after GET activate, POST signin with sha256 password
 * must return 200 + token (not "incorrect password" / unverified).
 */

import crypto from "crypto";
import type { MailTmAccount } from "./mail-tm.ts";
import {
  getMailTmMessage,
  listMailTmMessages,
  waitForMailTmMessage,
} from "./mail-tm.ts";

export interface EmailVerifyResult {
  success: boolean;
  activateUrl?: string;
  userId?: string;
  activateToken?: string;
  error?: string;
  messageId?: string;
  subject?: string;
  elapsedMs: number;
  /** True when signin after activate returned a session token */
  loginProved?: boolean;
  signinStatus?: number;
}

const ACTIVATE_RE =
  /https?:\/\/chat\.qwen\.ai\/api\/v1\/auths\/activate\?id=([a-f0-9-]+)&(?:amp;)?token=([a-f0-9]+)/i;

const ACTIVATE_RE_LOOSE =
  /chat\.qwen\.ai\/api\/v1\/auths\/activate\?id=([a-f0-9-]+)(?:&|&amp;)token=([a-f0-9]+)/i;

export function extractActivateLink(content: string): {
  url: string;
  id: string;
  token: string;
} | null {
  // Unescape common email encodings
  const text = content
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/=\r?\n/g, "") // quoted-printable soft breaks
    .replace(/=3D/gi, "=");

  let m = text.match(ACTIVATE_RE) || text.match(ACTIVATE_RE_LOOSE);
  if (!m) {
    // Try HTML href
    const href = text.match(
      /href=["'](https?:\/\/chat\.qwen\.ai\/api\/v1\/auths\/activate\?[^"']+)["']/i,
    );
    if (href) {
      const decoded = href[1]
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&");
      m = decoded.match(ACTIVATE_RE) || decoded.match(ACTIVATE_RE_LOOSE);
      if (m) {
        return {
          url: `https://chat.qwen.ai/api/v1/auths/activate?id=${m[1]}&token=${m[2]}`,
          id: m[1],
          token: m[2],
        };
      }
    }
    return null;
  }
  return {
    url: `https://chat.qwen.ai/api/v1/auths/activate?id=${m[1]}&token=${m[2]}`,
    id: m[1],
    token: m[2],
  };
}

function messageBlob(msg: {
  subject?: string;
  intro?: string;
  text?: string;
  html?: string[];
}): string {
  const parts = [
    msg.subject || "",
    msg.intro || "",
    msg.text || "",
    ...(msg.html || []),
  ];
  return parts.join("\n");
}

function hashPasswordSha256(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Prove account is usable after activate — Qwen signin uses sha256(password).
 */
export async function proveQwenLogin(
  email: string,
  plainPassword: string,
): Promise<{ ok: boolean; status: number; userId?: string; hasToken: boolean; detail?: string }> {
  const sha = hashPasswordSha256(plainPassword);
  const res = await fetch("https://chat.qwen.ai/api/v1/auths/signin", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      source: "web",
      "user-agent":
        process.env.USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ email, password: sha }),
  });
  const text = await res.text().catch(() => "");
  let userId: string | undefined;
  let hasToken = false;
  try {
    const j = JSON.parse(text);
    userId = j?.id;
    hasToken = !!(j?.token || j?.id);
  } catch {
    /* ignore */
  }
  const detail = text.slice(0, 180);
  return {
    ok: res.ok && hasToken,
    status: res.status,
    userId,
    hasToken,
    detail,
  };
}

async function hitActivate(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent":
        process.env.USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    },
  });
  const body = await res.text().catch(() => "");
  // Hit once more — some flows need double navigate
  if (res.ok || (res.status >= 200 && res.status < 400)) {
    await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,*/*",
        "user-agent":
          process.env.USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
    }).catch(() => null);
  }
  return {
    ok: res.ok || (res.status >= 200 && res.status < 400),
    status: res.status,
    body,
  };
}

/**
 * Poll mail.tm until Qwen activation email arrives, then GET the activate link.
 * If plainPassword is provided, prove activation with real signin.
 */
export async function verifyQwenEmail(
  mailTm: MailTmAccount,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    /** Already-known token from signup JWT/user if available */
    expectEmail?: string;
    /** Plain password to prove login after activate */
    plainPassword?: string;
  } = {},
): Promise<EmailVerifyResult> {
  const t0 = Date.now();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const expectEmail = options.expectEmail || mailTm.address;

  console.log(
    `[EmailVerify] Polling mail.tm for activate link (${mailTm.address})...`,
  );

  const deadline = Date.now() + timeoutMs;
  let lastErr: string | undefined;
  let pendingLink: {
    url: string;
    id: string;
    token: string;
    messageId?: string;
    subject?: string;
  } | null = null;

  while (Date.now() < deadline) {
    try {
      const list = await listMailTmMessages(mailTm.token);
      for (const item of list) {
        const full = await getMailTmMessage(mailTm.token, item.id);
        const blob = messageBlob(full);
        const subj = (full.subject || item.subject || "").toLowerCase();
        const looksQwen =
          subj.includes("activate") ||
          subj.includes("active mail") ||
          subj.includes("qwen") ||
          blob.toLowerCase().includes("activate your account") ||
          blob.includes("auths/activate");

        if (!looksQwen && list.length > 1) continue;

        const link = extractActivateLink(blob);
        if (!link) {
          if (looksQwen) {
            lastErr = "Qwen email found but activate link missing";
            console.warn(`[EmailVerify] ${lastErr} id=${item.id}`);
          }
          continue;
        }

        pendingLink = {
          ...link,
          messageId: item.id,
          subject: full.subject || item.subject,
        };

        console.log(
          `[EmailVerify] Found activate link id=${link.id} token=${link.token.slice(0, 12)}…`,
        );

        const act = await hitActivate(link.url);
        console.log(
          `[EmailVerify] GET activate → HTTP ${act.status} ok=${act.ok} body=${act.body.slice(0, 80).replace(/\s+/g, " ")}`,
        );

        if (!act.ok) {
          lastErr = `Activate HTTP ${act.status}: ${act.body.slice(0, 200)}`;
          continue;
        }

        // Prove with real signin when we have the Qwen password
        if (options.plainPassword) {
          await new Promise((r) => setTimeout(r, 800));
          const proof = await proveQwenLogin(expectEmail, options.plainPassword);
          console.log(
            `[EmailVerify] Signin proof status=${proof.status} ok=${proof.ok} hasToken=${proof.hasToken} userId=${proof.userId || "-"}`,
          );
          if (proof.ok) {
            return {
              success: true,
              activateUrl: link.url,
              userId: proof.userId || link.id,
              activateToken: link.token,
              messageId: item.id,
              subject: full.subject || item.subject,
              elapsedMs: Date.now() - t0,
              loginProved: true,
              signinStatus: proof.status,
            };
          }
          // Activate GET may have worked but account not ready yet — keep polling
          lastErr = `Activate GET ok but signin failed: ${proof.detail}`;
          console.warn(`[EmailVerify] ${lastErr} — retry shortly`);
          await new Promise((r) => setTimeout(r, 2000));
          const proof2 = await proveQwenLogin(expectEmail, options.plainPassword);
          if (proof2.ok) {
            return {
              success: true,
              activateUrl: link.url,
              userId: proof2.userId || link.id,
              activateToken: link.token,
              messageId: item.id,
              subject: full.subject || item.subject,
              elapsedMs: Date.now() - t0,
              loginProved: true,
              signinStatus: proof2.status,
            };
          }
          // Still return activate-success if GET worked; flag loginProved false
          return {
            success: true,
            activateUrl: link.url,
            userId: link.id,
            activateToken: link.token,
            messageId: item.id,
            subject: full.subject || item.subject,
            elapsedMs: Date.now() - t0,
            loginProved: false,
            signinStatus: proof2.status,
            error: `Activate hit OK but login proof failed: ${proof2.detail}`,
          };
        }

        return {
          success: true,
          activateUrl: link.url,
          userId: link.id,
          activateToken: link.token,
          messageId: item.id,
          subject: full.subject || item.subject,
          elapsedMs: Date.now() - t0,
          loginProved: false,
        };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[EmailVerify] poll error: ${lastErr}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // One last waitFor convenience
  const late = await waitForMailTmMessage(mailTm.token, {
    timeoutMs: 5_000,
    intervalMs: 2_000,
  });
  if (late) {
    const link = extractActivateLink(messageBlob(late));
    if (link) {
      const act = await hitActivate(link.url);
      if (act.ok) {
        let loginProved = false;
        let signinStatus: number | undefined;
        if (options.plainPassword) {
          const proof = await proveQwenLogin(expectEmail, options.plainPassword);
          loginProved = proof.ok;
          signinStatus = proof.status;
        }
        return {
          success: true,
          activateUrl: link.url,
          userId: link.id,
          activateToken: link.token,
          messageId: late.id,
          subject: late.subject,
          elapsedMs: Date.now() - t0,
          loginProved,
          signinStatus,
        };
      }
    }
  }

  // If we hit activate but never got clean return, still report link
  if (pendingLink && options.plainPassword) {
    const proof = await proveQwenLogin(expectEmail, options.plainPassword);
    if (proof.ok) {
      return {
        success: true,
        activateUrl: pendingLink.url,
        userId: proof.userId || pendingLink.id,
        activateToken: pendingLink.token,
        messageId: pendingLink.messageId,
        subject: pendingLink.subject,
        elapsedMs: Date.now() - t0,
        loginProved: true,
        signinStatus: proof.status,
      };
    }
  }

  return {
    success: false,
    error: lastErr || `No activation email within ${timeoutMs}ms`,
    elapsedMs: Date.now() - t0,
  };
}
