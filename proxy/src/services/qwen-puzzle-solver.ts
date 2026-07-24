/*
 * Aliyun PUZZLE captcha — Qwen WAF embed ONLY.
 *
 * Law (Base/AliyunCaptcha.js + Qwen DOM):
 *   - Do NOT re-init initAliyunCaptcha — widget already mounted by Qwen SPA
 *   - Do NOT use glm5.2proxy calibration as default (different scene/embed)
 *   - Drag ONLY #aliyunCaptcha-sliding-slider (purple arrow)
 *   - targetDisplayX = targetLeftX * (displayW/naturalW) + bias
 *   - travel ≈ targetDisplayX (embed ~1:1) — NO overshoot/settle
 *   - ONE open-loop CDP drag: slow→fast mid→overshoot 3–7px→settle back
 *     (no mid-evaluate, no long seat-correction — that flags antibot)
 *   - Max 3 attempts; abort F008×1 and F011×2 (don't burn IP)
 *   - Success = VerifyCode T001 only (never cloudauth Log)
 *   - Never mutate captcha CSS
 *
 * See Base/QWEN-CAPTCHA-DOCTRINE.md
 */

import type { CDPSession, Page, Response } from "playwright";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const visionUrl = pathToFileURL(
  path.resolve("src/services/aliyun-vision.mjs"),
).href;
const travelUrl = pathToFileURL(
  path.resolve("src/services/aliyun-slider-travel.mjs"),
).href;

const { templateMatch } = await import(visionUrl);
// travelUrl kept for optional human calibration experiments — default path is pure 1:1
void travelUrl;

export interface PuzzleSolveResult {
  success: boolean;
  attempts: number;
  targetX?: number;
  travelX?: number;
  confidence?: number;
  error?: string;
  method?: string;
  verifyCode?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** String eval avoids tsx injecting __name into browser */
async function evalStr<T>(page: Page, fnBody: string, arg?: unknown): Promise<T> {
  if (arg === undefined) {
    return (await page.evaluate(`(${fnBody})()`)) as T;
  }
  return (await page.evaluate(`(${fnBody})`, arg)) as T;
}

function attachVerifyWatcher(page: Page) {
  let code: string | null = null;
  let ok = false;
  page.on("response", async (res: Response) => {
    try {
      const u = res.url();
      if (u.includes("cloudauth-device")) return;
      if (!/VerifyCaptchaV2|-verify\.captcha-open|VerifyCaptcha/i.test(u)) return;
      const text = await res.text().catch(() => "");
      const m = text.match(/"VerifyCode"\s*:\s*"([^"]+)"/);
      if (m) code = m[1];
      if (
        /"VerifyResult"\s*:\s*true/.test(text) ||
        /"VerifyCode"\s*:\s*"T001"/.test(text)
      ) {
        ok = true;
        code = code || "T001";
      }
      if (/"VerifyResult"\s*:\s*false/.test(text)) ok = false;
    } catch {
      /* ignore */
    }
  });
  return {
    isOk: () => ok,
    code: () => code,
    reset: () => {
      ok = false;
      code = null;
    },
  };
}

async function waitCaptchaStable(page: Page, timeoutMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalStr<{
      ok: boolean;
      loading: boolean;
      sliderLeft: number;
      bgW: number;
      bgDisp: number;
    }>(
      page,
      `() => {
        var bg = document.getElementById("aliyunCaptcha-img");
        var pz = document.getElementById("aliyunCaptcha-puzzle");
        var slider = document.getElementById("aliyunCaptcha-sliding-slider");
        var loading = document.querySelector(".aliyunCaptcha-loading");
        var loadingOn = loading && getComputedStyle(loading).display !== "none";
        var sl = 0;
        if (slider && slider.style && slider.style.left) {
          sl = parseFloat(slider.style.left) || 0;
        }
        return {
          ok: !!(bg && pz && slider && bg.naturalWidth > 40 && pz.naturalWidth > 5
            && slider.getBoundingClientRect().width > 10 && !loadingOn
            && bg.complete && pz.complete),
          loading: !!loadingOn,
          sliderLeft: sl,
          bgW: bg ? bg.naturalWidth : 0,
          bgDisp: bg ? bg.getBoundingClientRect().width : 0
        };
      }`,
    );
    if (st.ok && st.sliderLeft < 8) return st;
    await sleep(120);
  }
  return null;
}

