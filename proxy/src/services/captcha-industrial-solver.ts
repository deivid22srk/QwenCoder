/*
 * DEPRECATED for Qwen.
 *
 * User law: do NOT use glm5.2proxy / Base/aliyun-captcha-solver CDP stack as Qwen base.
 * Base of truth = Base/AliyunCaptcha.js + Qwen DOM + src/services/qwen-puzzle-solver.ts
 *
 * This module only re-exports the Qwen-native solver so old imports don't break.
 */

import type { Page } from "playwright";
import {
  solveQwenPuzzleOnPage,
  type PuzzleSolveResult,
} from "./qwen-puzzle-solver.ts";

export interface IndustrialSolveResult {
  success: boolean;
  attempts: number;
  method: "qwen-native";
  confidence?: number;
  travelX?: number;
  error?: string;
  verifyCode?: string;
}

/** @deprecated Always use solveQwenPuzzleOnPage directly. */
export async function solveCaptchaIndustrial(
  page: Page,
  options: { cdpPort?: number; maxRetries?: number } = {},
): Promise<IndustrialSolveResult> {
  const fb: PuzzleSolveResult = await solveQwenPuzzleOnPage(page, {
    maxAttempts: options.maxRetries ?? 5,
  });
  return {
    success: fb.success,
    attempts: fb.attempts,
    method: "qwen-native",
    confidence: fb.confidence,
    travelX: fb.travelX,
    error: fb.error,
    verifyCode: fb.verifyCode,
  };
}

/** @deprecated No CDP port needed for Qwen-native path. */
export async function findFreePort(): Promise<number> {
  return 0;
}

/** @deprecated Removed — always fails closed. */
export async function solveViaCdpIndustrial(): Promise<IndustrialSolveResult> {
  return {
    success: false,
    attempts: 0,
    method: "qwen-native",
    error: "CDP industrial/glm path disabled for Qwen. Use solveQwenPuzzleOnPage.",
  };
}
