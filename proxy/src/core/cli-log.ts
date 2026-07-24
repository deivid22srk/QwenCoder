/**
 * Colored CLI logs — purple-only palette, fixed-width tags, aligned columns.
 *
 * Format (everyone same size):
 *   > SERVER     > message
 *   > PLAYWRIGHT > message
 *   > SESSION    > message
 *
 * No double badges (OK + SERVER). Status is badge tint only.
 * Works on Windows + Linux via ANSI.
 */

import {
  isColorEnabled,
  RESET,
  BOLD,
  FG,
  BG,
  PURPLE,
  PURPLE_BRIGHT,
  PURPLE_LIGHT,
  PURPLE_SOFT,
  PURPLE_DIM,
  PURPLE_DEEP,
  PURPLE_VIVID,
  PURPLE_MUTED,
} from "./ansi.ts";

export type LogKind = "boot" | "mini" | "info" | "ok" | "warn" | "error" | "debug";

/** Fixed columns so every line lines up. */
const TAG_WIDTH = 10;

/** Short display names so nothing truncates ugly (SESSIONKEEPE…). */
const TAG_ALIAS: Record<string, string> = {
  server: "SERVER",
  playwright: "PLAYWRIGHT",
  sessionkeeper: "SESSION",
  qwenbridge: "BRIDGE",
  qwen: "QWEN",
  chat: "CHAT",
  responses: "RESPONSES",
  upstream: "UPSTREAM",
  logger: "LOGGER",
  watchdog: "WATCHDOG",
  cache: "CACHE",
  database: "DATABASE",
  db: "DB",
  auth: "AUTH",
  boot: "BOOT",
  startup: "STARTUP",
  stream: "STREAM",
  token: "TOKEN",
  threadcontext: "THREAD",
  stop: "STOP",
  anthropic: "ANTHROPIC",
  images: "IMAGES",
  upload: "UPLOAD",
  metrics: "METRICS",
  app: "APP",
};

/** Tags treated as bootstrap / lifecycle (badge style). */
const BOOT_TAGS = new Set([
  "server",
  "playwright",
  "sessionkeeper",
  "logger",
  "qwenbridge",
  "watchdog",
  "cache",
  "database",
  "db",
  "auth",
  "boot",
  "startup",
]);

/** Tags treated as high-frequency traffic (mini style). */
const MINI_TAGS = new Set([
  "chat",
  "responses",
  "upstream",
  "stream",
  "token",
  "threadcontext",
  "stop",
  "anthropic",
  "images",
  "upload",
  "metrics",
]);

/**
 * Per-tag purple tones only.
 * Badge label text is always white.
 */
const TAG_COLORS: Record<string, { bg: string; mini: string }> = {
  server: { bg: BG.purple, mini: PURPLE_BRIGHT },
  playwright: { bg: BG.purpleLight, mini: PURPLE_LIGHT },
  sessionkeeper: { bg: BG.purpleMid, mini: PURPLE_SOFT },
  qwen: { bg: BG.purpleVivid, mini: PURPLE_VIVID },
  chat: { bg: BG.darkPurple, mini: PURPLE_MUTED },
  responses: { bg: BG.darkPurple, mini: PURPLE_BRIGHT },
  upstream: { bg: BG.purpleMuted, mini: PURPLE_DIM },
  logger: { bg: BG.purpleSoft, mini: PURPLE_SOFT },
  stop: { bg: BG.purplePale, mini: PURPLE },
  error: { bg: BG.purpleDeep, mini: PURPLE_DEEP },
  warn: { bg: BG.purpleLight, mini: PURPLE_LIGHT },
  default: { bg: BG.purpleMuted, mini: PURPLE_MUTED },
};

function normalizeTag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function displayTag(tag: string): string {
  const key = normalizeTag(tag);
  const alias = TAG_ALIAS[key];
  if (alias) return alias.slice(0, TAG_WIDTH).padEnd(TAG_WIDTH);
  return tag
    .toUpperCase()
    .replace(/\s+/g, "")
    .slice(0, TAG_WIDTH)
    .padEnd(TAG_WIDTH);
}

function paletteFor(tag: string) {
  const key = normalizeTag(tag);
  return TAG_COLORS[key] || TAG_COLORS.default;
}