async function grabPng(page: Page, sel: string): Promise<Buffer> {
  try {
    const b64 = await evalStr<string>(
      page,
      `async (selector) => {
        var img = document.querySelector(selector);
        if (!img) throw new Error("missing");
        if (!img.complete || !img.naturalWidth) {
          await new Promise(function(res) {
            img.onload = function() { res(null); };
            setTimeout(function() { res(null); }, 5000);
          });
        }
        var c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        var ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }`,
      sel,
    );
    return Buffer.from(b64, "base64");
  } catch {
    try {
      const b64 = await evalStr<string>(
        page,
        `async (selector) => {
          var img = document.querySelector(selector);
          var url = img && (img.currentSrc || img.src);
          if (!url) throw new Error("no src");
          if (url.indexOf("data:") === 0) return url.split(",")[1];
          var r = await fetch(url);
          var ab = await r.arrayBuffer();
          var u8 = new Uint8Array(ab);
          var s = "";
          for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          return btoa(s);
        }`,
        sel,
      );
      return Buffer.from(b64, "base64");
    } catch {
      return page.locator(sel).first().screenshot({ type: "png" });
    }
  }
}

async function readOffsets(page: Page) {
  return evalStr<{
    puzzleLeft: number;
    sliderLeft: number;
    leftWidth: number;
    bgNaturalW: number;
    bgDisplayW: number;
    imgBoxW: number;
    trackW: number;
    sliderW: number;
  }>(
    page,
    `() => {
      function parse(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
      var puzzle = document.getElementById("aliyunCaptcha-puzzle");
      var slider = document.getElementById("aliyunCaptcha-sliding-slider");
      var left = document.getElementById("aliyunCaptcha-sliding-left");
      var bg = document.getElementById("aliyunCaptcha-img");
      var box = document.getElementById("aliyunCaptcha-img-box");
      var body = document.getElementById("aliyunCaptcha-sliding-body");
      var imgBoxW = box ? box.getBoundingClientRect().width : 0;
      var bgDisp = bg ? bg.getBoundingClientRect().width : 0;
      return {
        puzzleLeft: parse(puzzle && puzzle.style ? puzzle.style.left : "0"),
        sliderLeft: parse(slider && slider.style ? slider.style.left : "0"),
        leftWidth: parse(left && left.style ? left.style.width : "0"),
        bgNaturalW: bg ? bg.naturalWidth : 0,
        bgDisplayW: bgDisp,
        imgBoxW: imgBoxW || bgDisp,
        trackW: body ? body.getBoundingClientRect().width : 0,
        sliderW: slider ? slider.getBoundingClientRect().width : 40
      };
    }`,
  );
}

const quiet = () =>
  process.env.REGISTER_QUIET === "1" || process.env.REGISTER_QUIET === "true";
function slog(...args: unknown[]) {
  if (!quiet()) console.log(...args);
}
function swarn(...args: unknown[]) {
  if (!quiet()) console.warn(...args);
}

function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Human settle-back track (anti-bot):
 *   slow start → accelerate mid → pass hole by a few px → come back to seat.
 * No mid-path evaluate. No long correction loop after.
 * Matches industrial settle_back + user request ("passar um pouco e voltar").
 */
