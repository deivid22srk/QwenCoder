import "dotenv/config";
import { clearAndPrintBanner } from "./core/banner.ts";
import { installColoredConsole } from "./core/cli-log.ts";
import { cli } from "./core/cli-log.ts";

// Full clear + purple ASCII + Farlabs credit (Windows + Linux)
clearAndPrintBanner();

// Colorize all subsequent [Tag] console logs (boot badges + mini traffic)
installColoredConsole();

// Dynamic import so banner paints before any module-level console noise
const { startServer } = await import("./api/server.js");

startServer().catch((error) => {
  cli.error("Server", `Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
