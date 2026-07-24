/**
 * Cross-platform terminal helpers (Windows + Linux/macOS).
 * Uses ANSI when the stream is a TTY; respects NO_COLOR / FORCE_COLOR.
 */

export const isColorEnabled =
  process.env.FORCE_COLOR === "1" ||
  process.env.FORCE_COLOR === "true" ||
  (process.env.NO_COLOR === undefined &&
    process.env.FORCE_COLOR !== "0" &&
    !!process.stdout.isTTY);

/** Truecolor purple scale (Farlabs) — only purple tones in the CLI. */
export const PURPLE = isColorEnabled ? "\x1b[38;2;168;85;247m" : "";
export const PURPLE_BRIGHT = isColorEnabled ? "\x1b[38;2;192;132;252m" : "";
export const PURPLE_LIGHT = isColorEnabled ? "\x1b[38;2;216;180;254m" : "";
export const PURPLE_SOFT = isColorEnabled ? "\x1b[38;2;196;160;255m" : "";
export const PURPLE_DIM = isColorEnabled ? "\x1b[38;2;126;34;206m" : "";
export const PURPLE_DEEP = isColorEnabled ? "\x1b[38;2;91;33;182m" : "";
export const PURPLE_VIVID = isColorEnabled ? "\x1b[38;2;147;51;234m" : "";
export const PURPLE_MUTED = isColorEnabled ? "\x1b[38;2;139;92;180m" : "";
export const RESET = isColorEnabled ? "\x1b[0m" : "";
export const BOLD = isColorEnabled ? "\x1b[1m" : "";
export const DIM = isColorEnabled ? "\x1b[2m" : "";
export const ITALIC = isColorEnabled ? "\x1b[3m" : "";

export const FG = {
  black: isColorEnabled ? "\x1b[30m" : "",
  /** Kept for rare system use — prefer purple scale for app logs. */
  red: isColorEnabled ? "\x1b[31m" : "",
  green: isColorEnabled ? "\x1b[32m" : "",
  yellow: isColorEnabled ? "\x1b[33m" : "",
  blue: isColorEnabled ? "\x1b[34m" : "",
  magenta: isColorEnabled ? "\x1b[35m" : "",
  cyan: isColorEnabled ? "\x1b[36m" : "",
  white: isColorEnabled ? "\x1b[37m" : "",
  gray: isColorEnabled ? "\x1b[90m" : "",
  brightWhite: isColorEnabled ? "\x1b[97m" : "",
  /** Purple-only foreground scale */
  purple: PURPLE,
  purpleBright: PURPLE_BRIGHT,
  purpleLight: PURPLE_LIGHT,
  purpleSoft: PURPLE_SOFT,
  purpleDim: PURPLE_DIM,
  purpleDeep: PURPLE_DEEP,
  purpleVivid: PURPLE_VIVID,
  purpleMuted: PURPLE_MUTED,
} as const;

export const BG = {
  red: isColorEnabled ? "\x1b[41m" : "",
  green: isColorEnabled ? "\x1b[42m" : "",
  yellow: isColorEnabled ? "\x1b[43m" : "",
  blue: isColorEnabled ? "\x1b[44m" : "",
  magenta: isColorEnabled ? "\x1b[45m" : "",
  cyan: isColorEnabled ? "\x1b[46m" : "",
  /** Purple-only backgrounds (deep → light) */
  purpleDeep: isColorEnabled ? "\x1b[48;2;59;7;100m" : "",
  purple: isColorEnabled ? "\x1b[48;2;88;28;135m" : "",
  purpleMid: isColorEnabled ? "\x1b[48;2;107;33;168m" : "",
  purpleVivid: isColorEnabled ? "\x1b[48;2;126;34;206m" : "",
  purpleSoft: isColorEnabled ? "\x1b[48;2;147;51;234m" : "",
  purpleLight: isColorEnabled ? "\x1b[48;2;168;85;247m" : "",
  purplePale: isColorEnabled ? "\x1b[48;2;109;40;150m" : "",
  purpleMuted: isColorEnabled ? "\x1b[48;2;76;29;120m" : "",
  gray: isColorEnabled ? "\x1b[100m" : "",
  dark: isColorEnabled ? "\x1b[48;2;24;24;27m" : "",
  darkPurple: isColorEnabled ? "\x1b[48;2;24;16;40m" : "",
} as const;

/**
 * Clear the entire terminal (screen + scrollback when supported).
 * Works on Windows Terminal, modern cmd (VT), PowerShell, Linux, macOS.
 */
export function clearTerminal(): void {
  // Prefer ANSI — works when VT processing is on (Node enables it for TTYs).
  if (process.stdout.isTTY) {
    // 2J = clear screen, 3J = clear scrollback, H = cursor home
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    return;
  }
  // Non-TTY (piped/CI): no-op hard clear
  try {
    console.clear();
  } catch {
    // ignore
  }
}

export function paint(text: string, ...codes: string[]): string {
  if (!isColorEnabled || codes.length === 0) return text;
  return `${codes.join("")}${text}${RESET}`;
}
