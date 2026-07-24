/*
 * File: errors.ts
 * Project: QwenBridge
 * Description: Error handling utilities for chat completions
 */

import { Context } from "hono";
import { sendOpenAIError, createError } from "../../api/error-helpers.js";
import type { QwenBridgeStatusCode } from "../../core/errors.js";

/**
 * Detects whether an upstream error code/message represents a quota limit
 * (i.e. the upstream Qwen service is overloaded or the account exceeded its
 * quota). When true, the request should be retried (possibly on another
 * account) instead of being propagated as a hard 502.
 *
 * Covers:
 *  - English: "Allocated quota exceeded", "quota exceeded", "token-limit",
 *    "insufficient quota", "rate limit", "RateLimited", "service is in high
 *    demand", "try again later".
 *  - Portuguese: "alta demanda", "tente novamente mais tarde", "serviço está
 *    com alta demanda".
 *  - Upstream error codes: "quota_limit", "quota_exceeded", "ratelimited",
 *    "rate_limited".
 */
export function isQuotaLimitError(code: string, details: string): boolean {
  const normalizedCode = (code || "").toLowerCase();
  const normalizedDetails = (details || "").toLowerCase();

  // Code-based detection (most reliable — matches the upstream `code` field)
  if (
    normalizedCode === "quota_limit" ||
    normalizedCode === "quota_exceeded" ||
    normalizedCode === "ratelimited" ||
    normalizedCode === "rate_limited" ||
    normalizedCode === "insufficient_quota"
  ) {
    return true;
  }

  // Code substring fallback (catches variants like `quota.foo`, `rate_limit.x`)
  if (
    normalizedCode.includes("quota") ||
    normalizedCode.includes("rate_limit") ||
    normalizedCode.includes("ratelimit")
  ) {
    return true;
  }

  // Message-based detection (English)
  if (
    normalizedDetails.includes("allocated quota exceeded") ||
    normalizedDetails.includes("quota exceeded") ||
    normalizedDetails.includes("increase your quota") ||
    normalizedDetails.includes("token-limit") ||
    normalizedDetails.includes("insufficient quota") ||
    normalizedDetails.includes("rate limit") ||
    normalizedDetails.includes("ratelimited") ||
    normalizedDetails.includes("high demand") ||
    normalizedDetails.includes("try again later")
  ) {
    return true;
  }

  // Message-based detection (Portuguese — chat.qwen.ai returns PT-BR messages
  // for some accounts/regions, e.g. "O serviço está com alta demanda no
  // momento. Tente novamente mais tarde.")
  if (
    normalizedDetails.includes("alta demanda") ||
    normalizedDetails.includes("tente novamente") ||
    normalizedDetails.includes("cota excedida") ||
    normalizedDetails.includes("limite de cota") ||
    normalizedDetails.includes("serviço está com alta demanda")
  ) {
    return true;
  }

  return false;
}

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details =
        payload.data?.details || payload.message || "Qwen returned an error";
      const wait =
        payload.data?.num !== undefined
          ? ` Wait about ${payload.data.num} hour(s) before trying again.`
          : "";
      const status =
        code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return {
        message: `Qwen upstream error: ${code}: ${details}.${wait}`,
        status,
      };
    }
    if (payload && payload.error) {
      const msg =
        typeof payload.error === "string"
          ? payload.error
          : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body
    return {
      message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`,
      status: 502,
    };
  }

  return null;
}

export function sendUpstreamError(c: Context, status: number, message: string) {
  return sendOpenAIError(
    c,
    createError(status as QwenBridgeStatusCode, message),
  );
}

export function sendValidationError(
  c: Context,
  message: string,
  field?: string,
) {
  return sendOpenAIError(c, createError(400, message, field));
}

export function sendNotFoundError(c: Context, message: string) {
  return sendOpenAIError(c, createError(404, message));
}