function planDragPath(
  startX: number,
  travel: number,
): { points: { x: number; y: number; waitMs: number }[]; durationMs: number } {
  const dist = Math.max(1, Math.round(travel));
  // Slight overshoot then settle — humans always do this on sliders
  const overshoot = clamp(3 + Math.floor(Math.random() * 5), 3, 8); // 3–7px past
  const peak = dist + overshoot;

  const goSteps = clamp(Math.round(dist / 4.5) + 16, 36, 52);
  const backSteps = clamp(5 + Math.floor(Math.random() * 4), 5, 9);

  const points: { x: number; y: number; waitMs: number }[] = [];
  let x = 0;
  let yDrift = 0;
  let prevT = 0;
  let t = 0;

  // ── GO: slow → fast mid → ease into peak ──
  for (let i = 1; i <= goSteps; i++) {
    const progress = i / goSteps;
    // ease-out: starts slow, accelerates, soft into peak
    const eased = easeOutCubic(progress);
    const rawX = Math.round(
      eased * peak + (Math.random() - 0.5) * (progress < 0.8 ? 0.85 : 0.35),
    );
    const nextX = clamp(
      Math.max(x + (progress < 0.15 ? 1 : 2), rawX),
      1,
      peak,
    );

    // Timing: slow start, snappy mid, slower near peak
    let dt: number;
    if (progress < 0.18) dt = 14 + Math.round(Math.random() * 8); // slow
    else if (progress < 0.72) dt = 8 + Math.round(Math.random() * 6); // fast mid
    else dt = 12 + Math.round(Math.random() * 9); // brake into overshoot

    // tiny mid hesitation once (human)
    if (i === Math.round(goSteps * 0.42)) dt += 18 + Math.round(Math.random() * 22);

    t += dt;
    x = i === goSteps ? peak : nextX;
    yDrift = clamp(yDrift + (Math.random() - 0.5) * 0.32, -1.3, 1.3);
    const y =
      yDrift +
      Math.sin(progress * Math.PI) * (0.16 + Math.random() * 0.12) +
      (Math.random() - 0.5) * 0.2;

    points.push({ x: startX + x, y, waitMs: t - prevT });
    prevT = t;
  }

  // Hold a beat past the hole (human "oops a bit far")
  t += 22 + Math.round(Math.random() * 18);
  points.push({
    x: startX + peak,
    y: yDrift * 0.4,
    waitMs: t - prevT,
  });
  prevT = t;

  // ── BACK: settle to exact target (the intentional reverse) ──
  for (let i = 1; i <= backSteps; i++) {
    const progress = i / backSteps;
    // ease-in-out pull back to dist
    const eased = easeInOutCubic(progress);
    const pos = Math.round(peak + (dist - peak) * eased);
    t += 14 + Math.round(Math.random() * 10);
    yDrift = clamp(yDrift * 0.7 + (Math.random() - 0.5) * 0.15, -0.6, 0.6);
    points.push({
      x: startX + pos,
      y: yDrift,
      waitMs: t - prevT,
    });
    prevT = t;
    x = pos;
  }

  // Final land + hold on exact seat
  t += 30 + Math.round(Math.random() * 24);
  points.push({ x: startX + dist, y: 0, waitMs: t - prevT });
  prevT = t;
  t += 20 + Math.round(Math.random() * 16);
  points.push({ x: startX + dist, y: 0, waitMs: t - prevT });

  return { points, durationMs: t };
}

/** CSS px for CDP Input.dispatchMouseEvent (industrial cssPx). */
const cssPx = (v: number) => Math.round(v);

type CdpClient = CDPSession;

async function getCdp(page: Page): Promise<CdpClient> {
  // Prefer real Chrome Input path — less "Playwright mouse" fingerprint
  return page.context().newCDPSession(page);
}

async function cdpMove(
  cdp: CdpClient,
  x: number,
  y: number,
  buttons = 0,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: cssPx(x),
    y: cssPx(y),
    buttons,
    pointerType: "mouse",
  });
}

async function cdpDown(cdp: CdpClient, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: cssPx(x),
    y: cssPx(y),
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
}

async function cdpUp(cdp: CdpClient, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: cssPx(x),
    y: cssPx(y),
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
}

/**
 * ONE open-loop human drag via CDP:
 *   slow → accelerate → slight overshoot → settle back → release.
 * NO mid-drag evaluate (flags bot). NO long seat-correction loop (flags bot).
 * Vision aims; this path only sells the gesture.
 */
