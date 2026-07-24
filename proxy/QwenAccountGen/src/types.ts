/**
 * Shared types for the anti-bot system
 */

export interface FingerprintProfile {
  accountId: string;
  seed: number;
  userAgent: string;
  appVersion: string;
  chromeMajor: number;
  chromeVersion: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  secChUa: string;
  platform: string;
  platformVersion: string;
  languages: string[];
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  pixelDepth: number;
}

export interface CapturedHeaders {
  cookie: string;
  "bx-ua": string;
  "bx-umidtoken": string;
  "bx-v": string;
  "user-agent": string;
}

export interface AccountConfig {
  id: string;
  email: string;
  password: string;
}

export interface AccountState {
  id: string;
  headers: CapturedHeaders | null;
  lastRefresh: number;
  isRateLimited: boolean;
  rateLimitedUntil: number;
}

export interface AntiBotConfig {
  headerCacheTtlMs: number;
  rateLimitCooldownMs: number;
  headless: boolean;
  profileDir: string;
}
