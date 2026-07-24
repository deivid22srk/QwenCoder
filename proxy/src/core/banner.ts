import {
  clearTerminal,
  isColorEnabled,
  PURPLE,
  PURPLE_BRIGHT,
  PURPLE_DIM,
  PURPLE_LIGHT,
  PURPLE_MUTED,
  RESET,
  DIM,
  BOLD,
} from "./ansi.ts";

/**
 * QWEN PROXY startup ASCII.
 * Printed in purple after a full terminal clear.
 */
const ASCII_ART = String.raw`
   ▄▄▄▄      ▄▄▄             ▄▄▄▄▄▄▄   ▄▄     ▄▄▄     ▄▄▄▄▄▄     ▄▄▄▄▄▄      ▄▄▄▄      ▄▄▄   ▄▄▄   ▄▄▄     
 ▄█▀▀███▄▄  █▀██  ██  ██▀▀  █▀██▀▀▀    ██▄   ██▀     █▀██▀▀▀█▄  █▀██▀▀▀█▄  ▄█▀▀████▄  █▀▀██ ██▀   █▀██  ██ 
 ██    ██     ██  ██  ██      ██       ███▄  ██        ██▄▄▄█▀    ██▄▄▄█▀  ██    ██      ▀█▄█▀      ██  ██ 
 ██    ██     ██  ██  ██      ████     ██ ▀█▄██        ██▀▀▀      ██▀▀█▄   ██    ██       ███       ██  ██ 
 ██  ▄ ██     ██▄ ██▄ ██      ██       ██   ▀██      ▄ ██       ▄ ██  ██   ██    ██     ▄█▀██▄      ██  ██ 
  ▀█████▄     ▀████▀███▀      ▀█████ ▀██▀    ██      ▀██▀       ▀██▀  ▀██▀  ▀████▀    ▀██▀  ▀██▄    ▀█████▄
       ▀█                                                                                           ▄   ██ 
                                                                                                    ▀████▀ 
`.replace(/^\n/, "").replace(/\n$/, "");

const CREDIT_LINES = [
  "____________ Made by Farlabs Server ______________",
  "          https://discord.gg/CQgc75VU8r",
  "__________________________________________________",
];

const META = "QwenBridge · local OpenAI-compatible proxy · Windows & Linux";

function artWidth(art: string): number {
  return art.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

/** Center a plain text line inside `width` columns. */
function centerLine(text: string, width: number): string {
  const len = text.length;
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + text;
}

function colorizeArt(art: string): string {
  if (!isColorEnabled) return art;
  return art
    .split("\n")
    .map((line, i) => {
      const c = i % 2 === 0 ? PURPLE_BRIGHT : PURPLE;
      return `${c}${line}${RESET}`;
    })
    .join("\n");
}

function colorizeCenteredCredit(lines: string[], width: number): string {
  return lines
    .map((line, i) => {
      const centered = centerLine(line, width);
      if (i === 1) {
        // Discord link — brighter, centered under the logo
        return isColorEnabled
          ? `${BOLD}${PURPLE_LIGHT}${centered}${RESET}`
          : centered;
      }
      return isColorEnabled ? `${PURPLE_DIM}${centered}${RESET}` : centered;
    })
    .join("\n");
}

/**
 * Clear the whole terminal, then print purple ASCII + centered Farlabs credit.
 * Safe on Windows + Linux (ANSI / VT).
 */
export function clearAndPrintBanner(): void {
  clearTerminal();

  const width = artWidth(ASCII_ART);
  const art = colorizeArt(ASCII_ART);
  const credit = colorizeCenteredCredit(CREDIT_LINES, width);
  const metaLine = centerLine(META, width);
  const meta = isColorEnabled
    ? `${DIM}${PURPLE_MUTED}${metaLine}${RESET}`
    : metaLine;

  process.stdout.write(`\n${art}\n\n${credit}\n${meta}\n\n`);
}
