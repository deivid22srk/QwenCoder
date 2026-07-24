/*
 * Native HTTP Qwen account creation (primary path).
 *
 * Flow from live capture (2026-07-19):
 *   1. GET  /auth?mode=register          (warm cookies)
 *   2. POST /api/v1/auths/signup         body: name/email/sha256/agree/module
 *   3. If WAF HTML → needsCaptcha (caller does minimal captcha assist)
 *   4. Retry POST /api/v1/auths/signup?u_atoken=&u_asig=&u_aref=undefined
 *   5. GET  /api/v1/auths/               confirm token
 */

import crypto from "crypto";

const QWEN_ORIGIN = "https://chat.qwen.ai";
const AUTH_PAGE = `${QWEN_ORIGIN}/auth?mode=register`;
const SIGNUP_URL = `${QWEN_ORIGIN}/api/v1/auths/signup`;
const AUTHS_ME_URL = `${QWEN_ORIGIN}/api/v1/auths/`;

const DEFAULT_AVATAR_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface HttpRegisterCredentials {
  name: string;
  email: string;
  password: string;
}

export interface HttpRegisterResult {
  success: boolean;
  needsCaptcha?: boolean;
  wafBlocked?: boolean;
  status?: number;
  error?: string;
  userId?: string;
  token?: string;
  email?: string;
  name?: string;
  cookies?: string[];
  cookieHeader?: string;
  rawBody?: string;
  method: "http";
  elapsedMs?: number;
  /** For captcha retry */
  signupBody?: Record<string, unknown>;
  xRequestId?: string;
}

export function hashPasswordSha256(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function timezone(): string {
  return new Date().toString().split(" (")[0];
}

function mergeCookies(
  existing: string[],
  setCookie: string[],
): string[] {
  const map = new Map<string, string>();
  for (const c of existing) {
    const name = c.split("=")[0]?.trim();
    if (name) map.set(name, c.split(";")[0]);
  }
  for (const sc of setCookie) {
    const part = sc.split(";")[0];
    const name = part.split("=")[0]?.trim();
    if (name) map.set(name, part);
  }
  return [...map.values()];
}

function extractSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

function buildHeaders(
  cookies: string[],
  extra?: Record<string, string>,
  requestId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    source: "web",
    timezone: timezone(),
    "x-request-id": requestId || crypto.randomUUID(),
    version: process.env.QWEN_CDN_VERSION || "0.2.74",
    "bx-v": process.env.QWEN_BX_V || "2.5.36",
    origin: QWEN_ORIGIN,
    referer: AUTH_PAGE,
    "user-agent":
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    ...extra,
  };
  if (cookies.length) headers.cookie = cookieHeader(cookies);
  return headers;
}

function isWafHtml(body: string, contentType: string | null): boolean {
  const ct = (contentType || "").toLowerCase();
  const lower = body.toLowerCase();
  if (ct.includes("html")) return true;
  return (
    lower.includes("aliyun_waf") ||
    lower.includes("aliyuncaptcha") ||
    lower.includes("waf_nc") ||
    lower.includes("<!doctype")
  );
}

function parseUser(data: any): {
  userId?: string;
  token?: string;
  email?: string;
  name?: string;
} {
  if (!data || typeof data !== "object") return {};
  if (data.token || data.id) {
    return {
      userId: data.id,
      token: data.token,
      email: data.email,
      name: data.name,
    };
  }
  const user = data.user || data.data || {};
  return {
    userId: user.id,
    token: user.token || data.token,
    email: user.email,
    name: user.name,
  };
}

function buildSignupBody(credentials: HttpRegisterCredentials) {
  const avatar =
    process.env.QWEN_REGISTER_AVATAR_DATA_URL ||
    `data:image/png;base64,${DEFAULT_AVATAR_PNG_B64}`;
  return {
    name: credentials.name,
    email: credentials.email,
    password: hashPasswordSha256(credentials.password),
    agree: true,
    profile_image_url: avatar,
    oauth_sub: "",
    oauth_token: "",
    module: "chat",
  };
}

async function warmSession(): Promise<string[]> {
  const res = await fetch(AUTH_PAGE, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent":
        process.env.USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9",
    },
    redirect: "follow",
  });
  return extractSetCookies(res);
}