async function dragPurpleArrowAligned(
  page: Page,
  coarseTravel: number,
  targetPuzzleLeft: number,
) {
  const arrow = page.locator("#aliyunCaptcha-sliding-slider").first();
  await arrow.waitFor({ state: "visible", timeout: 15_000 });
  const box = await arrow.boundingBox();
  if (!box) throw new Error("arrow box missing");

  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  const tHole = Math.round(targetPuzzleLeft);
  // Allow room for overshoot in the path (dist+7)
  const travel = clamp(Math.round(coarseTravel), 0, tHole + 42);
  const { points, durationMs } = planDragPath(sx, travel);

  const cdp = await getCdp(page);
  slog(
    `[PuzzleSolver] drag travel=${travel} target=${tHole} pts=${points.length} ~${Math.round(durationMs)}ms CDP settle-back`,
  );

  try {
    // Short approach — don't telegraph
    await cdpMove(cdp, sx - 12, sy);
    await sleep(rand(28, 48));
    await cdpMove(cdp, sx, sy);
    await sleep(rand(32, 55));

    await cdpDown(cdp, sx, sy);
    await sleep(rand(45, 75)); // press hold

    // Play full human path open-loop — no evaluate, no early-stop, no seat spam
    let curX = sx;
    let curY = sy;
    for (const p of points) {
      curX = p.x;
      curY = sy + p.y;
      await cdpMove(cdp, curX, curY, 1);
      await sleep(p.waitMs);
    }
    // Exact land
    curX = sx + travel;
    curY = sy;
    await cdpMove(cdp, curX, curY, 1);
    await sleep(rand(55, 95)); // settle hold before release

    await cdpUp(cdp, curX, curY);

    await sleep(140);
    const after = await readOffsets(page);
    const err = after.puzzleLeft - tHole;
    slog(
      `[PuzzleSolver] landed puzzle=${after.puzzleLeft.toFixed(1)} slider=${after.sliderLeft.toFixed(1)} target=${tHole} err=${err.toFixed(1)} seatCorr=0 via=CDP-settle`,
    );

    if (after.sliderLeft < 2 && after.puzzleLeft < 2) {
      throw new Error("Arrow did not move (widget did not latch pointer)");
    }
    return after;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function clickRefresh(page: Page) {
  await page
    .locator("#aliyunCaptcha-btn-refresh")
    .first()
    .click({ force: true })
    .catch(() => {});
  await sleep(500);
  for (let i = 0; i < 40; i++) {
    const loading = await evalStr<boolean>(
      page,
      `() => {
        var l = document.querySelector(".aliyunCaptcha-loading");
        return !!(l && getComputedStyle(l).display !== "none");
      }`,
    ).catch(() => false);
    if (!loading) break;
    await sleep(150);
  }
  await sleep(450);
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Trust aliyun-vision resolveFinalX. Only override on F015 with a distinct 2nd peak.
 * (Duplicate re-resolve here used to fight vision and pick snow false holes.)
 */
function resolveNaturalTarget(
  match: {
    x: number;
    targetLeftX: number;
    method?: string;
    edgeX?: number;
    contourX?: number;
    gapX?: number;
    brightX?: number;
    candidates?: { x: number; targetLeftX: number; score: number }[];
  },
  geometryFailStreak: number,
): { naturalX: number; label: string } {
  const base = finite(match.targetLeftX) ? match.targetLeftX : match.x;
  const label = String(match.method || "vision");

  // After F015: try 2nd vision candidate once if clearly different
  if (
    geometryFailStreak >= 1 &&
    Array.isArray(match.candidates) &&
    match.candidates.length > 1
  ) {
    const a = match.candidates[0];
    const b2 = match.candidates[1];
    if (
      b2.score >= a.score * 0.82 &&
      Math.abs(b2.targetLeftX - a.targetLeftX) >= 12
    ) {
      return { naturalX: Math.round(b2.targetLeftX), label: "peak2" };
    }
  }

  // Prefer pure structural when edge≈contour even if method said ensemble
  const e = match.edgeX;
  const c = match.contourX;
  if (finite(e) && finite(c) && Math.abs(e - c) <= 10) {
    const S = Math.round((e * 1.15 + c) / 2.15);
    if (S >= 120 && Math.abs(S - base) <= 22) {
      return { naturalX: S, label: "structural-lock" };
    }
  }

  return { naturalX: Math.round(base), label };
}

function pickCandidateTarget(
  match: {
    x: number;
    targetLeftX: number;
    method?: string;
    edgeX?: number;
    contourX?: number;
    gapX?: number;
    brightX?: number;
    candidates?: { x: number; targetLeftX: number; score: number }[];
  },
  scaleX: number,
  bias: number,
  geometryFailStreak: number,
): { naturalX: number; displayX: number; label: string } {
  const resolved = resolveNaturalTarget(match, geometryFailStreak);
  const displayX = Math.max(0, Math.round(resolved.naturalX * scaleX + bias));
  return {
    naturalX: resolved.naturalX,
    displayX,
    label: resolved.label,
  };
}

/**
 * Human T001 anchors: puzzle-target (display) → mouse/slider travel.
 * Proven near-hit: target 194 → travel ~221 → puzzle 190.
 * Forbidden: target/0.84 (slams to trackMax 258) and pure 1:1 (piece stays short).
 */
function interpolateTravelAnchors(target: number): number {
  const anchors: [number, number][] = [
    [120, 155],
    [140, 180],
    [151, 195],
    [160, 203],
    [170, 207],
    [182, 216],
    [193, 222],
    [204, 229],
    [216, 236],
    [228, 242],
    [240, 250],
    [249, 254],
  ];
  if (target <= anchors[0][0]) {
    const [x0, y0] = anchors[0];
    const [x1, y1] = anchors[1];
    const slope = (y1 - y0) / (x1 - x0);
    return y0 + (target - x0) * slope;
  }
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (target <= x1) {
      const r = (target - x0) / (x1 - x0 || 1);
      return y0 + (y1 - y0) * r;
    }
  }
  const [x0, y0] = anchors[anchors.length - 2];
  const [x1, y1] = anchors[anchors.length - 1];
  const slope = (y1 - y0) / (x1 - x0 || 1);
  return y1 + (target - x1) * slope;
}

function computeTravel(
  targetDisplayX: number,
  trackMax: number,
  _opts?: { displayW?: number; trackW?: number; sliderW?: number; pieceW?: number },
): { travel: number; target: number } {
  const target = clamp(Math.round(targetDisplayX), 8, trackMax);
  // Anchors map hole→mouse. Live: +3 bias + min(+10) overshot by ~4–6px (F015/F001).
  // Aim slightly conservative; pre-release seat pushes forward if short.
  // early-stop in drag prevents past-hole glide.
  let travel = Math.round(interpolateTravelAnchors(target));
  // settle-back ends on `travel`; live residual was ~4px short → +4 pad
  travel += Math.round(Number(process.env.SOLVER_SEAT_BIAS ?? "4"));
  travel = Math.min(travel, target + 38); // hard cap (no track-end slam)
  travel = Math.max(travel, target + 8); // piece lags slider
  travel = clamp(travel, 8, trackMax);
  return { travel, target };
}

export async function solveQwenPuzzleOnPage(
  page: Page,
  options: { maxAttempts?: number; debugDir?: string } = {},
): Promise<PuzzleSolveResult> {
  // Few attempts: each verify burns risk score. Default 3 (was 5 → F008).
  // Override via CAPTCHA_MAX_RETRIES env var.
  const maxAttempts =
    options.maxAttempts ?? Number(process.env.CAPTCHA_MAX_RETRIES ?? "3");
  const debugDir =
    options.debugDir ||
    path.resolve(
      "data",
      "captcha-debug",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );

  // Cooldown between verify attempts (ms). After F008 we wait longer because
  // the Aliyun risk engine throttles the IP/token — burning more verifies
  // immediately just produces more F008s. Tunable via env so operators can
  // lengthen it when running behind a single IP.
  const cooldownAfterF008Ms = Number(
    process.env.CAPTCHA_F008_COOLDOWN_MS ?? "900",
  );
  const cooldownDefaultMs = Number(
    process.env.CAPTCHA_RETRY_COOLDOWN_MS ?? "400",
  );

  const verify = attachVerifyWatcher(page);
  let lastCode: string | null = null;
  let ambiguousSkips = 0;
  let geometryFailStreak = 0;
  let f008Count = 0;
  let f011Count = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    verify.reset();
    slog(`[PuzzleSolver] attempt ${attempt}/${maxAttempts}`);

    // F008 = stop immediately (IP/token throttle). Never burn more verifies.
    if (f008Count >= 1) {
      swarn("[PuzzleSolver] abort F008 throttle — stop session");
      return {
        success: false,
        attempts: attempt - 1,
        error: "F008 throttle — too many verifies; try again later",
        verifyCode: "F008",
      };
    }
    // F011 twice = gesture/device burned. More retries only make F008.
    if (f011Count >= 2) {
      swarn("[PuzzleSolver] abort F011×2 — gesture/device flagged");
      return {
        success: false,
        attempts: attempt - 1,
        error: "F011 gesture/device flagged twice — cool IP/profile before retry",
        verifyCode: "F011",
      };
    }

    if (attempt > 1) {
      // Longer cool after F011; never quick-spam refresh
      const cool =
        lastCode === "F011" || lastCode === "F024"
          ? rand(1800, 2800)
          : lastCode === "F015"
            ? rand(700, 1100)
            : lastCode === "AMBIGUOUS"
              ? rand(350, 550)
              : rand(500, 800);
      slog(`[PuzzleSolver] refresh last=${lastCode || "-"} cool=${Math.round(cool)}ms`);
      await sleep(cool);
      await clickRefresh(page);
    }

    const ready = await waitCaptchaStable(page, 30_000);
    if (!ready) {
      return {
        success: false,
        attempts: attempt,
        error: "Captcha not stable (images/loading)",
      };
    }

    try {
      await sleep(rand(100, 200));

      const bgBuf = await grabPng(page, "#aliyunCaptcha-img");
      const pzBuf = await grabPng(page, "#aliyunCaptcha-puzzle");
      if (!quiet()) {
        try {
          fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(path.join(debugDir, `a${attempt}-bg.png`), bgBuf);
          fs.writeFileSync(path.join(debugDir, `a${attempt}-pz.png`), pzBuf);
        } catch {
          /* ignore */
        }
      }

      const match = await templateMatch(bgBuf, pzBuf);
      const geo = await readOffsets(page);
      const displayW = geo.imgBoxW > 0 ? geo.imgBoxW : geo.bgDisplayW;
      const scaleX = geo.bgNaturalW > 0 ? displayW / geo.bgNaturalW : 1;
      // bias 0: open-loop seats 1:1; +1 was pushing residual off the hole
      const targetBias = Number(process.env.SOLVER_TARGET_BIAS ?? "0");

      const quality = match.quality || {
        ambiguous: false,
        reasons: [] as string[],
      };

      slog(
        `[PuzzleSolver] x=${match.x} conf=${Number(match.confidence).toFixed(2)} ${match.method} amb=${!!quality.ambiguous} edge=${match.edgeX} contour=${match.contourX} gap=${match.gapX} bright=${match.brightX}`,
      );
      slog(
        `[PuzzleSolver] geo naturalW=${geo.bgNaturalW} displayW=${displayW.toFixed(1)} scaleX=${scaleX.toFixed(4)} trackW=${geo.trackW.toFixed(1)} sliderW=${geo.sliderW.toFixed(1)}`,
      );

      // Structural methods agreeing → drag even if quality flags soft ambiguity
      const structAgree =
        Number.isFinite(match.edgeX) &&
        Number.isFinite(match.contourX) &&
        Math.abs(match.edgeX - match.contourX) <= 14;

      // Hard split only when NOTHING agrees — edge+bright or edge+gap is enough to drag
      const edgeBrightOk =
        Number.isFinite(match.edgeX) &&
        Number.isFinite(match.brightX) &&
        Math.abs(match.edgeX - match.brightX) <= 16;
      const edgeGapOk =
        Number.isFinite(match.edgeX) &&
        Number.isFinite(match.gapX) &&
        Math.abs(match.edgeX - match.gapX) <= 16;
      const hardSplit =
        Number.isFinite(match.edgeX) &&
        Number.isFinite(match.contourX) &&
        Math.abs(match.edgeX - match.contourX) > 28 &&
        !edgeBrightOk &&
        !edgeGapOk &&
        !(
          Number.isFinite(match.brightX) &&
          Number.isFinite(match.gapX) &&
          Math.abs(match.brightX - match.gapX) <= 14 &&
          Math.abs(match.x - (match.brightX + match.gapX) / 2) <= 12
        );

      // At most ONE skip — with max 3 tries, 2 skips = almost never drag.
      const canSkip = attempt < maxAttempts && ambiguousSkips < 1;

      if (hardSplit && canSkip) {
        swarn("[PuzzleSolver] skip hard edge/contour split");
        lastCode = "AMBIGUOUS";
        ambiguousSkips++;
        continue;
      }

      if (quality.ambiguous && canSkip && !structAgree) {
        const nearCount = [
          match.edgeX,
          match.contourX,
          match.gapX,
          match.brightX,
        ].filter(
          (x: number) => Number.isFinite(x) && Math.abs(x - match.x) <= 12,
        ).length;
        if (!(match.confidence >= 0.75 && nearCount >= 2)) {
          swarn("[PuzzleSolver] skip ambiguous");
          lastCode = "AMBIGUOUS";
          ambiguousSkips++;
          continue;
        }
      }

      if ((hardSplit || quality.ambiguous) && !canSkip) {
        slog(
          `[PuzzleSolver] force-drag last/near-last attempt despite amb (via=${match.method})`,
        );
      }

      const picked = pickCandidateTarget(
        match,
        scaleX,
        targetBias,
        geometryFailStreak,
      );

      const maxTravel =
        geo.trackW > 0
          ? Math.max(40, geo.trackW - geo.sliderW - 2)
          : Math.max(40, geo.bgDisplayW - 10);

      const pieceW =
        Number(match.pieceBounds?.width) > 0
          ? Number(match.pieceBounds.width)
          : 52;

      // Fresh puzzle every attempt — no residual from previous challenge
      const { travel, target } = computeTravel(picked.displayX, maxTravel, {
        displayW,
        trackW: geo.trackW,
        sliderW: geo.sliderW,
        pieceW,
      });

      slog(
        `[PuzzleSolver] aim natural=${picked.naturalX} display=${picked.displayX} target=${target} travel=${travel} (Δ${travel - target >= 0 ? "+" : ""}${travel - target}) pieceW=${pieceW} max=${maxTravel} via=${picked.label}`,
      );

      if (target < 20) {
        swarn("[PuzzleSolver] target too left");
        lastCode = "VISION";
        continue;
      }

      await dragPurpleArrowAligned(page, travel, target);
      await sleep(rand(320, 520));

      for (let w = 0; w < 18; w++) {
        if (verify.isOk()) {
          slog(`[PuzzleSolver] T001 ok attempts=${attempt}`);
          return {
            success: true,
            attempts: attempt,
            targetX: match.x,
            travelX: travel,
            confidence: match.confidence,
            method: `vision+drag+${picked.label}`,
            verifyCode: "T001",
          };
        }
        const code = verify.code();
        if (code && code !== "T001") {
          slog(`[PuzzleSolver] ${code}`);
          lastCode = code;
          if (code === "F008") f008Count++;
          if (code === "F015") geometryFailStreak++;
          if (code === "F011" || code === "F024") {
            f011Count++;
            swarn(
              `[PuzzleSolver] ${code} gesture rejected (${f011Count}/2) — CDP retry once max, no micro-correct`,
            );
          }
          break;
        }
        const gone = await evalStr<boolean>(
          page,
          `() => {
            var b = document.getElementById("waf_nc_block");
            if (b && getComputedStyle(b).display === "none") return true;
            var t = String((document.getElementById("aliyunCaptcha-sliding-text") || {}).textContent || "").toLowerCase();
            return /success|verified|pass|sucesso|verificado/.test(t);
          }`,
        );
        if (gone) {
          return {
            success: true,
            attempts: attempt,
            targetX: match.x,
            travelX: travel,
            confidence: match.confidence,
            method: "ui-dismiss",
          };
        }
        await sleep(150);
      }

      await sleep(lastCode === "F008" ? cooldownAfterF008Ms : cooldownDefaultMs);
    } catch (err) {
      swarn(
        `[PuzzleSolver] attempt ${attempt}:`,
        err instanceof Error ? err.message : err,
      );
      lastCode = "ERR";
      await sleep(500);
    }
  }

  return {
    success: false,
    attempts: maxAttempts,
    error: `Failed after ${maxAttempts} attempts (last=${lastCode || "none"})`,
    verifyCode: lastCode || undefined,
  };
}
