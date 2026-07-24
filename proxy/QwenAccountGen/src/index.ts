/**
 * QwenAccountGen - Anti-bot captcha evasion system
 *
 * Main entry point - exports public API
 */

export * from "./types.js";
export * from "./fingerprint.js";
export * from "./browser-manager.js";
export { getStealthScript } from "./stealth.js";
export { subtlePageActivity, sleep, humanDelay } from "./human-behavior.js";
export {
  registerViaApi,
  registerViaUi,
  autoRegister,
  generateUsername,
  generateTempEmail,
  generatePassword,
  type RegisterCredentials,
  type RegisterResult,
} from "./register.js";