async function fetchMe(
  cookies: string[],
  token?: string,
): Promise<{
  success: boolean;
  userId?: string;
  token?: string;
  email?: string;
  name?: string;
  cookies: string[];
}> {
  try {
    const headers = buildHeaders(cookies, {
      referer: `${QWEN_ORIGIN}/`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    const res = await fetch(AUTHS_ME_URL, { method: "GET", headers });
    cookies = mergeCookies(cookies, extractSetCookies(res));
    if (!res.ok) return { success: false, cookies };
    const data = await res.json();
    const parsed = parseUser(data);
    if (parsed.token || parsed.userId) {
      return { success: true, ...parsed, cookies };
    }
  } catch {
    // ignore
  }
  return { success: false, cookies };
}

/**
 * Pure HTTP signup. Returns needsCaptcha when WAF challenges.
 * Pass captchaQuery to retry after solving captcha.
 */
export async function registerQwenAccountHttp(
  credentials: HttpRegisterCredentials,
  options: {
    captchaQuery?: {
      u_atoken?: string;
      u_asig?: string;
      u_aref?: string;
    };
    cookies?: string[];
    xRequestId?: string;
    skipWarm?: boolean;
  } = {},
): Promise<HttpRegisterResult> {
  const t0 = Date.now();
  let cookies = options.cookies ? [...options.cookies] : [];
  const xRequestId = options.xRequestId || crypto.randomUUID();
  const signupBody = buildSignupBody(credentials);

  try {
    if (!options.skipWarm && cookies.length === 0) {
      cookies = await warmSession();
    }

    let url = SIGNUP_URL;
    if (options.captchaQuery?.u_atoken || options.captchaQuery?.u_asig) {
      const q = new URLSearchParams();
      if (options.captchaQuery.u_atoken)
        q.set("u_atoken", options.captchaQuery.u_atoken);
      if (options.captchaQuery.u_asig)
        q.set("u_asig", options.captchaQuery.u_asig);
      q.set("u_aref", options.captchaQuery.u_aref || "undefined");
      url = `${SIGNUP_URL}?${q.toString()}`;
    }

    console.log(`[RegisterHTTP] POST ${url.replace(/\?.*/, "?…")}`);
    console.log(
      `[RegisterHTTP] name=${credentials.name} email=${credentials.email}`,
    );

    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cookies, undefined, xRequestId),
      body: JSON.stringify(signupBody),
      redirect: "manual",
    });

    cookies = mergeCookies(cookies, extractSetCookies(res));
    const rawBody = await res.text();
    const contentType = res.headers.get("content-type");
    const elapsedMs = Date.now() - t0;

    if (isWafHtml(rawBody, contentType)) {
      console.log(
        `[RegisterHTTP] WAF challenge in ${elapsedMs}ms — captcha assist needed`,
      );
      return {
        success: false,
        needsCaptcha: true,
        wafBlocked: true,
        status: res.status,
        method: "http",
        error: "WAF captcha challenge on signup",
        cookies,
        cookieHeader: cookieHeader(cookies),
        rawBody: rawBody.slice(0, 3000),
        elapsedMs,
        signupBody,
        xRequestId,
      };
    }

    let data: any = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      /* non-json */
    }

    if (res.ok && data) {
      const parsed = parseUser(data);
      if (parsed.token || parsed.userId) {
        return {
          success: true,
          status: res.status,
          method: "http",
          ...parsed,
          email: parsed.email || credentials.email,
          name: parsed.name || credentials.name,
          cookies,
          cookieHeader: cookieHeader(cookies),
          elapsedMs,
          signupBody,
          xRequestId,
        };
      }
      // 200 JSON without token — verify session
      const me = await fetchMe(cookies, parsed.token);
      if (me.success) {
        return {
          success: true,
          status: res.status,
          method: "http",
          userId: me.userId,
          token: me.token,
          email: me.email || credentials.email,
          name: me.name || credentials.name,
          cookies: me.cookies,
          cookieHeader: cookieHeader(me.cookies),
          elapsedMs: Date.now() - t0,
          signupBody,
          xRequestId,
        };
      }
    }

    // Empty 200 after captcha retry sometimes — check /auths/
    if (res.ok) {
      const me = await fetchMe(cookies);
      if (me.success) {
        return {
          success: true,
          status: res.status,
          method: "http",
          userId: me.userId,
          token: me.token,
          email: me.email || credentials.email,
          name: me.name || credentials.name,
          cookies: me.cookies,
          cookieHeader: cookieHeader(me.cookies),
          elapsedMs: Date.now() - t0,
          signupBody,
          xRequestId,
        };
      }
    }

    const apiMsg =
      data?.detail ||
      data?.message ||
      data?.error ||
      data?.msg ||
      `Signup failed HTTP ${res.status}`;

    return {
      success: false,
      needsCaptcha: res.status === 401 || res.status === 403,
      status: res.status,
      method: "http",
      error: String(apiMsg),
      cookies,
      cookieHeader: cookieHeader(cookies),
      rawBody: rawBody.slice(0, 2000),
      elapsedMs: Date.now() - t0,
      signupBody,
      xRequestId,
    };
  } catch (err) {
    return {
      success: false,
      method: "http",
      error: err instanceof Error ? err.message : String(err),
      cookies,
      elapsedMs: Date.now() - t0,
      signupBody,
      xRequestId,
    };
  }
}
