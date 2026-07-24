/*
 * Client for the embedded Aliyun puzzle captcha solver
 * (vendored from glm5.2proxy account-creator / aliyun-captcha-solver).
 *
 * API:
 *   GET  /health
 *   POST /solve  { browser: { host, port }, targetUrl, captchaOpenMode, ... }
 *   GET  /jobs/:id
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const CAPTCHA_API =
  process.env.CAPTCHA_API ||
  process.env.ZCODE_ACCOUNT_CREATOR_CAPTCHA_API ||
  "http://127.0.0.1:8787";

const CAPTCHA_API_START_TIMEOUT_MS = Number(
  process.env.CAPTCHA_API_START_TIMEOUT_MS || "30000",
);
const POLL_JOB_INTERVAL_MS = Number(
  process.env.CAPTCHA_POLL_JOB_INTERVAL_MS || "1000",
);
const POLL_JOB_TIMEOUT_MS = Number(
  process.env.CAPTCHA_POLL_JOB_TIMEOUT_MS || "120000",
);
const CAPTCHA_RETRIES = Number(process.env.CAPTCHA_RETRIES || "3");
const CAPTCHA_GESTURE =
  process.env.CAPTCHA_GESTURE || "human_replay";

const DEFAULT_WORKDIR = path.join(ROOT, "tools", "aliyun-captcha-solver");
const FALLBACK_WORKDIRS = [
  process.env.CAPTCHA_API_WORKDIR || "",
  DEFAULT_WORKDIR,
  path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    "Documents",
    "glm5.2proxy",
    "internal",
    "automation",
    "assets",
    "aliyun-captcha-solver",
  ),
].filter(Boolean);

let apiStartPromise: Promise<unknown> | null = null;
let spawnedChild: ChildProcess | null = null;

async function fetchJSON(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url, options);
  const text = await r.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: r.ok, status: r.status, data };
}

async function waitForHealth(timeoutMs = CAPTCHA_API_START_TIMEOUT_MS) {
  const started = Date.now();
  let lastErr: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchJSON(`${CAPTCHA_API}/health`);
      if (result.ok && result.data?.ok) {
        return result.data;
      }
      lastErr = new Error(`health HTTP ${result.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Captcha API not ready in ${timeoutMs}ms: ${msg}`);
}

function launchSpecFor(workDir: string): {
  command: string;
  args: string[];
  label: string;
} | null {
  if (fs.existsSync(path.join(workDir, "server.js"))) {
    return {
      command: process.execPath,
      args: ["server.js"],
      label: "node server.js",
    };
  }
  return null;
}

async function startLocalAPI() {
  const errors: string[] = [];
  for (const workDir of FALLBACK_WORKDIRS) {
    if (!fs.existsSync(workDir)) {
      errors.push(`${workDir}: missing`);
      continue;
    }
    const spec = launchSpecFor(workDir);
    if (!spec) {
      errors.push(`${workDir}: no server.js`);
      continue;
    }
    try {
      console.log(
        `[Captcha] Starting API: ${spec.label} in ${workDir}`,
      );
      const child = spawn(spec.command, spec.args, {
        cwd: workDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          API_HOST: "127.0.0.1",
          API_PORT: String(new URL(CAPTCHA_API).port || "8787"),
        },
      });
      child.unref();
      spawnedChild = child;
      console.log(`[Captcha] API process pid=${child.pid}`);
      const health = await waitForHealth();
      console.log("[Captcha] API health ok");
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${workDir}: ${message}`);
      console.warn(`[Captcha] Failed to start API at ${workDir}: ${message}`);
    }
  }
  throw new Error(
    `Could not start Aliyun Captcha API. Tried: ${errors.join(" | ")}`,
  );
}

export async function ensureCaptchaApi() {
  try {
    return await waitForHealth(1500);
  } catch {
    // start local
  }
  if (!apiStartPromise) {
    apiStartPromise = (async () => {
      try {
        return await startLocalAPI();
      } catch (error) {
        apiStartPromise = null;
        throw error;
      }
    })();
  }
  return apiStartPromise;
}

export interface CaptchaSolveOptions {
  cdpHost?: string;
  cdpPort?: number;
  targetUrl?: string;
  /** captcha already open after "Criar Conta" */
  captchaOpenMode?: "captcha_only" | "open_if_needed";
  reuseOpenCaptcha?: boolean;
  retries?: number;
  gestureProfile?: string;
  waitForPuzzleTimeout?: number;
}

export interface CaptchaSolveResult {
  success: boolean;
  attempts?: number;
  confidence?: number;
  captchaVerifyParam?: string | null;
  error?: string;
  jobId?: string;
}

export async function solveAliyunCaptcha(
  options: CaptchaSolveOptions = {},
): Promise<CaptchaSolveResult> {
  await ensureCaptchaApi();

  const body = {
    browser: {
      host: options.cdpHost || process.env.CDP_HOST || "127.0.0.1",
      port: options.cdpPort || Number(process.env.CDP_PORT || "9222"),
    },
    targetUrl: options.targetUrl || "https://chat.qwen.ai/auth?mode=register",
    captchaOpenMode: options.captchaOpenMode || "captcha_only",
    retries: options.retries ?? CAPTCHA_RETRIES,
    gestureProfile: options.gestureProfile || CAPTCHA_GESTURE,
    reuseOpenCaptcha: options.reuseOpenCaptcha ?? true,
    waitForPuzzleTimeout: options.waitForPuzzleTimeout ?? 45_000,
    verbose: true,
    debugScreenshots: true,
    debugDir: "artifacts/qwen-register",
  };

  console.log("[Captcha] POST /solve", {
    host: body.browser.host,
    port: body.browser.port,
    mode: body.captchaOpenMode,
    retries: body.retries,
  });

  const { ok, status, data } = await fetchJSON(`${CAPTCHA_API}/solve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!ok) {
    return {
      success: false,
      error: data?.error?.message || `POST /solve failed HTTP ${status}`,
    };
  }

  const jobId = data.jobId as string;
  if (!jobId) {
    // some versions return result inline
    if (data.success != null) {
      return {
        success: Boolean(data.success),
        attempts: data.attempts,
        confidence: data.confidence,
        captchaVerifyParam: data.captchaVerifyParam,
        error: data.error,
      };
    }
    return { success: false, error: "No jobId in /solve response" };
  }

  const start = Date.now();
  while (Date.now() - start < POLL_JOB_TIMEOUT_MS) {
    const jobRes = await fetchJSON(`${CAPTCHA_API}/jobs/${jobId}`);
    const job = jobRes.data;
    const st = job?.status;
    console.log(`[Captcha] job ${jobId} status=${st}`);

    if (st === "succeeded") {
      return {
        success: true,
        attempts: job.result?.attempts,
        confidence: job.result?.confidence,
        captchaVerifyParam: job.result?.captchaVerifyParam,
        jobId,
      };
    }
    if (st === "failed") {
      return {
        success: false,
        error: job.result?.error || "captcha solve failed",
        jobId,
      };
    }
    if (st === "error") {
      return {
        success: false,
        error: job.error?.message || "captcha infra error",
        jobId,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_JOB_INTERVAL_MS));
  }

  return {
    success: false,
    error: `Timeout waiting for captcha job ${jobId}`,
    jobId,
  };
}
