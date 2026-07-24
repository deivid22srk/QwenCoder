import "dotenv/config";
import { formatCliLine, type LogKind } from "./cli-log.ts";
import { isColorEnabled, DIM, RESET, PURPLE_MUTED } from "./ansi.ts";

/**
 * Mask an email address for safe logging.
 * "user@example.com" → "user@***"
 */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return "<unknown>";
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "<invalid>";
  return email.substring(0, atIndex);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * TOOLCALL_DEBUG levels:
 *   "0" or undefined = disabled
 *   "1" = full debug (all toolcall logs)
 *   "errors" = only on errors (log toolcall details when parser/execution fails)
 *
 * UPSTREAM_DEBUG:
 *   "true" = log raw SSE chunks received from Qwen
 */
export type ToolcallDebugLevel = "0" | "1" | "errors";

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
}

function levelToKind(level: LogLevel): LogKind {
  switch (level) {
    case "error":
      return "error";
    case "warn":
      return "warn";
    case "debug":
      return "debug";
    default:
      return "info";
  }
}

export class Logger {
  private minLevel: LogLevel;
  private context?: string;

  constructor(level: LogLevel = "info", context?: string) {
    this.minLevel = level;
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatEntry(entry: LogEntry): string {
    const tag = entry.context || "App";
    const kind = levelToKind(entry.level);
    // Mini for debug noise; boot badges for warn/error; info uses tag heuristic
    const styleKind: LogKind =
      entry.level === "debug"
        ? "mini"
        : entry.level === "info"
          ? "info"
          : kind;

    let line = formatCliLine(tag, entry.message, styleKind);

    if (entry.data) {
      const dataStr = JSON.stringify(entry.data, null, 2);
      const dataBlock = isColorEnabled
        ? `${DIM}${PURPLE_MUTED}${dataStr}${RESET}`
        : dataStr;
      line += `\n${dataBlock}`;
    }

    return line;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "debug",
          message,
          context: this.context,
          data,
        }),
      );
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "info",
          message,
          context: this.context,
          data,
        }),
      );
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      console.warn(
        this.formatEntry({
          timestamp: new Date(),
          level: "warn",
          message,
          context: this.context,
          data,
        }),
      );
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      console.error(
        this.formatEntry({
          timestamp: new Date(),
          level: "error",
          message,
          context: this.context,
          data,
        }),
      );
    }
  }
}

// Determine initial log level from environment
const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
const toolcallDebugEnv = process.env.TOOLCALL_DEBUG || "errors";

export const toolcallDebugLevel: ToolcallDebugLevel =
  toolcallDebugEnv === "1"
    ? "1"
    : toolcallDebugEnv === "errors"
      ? "errors"
      : "0";

const initialLevel: LogLevel =
  toolcallDebugLevel === "1"
    ? "debug"
    : envLevel && ["debug", "info", "warn", "error"].includes(envLevel)
      ? envLevel
      : "info";

export const logger = new Logger(initialLevel);

// Helper to check if toolcall debug is enabled
export function isToolcallDebugEnabled(): boolean {
  return toolcallDebugLevel === "1";
}

export function isToolcallErrorDebugEnabled(): boolean {
  return toolcallDebugLevel === "1" || toolcallDebugLevel === "errors";
}

export const upstreamDebugEnabled = process.env.UPSTREAM_DEBUG === "true";

// Confirm debug mode on startup (only log if explicitly set)
// These run at import time — index installs color patch first via dynamic import of server
if (process.env.TOOLCALL_DEBUG) {
  if (toolcallDebugLevel === "1") {
    console.log("[Logger] TOOLCALL_DEBUG=1 - full debug logs active");
  } else if (toolcallDebugLevel === "errors") {
    console.log(
      "[Logger] TOOLCALL_DEBUG=errors - toolcall logs on errors only",
    );
  } else {
    console.log("[Logger] TOOLCALL_DEBUG=0 - toolcall logs disabled");
  }
}

if (upstreamDebugEnabled) {
  console.log(
    "[Logger] UPSTREAM_DEBUG=true - raw upstream chunks logging active",
  );
}

// Re-export cli helpers for convenience
export { cli, installColoredConsole, formatCliLine } from "./cli-log.ts";