function decideStyle(tag: string, kind?: LogKind): "boot" | "mini" {
  if (kind === "boot" || kind === "ok" || kind === "warn" || kind === "error") {
    return "boot";
  }
  if (kind === "mini" || kind === "debug") return "mini";
  const key = normalizeTag(tag);
  if (BOOT_TAGS.has(key)) return "boot";
  if (MINI_TAGS.has(key)) return "mini";
  if (tag.length <= 14 && !/[|]/.test(tag)) return "boot";
  return "mini";
}

/** Badge bg may shift by kind (still purple), same exact width always. */
function badgeBg(tag: string, kind: LogKind): string {
  if (kind === "ok") return BG.purpleSoft;
  if (kind === "warn") return BG.purpleLight;
  if (kind === "error") return BG.purpleDeep;
  return paletteFor(tag).bg;
}

/**
 * Fixed-width tag badge. Always TAG_WIDTH + 2 spaces of padding.
 * Same visual box for SERVER, PLAYWRIGHT, SESSION, QWEN, …
 */
function badge(tag: string, kind: LogKind = "info"): string {
  const label = displayTag(tag);
  if (!isColorEnabled) return `[${label.trim()}]`.padEnd(TAG_WIDTH + 2);
  const bg = badgeBg(tag, kind);
  return `${bg}${BOLD}${FG.brightWhite} ${label} ${RESET}`;
}

function arrow(): string {
  if (!isColorEnabled) return ">";
  return `${PURPLE_BRIGHT}${BOLD}>${RESET}`;
}

/**
 * Format a tagged log line — single column, no OK+SERVER double badge.
 *
 *   > SERVER     > message
 *   > PLAYWRIGHT > message
 */
export function formatCliLine(
  tag: string,
  message: string,
  kind: LogKind = "info",
): string {
  const style = decideStyle(tag, kind);
  // > TAG > message  (no underscores)
  const head = `${arrow()} ${badge(tag, kind)} ${arrow()} `;

  // Status = badge tint only (no extra "OK" column that breaks alignment)
  const bodyColor =
    style === "mini" && kind !== "ok" && kind !== "warn" && kind !== "error"
      ? FG.white
      : FG.brightWhite;
  const body = isColorEnabled ? `${bodyColor}${message}${RESET}` : message;

  return `${head}${body}`;
}

/**
 * Parse common patterns:
 *   "[Server] message"
 *   plain text
 */
export function restyleConsoleArgs(
  args: unknown[],
  fallbackKind: LogKind = "info",
): unknown[] {
  if (args.length === 0) return args;
  const first = args[0];
  if (typeof first !== "string") return args;

  // Only restyle tagged bridge logs (never Node/system noise)
  const m = first.match(/^\[([A-Za-z][A-Za-z0-9 _.-]{0,24})\]\s*(.*)$/s);
  if (!m) {
    return args;
  }

  const tag = m[1];
  const rest = m[2] || "";
  const extras = args.slice(1);
  let message = rest;
  if (extras.length === 1 && typeof extras[0] === "string") {
    message = rest ? `${rest} ${extras[0]}` : extras[0];
    return [formatCliLine(tag, message, fallbackKind)];
  }
  if (extras.length === 0) {
    return [formatCliLine(tag, message || "—", fallbackKind)];
  }
  return [formatCliLine(tag, message || "—", fallbackKind), ...extras];
}

export function cliLog(
  tag: string,
  message: string,
  kind: LogKind = "info",
): void {
  const line = formatCliLine(tag, message, kind);
  if (kind === "error") console.error(line);
  else if (kind === "warn") console.warn(line);
  else console.log(line);
}

export const cli = {
  boot: (tag: string, message: string) => cliLog(tag, message, "boot"),
  mini: (tag: string, message: string) => cliLog(tag, message, "mini"),
  info: (tag: string, message: string) => cliLog(tag, message, "info"),
  ok: (tag: string, message: string) => cliLog(tag, message, "ok"),
  warn: (tag: string, message: string) => cliLog(tag, message, "warn"),
  error: (tag: string, message: string) => cliLog(tag, message, "error"),
  debug: (tag: string, message: string) => cliLog(tag, message, "debug"),
};

let patched = false;

/**
 * Patch console.log / warn / error so existing `[Tag] msg` lines
 * get the aligned `> TAG > msg` style.
 */
export function installColoredConsole(): void {
  if (patched) return;
  patched = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...restyleConsoleArgs(args, "info"));
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...restyleConsoleArgs(args, "warn"));
  };
  console.error = (...args: unknown[]) => {
    origError(...restyleConsoleArgs(args, "error"));
  };

  (console as any).__qwenbridge_orig = {
    log: origLog,
    warn: origWarn,
    error: origError,
  };
}
